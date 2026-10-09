package app.octo.avdcamera

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.camera2.CameraManager
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.camera2.interop.Camera2CameraInfo
import androidx.camera.core.CameraSelector
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.Observer

/**
 * One preview, one camera. The camera is chosen by its Camera2 id, bound only
 * after the permission is granted, remembered between runs, and marked active
 * only while its preview is really streaming.
 */
class MainActivity : AppCompatActivity() {
    private lateinit var titleView: TextView
    private lateinit var statusText: TextView
    private lateinit var cameraName: TextView
    private lateinit var previewView: PreviewView
    private lateinit var permissionButton: Button
    private lateinit var settingsButton: Button
    private lateinit var switchButton: Button
    private lateinit var cameraManager: CameraManager
    private val mainHandler = Handler(Looper.getMainLooper())

    private val unavailable = HashSet<String>()
    private var cameras: List<CameraEntry> = emptyList()
    private var selectedId: String? = null
    /** The camera whose preview is streaming right now. Only this one counts as active. */
    private var boundId: String? = null
    private var provider: ProcessCameraProvider? = null
    private var permissionRequested = false
    private var titleTaps = 0
    private var lastTapMs = 0L

    private val streamObserver = Observer<PreviewView.StreamState> { state ->
        val id = bindingId ?: return@Observer
        Diagnostics.log("stream $id -> $state")
        boundId = if (state == PreviewView.StreamState.STREAMING) id else null
        if (boundId != null) mainHandler.removeCallbacks(startWatchdog)
        paintStatus()
    }
    private var bindingId: String? = null

    /** If the preview never starts, say so instead of showing a blank panel. */
    private val startWatchdog = Runnable {
        if (boundId == null && bindingId != null) {
            Diagnostics.log("preview did not start for $bindingId")
            statusText.text = getString(R.string.msg_preview_failed)
        }
    }

    private val availability = object : CameraManager.AvailabilityCallback() {
        override fun onCameraAvailable(cameraId: String) {
            unavailable.remove(cameraId)
            Diagnostics.log("available $cameraId")
            refreshCameras(rebind = cameraId == selectedId)
        }

        override fun onCameraUnavailable(cameraId: String) {
            unavailable.add(cameraId)
            Diagnostics.log("unavailable $cameraId")
            refreshCameras(rebind = cameraId == selectedId)
        }
    }

    private val requestPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        Diagnostics.log("permission granted=$granted")
        if (granted) refreshCameras(rebind = true) else showPermissionState()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        Diagnostics.loadDebug(this)
        titleView = findViewById(R.id.title)
        statusText = findViewById(R.id.statusText)
        cameraName = findViewById(R.id.cameraName)
        previewView = findViewById(R.id.previewView)
        permissionButton = findViewById(R.id.permissionButton)
        settingsButton = findViewById(R.id.settingsButton)
        switchButton = findViewById(R.id.switchButton)
        cameraManager = getSystemService(CAMERA_SERVICE) as CameraManager

