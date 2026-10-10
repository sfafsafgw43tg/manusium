plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "app.octo.avdcamera"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.octo.avdcamera"
        // CameraX supports API 21+; the camera2 interop used here needs 24+ in practice.
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    val cameraX = "1.3.4"
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.camera:camera-core:$cameraX")
    implementation("androidx.camera:camera-camera2:$cameraX")
    implementation("androidx.camera:camera-lifecycle:$cameraX")
    implementation("androidx.camera:camera-view:$cameraX")
    implementation("com.google.mlkit:barcode-scanning:17.2.0")
    implementation("androidx.lifecycle:lifecycle-livedata-core-ktx:2.8.6")
    testImplementation("junit:junit:4.13.2")
}
