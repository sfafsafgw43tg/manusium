# Profile and folder storage directories

Each profile normally stores its browser data under the application data folder. The profile editor's **Profile data directory** chooser can instead assign one absolute directory to a profile. The value is persisted with the profile, and the shared `DataLayout` binds all engine paths (Chromium, Firefox, downloads and Electron legacy data) to that directory after loading the profile.

From a folder's overflow menu, **Move folder data…** selects a destination root. Every closed profile in that folder is moved into `<destination>/<profile-id>`. Existing destinations must be empty; running profiles are refused so browser files are not copied while in use.

The manager validates that destinations are absolute, non-root directories and never the application data root. Moves use a rename where possible; when the source and destination are on different volumes (for example `E:` to `O:` on Windows), the manager copies to a same-volume staging directory, publishes it with an atomic rename, then removes the source. Metadata failures attempt rollback using the same cross-volume-safe path. No engine silently falls back to the old path. The profile directory is not a security boundary: OS permissions and full-disk encryption still protect the files, and users should not select a shared or cloud-synchronised directory for sensitive profiles.
