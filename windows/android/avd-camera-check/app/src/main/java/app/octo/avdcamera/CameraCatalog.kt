package app.octo.avdcamera

import android.content.Context
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.util.Log

/**
 * One camera the system reports. The id is whatever Camera2 gives us. Nothing
 * here assumes "0" is the back camera or that a front/back pair exists.
 */
data class CameraEntry(
    val id: String,
    val facing: Int?,
    val hardwareLevel: Int?,
    val available: Boolean,
) {
    val label: String
        get() = when (facing) {
            CameraCharacteristics.LENS_FACING_FRONT -> "Front ($id)"
            CameraCharacteristics.LENS_FACING_BACK -> "Back ($id)"
            CameraCharacteristics.LENS_FACING_EXTERNAL -> "External ($id)"
            else -> "Camera $id"
        }
}

/** Camera decisions that need no device, so they can be unit-tested on the JVM. */
object CameraSelection {
    /** Keep the saved camera only while the system still lists it as usable; else the first usable one. */
    fun resolve(saved: String?, cameras: List<CameraEntry>): String? {
        val usable = cameras.filter { it.available }
        if (saved != null && usable.any { it.id == saved }) return saved
        return usable.firstOrNull()?.id
    }

    /** The switch button is shown only with two or more usable cameras. */
    fun canSwitch(cameras: List<CameraEntry>): Boolean = cameras.count { it.available } >= 2

    /** The next usable camera after the current one, wrapping around. */
    fun next(current: String?, cameras: List<CameraEntry>): String? {
        val usable = cameras.filter { it.available }.map { it.id }
        if (usable.isEmpty()) return null
        val index = usable.indexOf(current)
        return usable[(index + 1) % usable.size]
    }
}

/** Camera2 enumeration: the real list the system exposes, in the system's order. */
object CameraCatalog {
    private const val TAG = "AvdCamera"

    fun enumerate(context: Context, unavailable: Set<String> = emptySet()): List<CameraEntry> {
        val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val ids = try {
            manager.cameraIdList.toList()
        } catch (error: Exception) {
            Log.w(TAG, "cameraIdList failed", error)
            emptyList()
        }
        return ids.map { id ->
            val characteristics = try {
                manager.getCameraCharacteristics(id)
            } catch (error: Exception) {
                Log.w(TAG, "characteristics failed for $id", error)
                null
            }
            CameraEntry(
                id = id,
                facing = characteristics?.get(CameraCharacteristics.LENS_FACING),
                hardwareLevel = characteristics?.get(CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL),
                available = id !in unavailable,
            )
        }
    }
}

/** The saved camera. Only the id is stored; it is checked against the system on every start. */
object CameraPrefs {
    private const val FILE = "camera_prefs"
    private const val KEY_SELECTED = "selected_camera_id"

    fun saved(context: Context): String? =
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE).getString(KEY_SELECTED, null)

    fun save(context: Context, id: String?) {
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().putString(KEY_SELECTED, id).apply()
    }
}
