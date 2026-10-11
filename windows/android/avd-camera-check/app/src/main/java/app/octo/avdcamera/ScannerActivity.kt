package app.octo.avdcamera

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.FrameLayout
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.camera2.interop.Camera2CameraInfo
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.barcode.BarcodeScanner
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * QR/barcode scanner built on the same CameraX stack as the camera diagnostic.
 * It never stores or uploads scan contents; the last decoded value is shown only
 * in this activity and is cleared when the activity is destroyed.
 */
class ScannerActivity : AppCompatActivity() {
    private lateinit var previewView: PreviewView
    private lateinit var statusView: TextView
    private lateinit var cameraExecutor: ExecutorService
    private lateinit var barcodeScanner: BarcodeScanner
    private var cameraProvider: ProcessCameraProvider? = null
    private val closing = AtomicBoolean(false)
    private val mainHandler = Handler(Looper.getMainLooper())
    private var bindAttempts = 0

    private val requestPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) initCamera() else statusView.text = getString(R.string.scanner_permission_required)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        title = getString(R.string.scanner_title)
        cameraExecutor = Executors.newSingleThreadExecutor()
        barcodeScanner = BarcodeScanning.getClient()
        setContentView(createContent())
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            initCamera()
        } else {
            statusView.text = getString(R.string.scanner_permission_required)
            requestPermission.launch(Manifest.permission.CAMERA)
        }
    }

    private fun createContent(): ViewGroup {
        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        previewView = PreviewView(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
            implementationMode = PreviewView.ImplementationMode.COMPATIBLE
            scaleType = PreviewView.ScaleType.FILL_CENTER
        }
        root.addView(previewView)
        statusView = TextView(this).apply {
            setTextColor(Color.WHITE)
            setBackgroundColor(0xAA000000.toInt())
            setPadding(24, 16, 24, 16)
            text = getString(R.string.scanner_starting)
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.TOP,
            )
        }
        root.addView(statusView)
        val close = Button(this).apply {
            text = getString(R.string.scanner_close)
            setOnClickListener { finish() }
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL,
            ).also { it.bottomMargin = 24 }
        }
        root.addView(close)
        return root
    }

    private fun initCamera() {
        if (isFinishing || isDestroyed) return
        ProcessCameraProvider.getInstance(this).also { future ->
            future.addListener({
                if (isFinishing || isDestroyed) return@addListener
                try {
                    cameraProvider = future.get()
                    bindCamera(cameraProvider!!)
                } catch (error: Exception) {
                    Diagnostics.log("scanner provider failed: ${error.javaClass.simpleName} ${error.message}")
                    statusView.text = getString(R.string.scanner_camera_failed)
                }
            }, ContextCompat.getMainExecutor(this))
        }
    }

    private fun bindCamera(provider: ProcessCameraProvider) {
        provider.unbindAll()
        val rotation = previewView.display?.rotation ?: android.view.Surface.ROTATION_0
        val preview = Preview.Builder()
            .setTargetRotation(rotation)
            .build()
            .also { it.setSurfaceProvider(previewView.surfaceProvider) }
        val analysis = ImageAnalysis.Builder()
            .setTargetRotation(rotation)
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .build()
        analysis.setAnalyzer(cameraExecutor) { imageProxy -> analyze(imageProxy) }
        val selector = selectedCameraSelector(provider)
        try {
            provider.bindToLifecycle(this, selector, preview, analysis)
            bindAttempts = 0
            statusView.text = getString(R.string.scanner_waiting)
        } catch (error: Exception) {
            Diagnostics.log("scanner bind failed: ${error.javaClass.simpleName} ${error.message}")
            analysis.clearAnalyzer()
            statusView.text = getString(R.string.scanner_camera_failed)
            scheduleBindRetry()
        }
    }

    /** Retry only the app-level CameraX bind; never kill system camera services. */
    private fun scheduleBindRetry() {
        if (bindAttempts >= MAX_BIND_ATTEMPTS || closing.get()) return
        val delay = BIND_RETRY_DELAYS_MS[bindAttempts]
        bindAttempts += 1
        mainHandler.postDelayed({
            if (!closing.get()) cameraProvider?.let(::bindCamera)
        }, delay)
    }

    private fun selectedCameraSelector(provider: ProcessCameraProvider): CameraSelector {
        val selected = CameraPrefs.saved(this)
        if (selected != null) {
            val matching = provider.availableCameraInfos.any {
                runCatching { Camera2CameraInfo.from(it).cameraId == selected }.getOrDefault(false)
            }
            if (matching) {
                return CameraSelector.Builder()
                    .addCameraFilter { infos -> infos.filter { Camera2CameraInfo.from(it).cameraId == selected } }
                    .build()
            }
        }
        return CameraSelector.DEFAULT_BACK_CAMERA
    }

    private fun analyze(imageProxy: ImageProxy) {
        if (closing.get()) {
            imageProxy.close()
            return
        }
        val mediaImage = imageProxy.image
        if (mediaImage == null) {
            imageProxy.close()
            return
        }
        val image = InputImage.fromMediaImage(mediaImage, imageProxy.imageInfo.rotationDegrees)
        barcodeScanner.process(image)
            .addOnSuccessListener { barcodes ->
                val first = barcodes.firstOrNull { !it.rawValue.isNullOrBlank() }
                if (first != null && !isFinishing && !isDestroyed) {
                    onScanComplete(first.rawValue.orEmpty())
                }
            }
            .addOnFailureListener { error ->
                Diagnostics.log("scanner frame failed: ${error.javaClass.simpleName}")
            }
            .addOnCompleteListener { imageProxy.close() }
    }

    private fun onScanComplete(payload: String) {
        if (!closing.compareAndSet(false, true)) return
        cameraProvider?.unbindAll()
        setResult(RESULT_OK, intent.putExtra(SCAN_RESULT_EXTRA, payload))
        finish()
    }

    override fun onDestroy() {
        closing.set(true)
        mainHandler.removeCallbacksAndMessages(null)
        cameraProvider?.unbindAll()
        barcodeScanner.close()
        cameraExecutor.shutdown()
        super.onDestroy()
    }

    companion object {
        const val SCAN_RESULT_EXTRA = "scan_result"
        private const val MAX_BIND_ATTEMPTS = 3
        private val BIND_RETRY_DELAYS_MS = longArrayOf(250L, 750L, 1_500L)
    }
}
