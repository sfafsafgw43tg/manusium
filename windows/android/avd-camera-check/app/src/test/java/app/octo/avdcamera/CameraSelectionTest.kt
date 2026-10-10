package app.octo.avdcamera

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CameraSelectionTest {
    private val back = CameraEntry("7f2", 1, 3, available = true)
    private val front = CameraEntry("webcam1", 0, 2, available = true)
    private val busy = CameraEntry("9", 2, 2, available = false)

    @Test
    fun restoresSavedCameraOnlyWhileItIsStillUsable() {
        assertEquals("webcam1", CameraSelection.resolve("webcam1", listOf(back, front)))
        assertEquals("7f2", CameraSelection.resolve("webcam1", listOf(back)))
        assertEquals("7f2", CameraSelection.resolve("9", listOf(busy, back)))
    }

    @Test
    fun neverInventsACameraWhenTheSystemReportsNone() {
        assertNull(CameraSelection.resolve("0", emptyList()))
        assertNull(CameraSelection.resolve(null, listOf(busy)))
    }

    @Test
    fun switchButtonNeedsTwoUsableCameras() {
        assertFalse(CameraSelection.canSwitch(listOf(back)))
        assertFalse(CameraSelection.canSwitch(listOf(back, busy)))
        assertTrue(CameraSelection.canSwitch(listOf(back, front)))
    }

    @Test
    fun nextCycleWrapsAndSkipsBusyCameras() {
        val list = listOf(back, busy, front)
        assertEquals("webcam1", CameraSelection.next("7f2", list))
        assertEquals("7f2", CameraSelection.next("webcam1", list))
        assertEquals("7f2", CameraSelection.next("unknown", list))
    }

    @Test
    fun labelsUseTheRealIdNotAGuessedPosition() {
        assertEquals("Back (7f2)", back.label)
        assertEquals("Front (webcam1)", front.label)
        assertEquals("Camera 9", CameraEntry("9", null, null, true).label)
    }

    @Test
    fun onlyCameraServiceAndAccessFailuresAreRetried() {
        assertTrue(CameraEnumeration(emptyList(), CameraEnumerationFailure.CAMERA_SERVICE).hasTransientFailure)
        assertTrue(CameraEnumeration(emptyList(), CameraEnumerationFailure.CAMERA_ACCESS).hasTransientFailure)
        assertFalse(CameraEnumeration(emptyList(), CameraEnumerationFailure.EMPTY_HAL).hasTransientFailure)
        assertFalse(CameraEnumeration(emptyList(), CameraEnumerationFailure.PERMISSION).hasTransientFailure)
    }
}
