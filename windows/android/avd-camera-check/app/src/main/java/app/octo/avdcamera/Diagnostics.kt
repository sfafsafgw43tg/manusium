package app.octo.avdcamera

import android.content.Context
import android.os.Build
import android.util.Log

/**
 * Diagnostics for the hidden screen and for debugging. Emulator detection here
 * only changes the wording of a message. It never decides which camera is used.
 */
object Diagnostics {
    private const val TAG = "AvdCamera"
    private const val FILE = "camera_prefs"
    private const val KEY_DEBUG = "debug_logging"
    private const val MAX_LINES = 200

    private val recent = ArrayDeque<String>()
    @Volatile private var debug = false

    fun loadDebug(context: Context) {
        debug = debugEnabled(context)
    }

    fun debugEnabled(context: Context): Boolean =
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE).getBoolean(KEY_DEBUG, false)

    fun setDebug(context: Context, enabled: Boolean) {
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().putBoolean(KEY_DEBUG, enabled).apply()
        debug = enabled
    }

    /** Always kept in memory for the diagnostics screen; written to logcat only in debug mode. */
    fun log(message: String) {
        synchronized(recent) {
            recent.addLast("${System.currentTimeMillis() % 100_000} $message")
            while (recent.size > MAX_LINES) recent.removeFirst()
        }
        if (debug) Log.d(TAG, message)
    }

    fun looksLikeEmulator(): Boolean =
        Build.HARDWARE.contains("ranchu") || Build.HARDWARE.contains("goldfish") ||
            Build.PRODUCT.startsWith("sdk_gphone") || Build.PRODUCT.startsWith("sdk_")

    fun report(context: Context, cameras: List<CameraEntry>, selected: String?, bound: String?): String {
        val lines = mutableListOf(
            "Device: ${Build.MANUFACTURER} ${Build.MODEL} (${Build.DEVICE})",
            "Android: ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})",
            "Hardware: ${Build.HARDWARE}, product: ${Build.PRODUCT}",
            "Looks like an emulator: ${looksLikeEmulator()}",
            "Cameras reported by Camera2: ${cameras.size}",
        )
        cameras.forEach { lines += "  ${it.label}, level ${it.hardwareLevel}, available ${it.available}" }
        lines += "Selected: ${selected ?: "none"}"
        lines += "Bound and streaming: ${bound ?: "none"}"
        lines += "Debug logging: ${debugEnabled(context)}"
        lines += "Recent events:"
        synchronized(recent) { lines += recent.map { "  $it" } }
        return lines.joinToString("\n")
    }
}
