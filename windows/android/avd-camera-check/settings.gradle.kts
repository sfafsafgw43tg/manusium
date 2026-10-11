// Octo AVD camera check: a small CameraX app that proves whether an Android
// Studio AVD exposes the cameras you configured (Webcam0 / Virtual Scene).
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "avd-camera-check"
include(":app")