        titleView.setOnClickListener { onTitleTap() }
        permissionButton.setOnClickListener {
            permissionRequested = true
            requestPermission.launch(Manifest.permission.CAMERA)
        }
        settingsButton.setOnClickListener {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
        }
        switchButton.setOnClickListener { selectCamera(CameraSelection.next(selectedId, cameras)) }
    }

    override fun onStart() {
        super.onStart()
        cameraManager.registerAvailabilityCallback(availability, mainHandler)
        if (hasPermission()) {
            ProcessCameraProvider.getInstance(this).also { future ->
                future.addListener({
                    provider = future.get()
                    refreshCameras(rebind = true)
                }, ContextCompat.getMainExecutor(this))
            }
        } else {
            showPermissionState()
        }
    }

    override fun onStop() {
        cameraManager.unregisterAvailabilityCallback(availability)
        mainHandler.removeCallbacks(startWatchdog)
        provider?.unbindAll()
        boundId = null
        bindingId = null
        super.onStop()
    }

    private fun hasPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED

    /** Re-enumerate from the system, keep a still-usable selection, and rebind if asked. */
    private fun refreshCameras(rebind: Boolean) {
        if (!hasPermission()) {
            showPermissionState()
            return
        }
        cameras = CameraCatalog.enumerate(this, unavailable)
        if (cameras.isEmpty()) {
            showNoCamera()
            return
        }
        val resolved = CameraSelection.resolve(selectedId ?: CameraPrefs.saved(this), cameras)
        if (resolved != selectedId) {
            selectedId = resolved
            CameraPrefs.save(this, resolved)
        }
        switchButton.visibility = if (CameraSelection.canSwitch(cameras)) View.VISIBLE else View.GONE
        permissionButton.visibility = View.GONE
        settingsButton.visibility = View.GONE
        if (rebind) bind() else paintStatus()
    }

    private fun selectCamera(id: String?) {
        selectedId = id
        CameraPrefs.save(this, id)
        bind()
    }

    private fun bind() {
        val currentProvider = provider ?: return
        val id = selectedId
        mainHandler.removeCallbacks(startWatchdog)
        streamedFrom(null)
        currentProvider.unbindAll()
        if (id == null) {
            paintStatus()
            return
        }
        // Binding by Camera2 id: the selector keeps exactly that one camera.
        val selector = CameraSelector.Builder()
            .addCameraFilter { infos -> infos.filter { Camera2CameraInfo.from(it).cameraId == id } }
            .build()
        val preview = Preview.Builder().build().also { it.setSurfaceProvider(previewView.surfaceProvider) }
        previewView.previewStreamState.removeObserver(streamObserver)
        previewView.previewStreamState.observe(this, streamObserver)
        streamedFrom(id)
        try {
            currentProvider.bindToLifecycle(this, selector, preview)
            Diagnostics.log("bound $id")
            mainHandler.postDelayed(startWatchdog, PREVIEW_START_TIMEOUT_MS)
        } catch (error: Exception) {
            Diagnostics.log("bind failed for $id: ${error.javaClass.simpleName} ${error.message}")
            statusText.text = getString(
                if (id in unavailable) R.string.msg_camera_unavailable else R.string.msg_preview_failed,
            )
            boundId = null
        }
        paintStatus()
    }

    private fun streamedFrom(id: String?) {
        bindingId = id
        boundId = null
    }

    private fun showPermissionState() {
        val rationale = ActivityCompat.shouldShowRequestPermissionRationale(this, Manifest.permission.CAMERA)
        // Denied after it was asked, with no rationale left: only the settings page can fix it.
        val permanentlyDenied = permissionRequested && !rationale
        statusText.text = getString(R.string.msg_permission_required) + " " + getString(R.string.rationale)
        cameraName.text = getString(R.string.camera_none_selected)
        permissionButton.visibility = if (permanentlyDenied) View.GONE else View.VISIBLE
        settingsButton.visibility = if (permanentlyDenied) View.VISIBLE else View.GONE
        switchButton.visibility = View.GONE
    }

    private fun showNoCamera() {
        statusText.text = if (Diagnostics.looksLikeEmulator()) {
            getString(R.string.msg_no_camera) + " " + getString(R.string.msg_avd_hint)
        } else {
            getString(R.string.msg_no_camera)
        }
        cameraName.text = getString(R.string.camera_none_selected)
        switchButton.visibility = View.GONE
    }

    private fun paintStatus() {
        val entry = cameras.firstOrNull { it.id == selectedId }
        cameraName.text = when {
            entry == null -> getString(R.string.camera_none_selected)
            boundId == entry.id -> getString(R.string.camera_active, entry.label)
            else -> getString(R.string.camera_selected_not_bound, entry.label)
        }
        if (boundId != null) statusText.text = ""
    }

    /** Three quick taps on the title open the hidden diagnostics screen. */
    private fun onTitleTap() {
        val now = System.currentTimeMillis()
        titleTaps = if (now - lastTapMs < TAP_WINDOW_MS) titleTaps + 1 else 1
        lastTapMs = now
        if (titleTaps >= 3) {
            titleTaps = 0
            startActivity(Intent(this, DiagnosticsActivity::class.java))
        }
    }

    override fun onDestroy() {
        provider?.unbindAll()
        super.onDestroy()
    }

    companion object {
        private const val PREVIEW_START_TIMEOUT_MS = 6_000L
        private const val TAP_WINDOW_MS = 700L
    }
}
