package app.octo.avdcamera

import android.os.Bundle
import android.widget.CheckBox
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/** Hidden screen: what Camera2 reports, what is selected, and the recent events. */
class DiagnosticsActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_diagnostics)
        title = getString(R.string.diagnostics_title)
        val debug = findViewById<CheckBox>(R.id.debugLogging)
        debug.isChecked = Diagnostics.debugEnabled(this)
        debug.setOnCheckedChangeListener { _, checked -> Diagnostics.setDebug(this, checked) }
        val cameras = CameraCatalog.enumerate(this)
        findViewById<TextView>(R.id.diagnosticsText).text = Diagnostics.report(
            this, cameras, CameraPrefs.saved(this), bound = null,
        )
    }
}
