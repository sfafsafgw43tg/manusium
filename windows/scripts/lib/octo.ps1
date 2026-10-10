# scripts/lib/octo.ps1
#
# Shared implementation of the OctoSuite maintenance scripts (scripts\*.bat).
# Target: Windows PowerShell 5.1 (built into Windows 10/11) - no PS7 syntax.
# This file is saved as UTF-8 WITH BOM so Polish text is read correctly by PS 5.1.
#
# Commands:
#   open [args]            start Octo.su            (open.bat)
#   open-detect [args]     start OctoDetect.su             (open-detect.bat)
#   install [-Source dir]  verify + run the suite installer, or set up everything
#                          a development checkout needs (install.bat)
#   wizard-run             internal: the work of the graphical installer (octo-ui.ps1);
#                          runs the installation steps and reports them, shows no window
#   setup                  install prerequisites (Node.js/git, Android Studio, Python,
#                          OBS and VB-CABLE via winget) + npm ci + build
#   run [-Update]          start both apps with no console window          (run.bat)
#   update [-CheckOnly]    download, verify, back up, install (update.bat)
#   github-update [-CheckOnly] update straight from GitHub Releases;   (github-update.bat)
#                          in a development checkout: git pull + npm ci + npm run build
#   start-all [-NoUpdate]  update from GitHub, then start both apps    (start-all.bat)
#   repair                 check installation + configuration (repair.bat)
#   uninstall [-DeleteData] run the uninstaller, optionally delete data (uninstall.bat)
#   reset-profile   [-Profile name|id]                     (reset-profile.bat)
#   backup-profile  [-Profile name|id] [-Destination dir]  (backup-profile.bat)
#   restore-profile [-Profile name|id] [-Archive file.zip] (restore-profile.bat)
# Common switches: -Yes (do not ask for confirmation), -Lang en|pl
#
# Security rules implemented here:
#   * paths are always quoted / passed as objects (spaces, Polish characters, '&', '!')
#   * downloads only from the official GitHub Releases URL over HTTPS (TLS 1.2+)
#   * installers are checked with SHA-256 (signed manifest / SHA256SUMS.txt),
#     Authenticode (when signed) and the Ed25519 manifest signature (via the installed
#     app's --verify-manifest mode or Node.js with scripts\lib\update-public-key.pem)
#   * logs contain no passwords, keys or tokens; the user profile path is shortened
#   * nothing is changed while an app is running (profile files are locked)
#   * archives are checked against path traversal ("zip slip") before extraction

[CmdletBinding()]
param(
  [Parameter(Position = 0, Mandatory = $true)][string]$Command,
  [Alias('Profile')][string]$ProfileName,
  [string]$Source,
  [string]$Archive,
  [string]$Destination,
  [ValidateSet('en', 'pl')][string]$Lang,
  [switch]$Yes,
  # install.bat is unattended by default; -Interactive brings the questions back.
  [switch]$Interactive,
  # -NoGui keeps everything in the console (used by CI and by the other scripts).
  [switch]$NoGui,
  [switch]$CheckOnly,
  [switch]$NoBackup,
  [switch]$DeleteData,
  [switch]$NoUpdate,
  [switch]$Update,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest
)

Set-StrictMode -Version 1.0
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem

# ------------------------------------------------------------------ constants
# Keep in sync with packages/core/src/appinfo.ts (OFFICIAL_REPO) - checked by tests.
$OfficialRepo = 'chargehuobey/lvocto'
$OfficialBase = "https://github.com/$OfficialRepo/releases"
$Apps = @{
  octobrowser = @{ Product = 'Octo.su'; Folder = 'OctoBrowser'; Exe = 'Octo.su.exe'; Process = 'Octo.su'; DevDir = 'apps\octobrowser' }
  octodetect  = @{ Product = 'OctoDetect.su';  Folder = 'OctoDetect';  Exe = 'OctoDetect.su.exe';  Process = 'OctoDetect.su';  DevDir = 'apps\octodetect' }
}
$ScriptsDir = Split-Path -Parent $PSScriptRoot
$InstallRoot = Split-Path -Parent $ScriptsDir

# ------------------------------------------------------------------ messages
$Messages = @{
  en = @{
    notInstalled      = '{0} is not installed next to these scripts ({1}).'
    devMode           = 'Development checkout detected - starting with Electron from node_modules.'
    notBuilt          = 'The app has not been built yet. Run "npm run build" first.'
    starting          = 'Starting {0}...'
    running           = '{0} is running. Close it (including all profile windows) and try again.'
    confirm           = 'Continue? [y/N]'
    cancelled         = 'Cancelled.'
    done              = 'Done.'
    noBootstrap       = '{0} has not been set up yet (first run not completed).'
    noInstaller       = 'No OctoSuite-Setup-*.exe found in: {0}'
    usingInstaller    = 'Installer: {0}'
    shaOk             = 'SHA-256 OK ({0})'
    shaBad            = 'SHA-256 MISMATCH - the file is damaged or was modified. Aborting.'
    shaMissing        = 'No SHA256SUMS.txt next to the installer - hash will be checked against the signed manifest only.'
    authOk            = 'Authenticode signature valid: {0}'
    authNone          = 'The installer is not code-signed (Authenticode). Relying on SHA-256 + Ed25519 manifest signature.'
    authBad           = 'Authenticode signature INVALID ({0}). Aborting.'
    sigOk             = 'Update manifest signature (Ed25519) valid - version {0}.'
    sigBad            = 'Update manifest verification FAILED (code {0}): {1}'
    sigNotConfigured  = 'This build has no update signing key - signed updates are not available.'
    sigUnavailable    = 'The Ed25519 manifest signature cannot be verified here (no installed app and no Node.js).'
    sigUnavailableAsk = 'Only SHA-256 and Authenticode were checked. Type YES to install anyway'
    noManifest        = 'latest.json / latest.json.sig not found next to the installer.'
    runInstaller      = 'Running the installer...'
    installerFailed   = 'The installer ended with code {0}.'
    sigRequired       = 'Stopped: the update signature could not be verified, so nothing was installed.'
    checking          = 'Checking for updates (official source: {0})...'
    upToDate          = 'Installed version {0} is up to date (latest: {1}).'
    updateAvailable   = 'Update available: {0} -> {1} ({2}).'
    downloading       = 'Downloading {0}...'
    urlNotOfficial    = 'Refusing a download URL outside the official releases: {0}'
    backupConfig      = 'Backing up configuration to {0}'
    keptForRollback   = 'Installer kept for rollback in {0}'
    repairStart       = 'Checking OctoSuite installation and configuration...'
    fileMissing       = 'Missing: {0}'
    filesOk           = '{0}: program files present.'
    reinstallOffer    = 'Program files are damaged. Reinstall from the newest verified installer? [y/N]'
    bootstrapBroken   = '{0}: bootstrap.json is damaged - it was renamed; the first-run wizard will reuse your data folder.'
    bootstrapOk       = '{0}: bootstrap.json OK (data: {1})'
    dataDirMissing    = '{0}: data folder does not exist: {1}'
    configOk          = '{0}: {1} OK'
    configBroken      = '{0}: {1} is damaged.'
    configRestored    = '{0}: {1} restored from backup {2}'
    configNoBackup    = '{0}: {1} - no valid backup found; the app will start with defaults.'
    tempCleared       = '{0}: temporary files removed ({1}).'
    repairSummary     = 'Repair finished: {0} problem(s) fixed, {1} remaining.'
    uninstallerMissing = 'Uninstaller not found ({0}). If you used the portable version, delete its folder manually.'
    deleteDataAsk     = 'Also DELETE all profiles, settings, reports and logs in {0}? This cannot be undone. Type DELETE to confirm'
    dataDeleted       = 'Data folder deleted: {0}'
    dataKept          = 'Your data was kept in: {0}'
    profiles          = 'Profiles:'
    profileNotFound   = 'Profile not found: {0}'
    chooseProfile     = 'Enter the profile name or number'
    resetAsk          = 'Reset profile "{0}"? Cookies, site data, history and the session are removed; settings and bookmarks are kept.'
    resetDone         = 'Profile "{0}" was reset.'
    backupUnencrypted = 'Warning: profile "{0}" is NOT encrypted - the backup contains readable cookies/logins. Store it safely.'
    backupDone        = 'Backup created: {0}'
    noArchives        = 'No backups found for profile "{0}" in {1}'
    restoreAsk        = 'Restore "{0}" from {1}? The current data is backed up first.'
    restoreDone       = 'Profile "{0}" restored.'
    zipSlip           = 'The archive contains an unsafe path ({0}). Aborting.'
    archiveHashBad    = 'The archive checksum does not match ({0}). Aborting.'
    archiveNoHash     = 'No checksum file for this archive - integrity cannot be confirmed.'
    restoreNoEntry    = 'Profile "{0}" was missing from the profile list. It will be added back automatically the next time Octo.su starts.'
    unknownCommand    = 'Unknown command: {0}'
    error             = 'Error: {0}'
    ghChecking        = 'Checking GitHub releases ({0})...'
    ghNoRelease       = 'No published release found in the official repository yet.'
    ghLatest          = 'Latest release on GitHub: {0} (published {1}).'
    ghNoAsset         = 'The release has no OctoSuite-Setup-*.exe asset for Windows x64.'
    ghUnverifiedAsk   = 'This release has no signed manifest (latest.json + latest.json.sig). Type YES to install anyway'
    ghDevDetected     = 'Development checkout detected ({0}) - updating sources from GitHub instead of installing a release.'
    ghGitMissing      = 'git was not found in PATH - a development checkout cannot be updated.'
    ghGitDirty        = 'The checkout has local changes. Commit or stash them first.'
    ghGitUpToDate     = 'Sources are already up to date ({0}).'
    ghGitPulled       = 'Sources updated: {0} -> {1}'
    depsChecking      = 'Checking project dependencies...'
    depsNodeMissing   = 'Node.js was not found in PATH (Node.js >= 22.12 is required).'
    depsFailed        = 'Installing project dependencies failed (exit code {0}). Read the messages above, then open the app again.'
    ghBuilding        = 'Building both apps (npm run build)...'
    ghDevDone         = 'Development checkout updated and rebuilt.'
    ghNpmMissing      = 'npm was not found in PATH (Node.js >= 22.12 is required).'
    ghNpmFailed       = 'npm {0} ended with code {1}.'
    startAll          = 'Starting both applications...'
    updateSkipped     = 'Update check skipped (-NoUpdate).'
    updateFailed      = 'Update check failed ({0}) - starting the installed version.'
    prereqCheck       = 'Checking what is needed to run OctoSuite...'
    prereqOk          = '{0} found: {1}'
    prereqMissing     = '{0} is missing or too old (required: {1}).'
    prereqInstall     = 'Installing {0} with winget...'
    prereqNoWinget    = 'winget (App Installer) is not available. Install {0} {1} manually from {2} and run this script again.'
    prereqFailed      = 'Automatic installation of {0} failed (code {1}). Install it manually from {2}.'
    prereqAsk         = 'Install the missing components automatically with winget?'
    prereqRestart     = '{0} was installed but is not visible in this console yet. Close this window, open a new one and run the script again.'
    setupDone         = 'Everything is ready. Start the apps with run.bat (or start-all.bat).'
    setupBuilt        = 'Applications built: apps\octobrowser\dist, apps\octodetect\dist'
    runHidden         = 'Starting without a console window...'
    noSources         = 'No installer and no OctoSuite sources here ({0}). Unpack the whole repository (with package.json, apps\ and tools\) or put OctoSuite-Setup-*.exe next to the scripts.'
    installFromSources = 'No release installer found - setting up the source copy in {0}.'
    ghNoGitDir        = 'These sources are not a git clone (no .git folder), so they cannot be fast-forwarded. Only the build is refreshed. Use "git clone" to get updates from GitHub.'
    runSetupVisible   = 'Something is still missing - the setup will run in a visible window first.'
    prereqOpenSite    = 'Open the official download page ({0}) in your browser now?'
    prereqManual      = 'Install {0} and run this script again.'
    androidCheck      = 'Checking the Android tools used by the virtual machines section...'
    androidOk         = '{0} found.'
    androidMissing    = '{0} is missing.'
    androidAsk        = 'Install the missing Android components ({0}) with winget? They are needed by the Android devices section and by the vStudio virtual camera/microphone.'
    androidSkip       = 'Skipping the Android components. The Android section will stay unavailable until they are installed.'
    androidFailed     = '{0} could not be installed automatically (code {1}). Install it manually from {2}.'
    androidDone       = 'Android components are ready. Start Android Studio once so it finishes downloading its SDK.'
    mediaCheck        = 'Checking what the vStudio Mobile and vStudio Web plugins need (Python, OBS virtual camera, VB-CABLE)...'
    stepOf            = 'Step {0} of {1}: {2}'
    stepShortcut      = 'Desktop shortcut for Octo.su'
    shortcutDone      = 'Desktop shortcut created: {0}'
    shortcutFailed    = 'The desktop shortcut could not be created ({0}). Start Octo.su with scripts\open.bat instead.'
    shortcutNoDesktop = 'No Desktop folder was found, so no shortcut was created.'
    stepPrereqs       = 'Node.js and git'
    stepMedia         = 'vStudio plugins (Python, OBS virtual camera, VB-CABLE)'
    stepAndroid       = 'Android Studio and Java 17'
    stepSdk           = 'Android SDK command-line tools, adb and the emulator'
    stepDeps          = 'Project dependencies (npm ci)'
    stepRuntimes      = 'Native Chromium runtime (Firefox skipped for now)'
    stepBuild         = 'Building OctoBrowser and OctoDetect'
    uiTitle              = 'OctoSuite installer'
    uiVersion            = 'Version {0}'
    uiHeading            = 'Install OctoSuite'
    uiIntro              = 'Everything is installed without further questions. You can watch the progress below; the window stays usable while each step runs.'
    uiConfigDesc         = 'Choose your Android SDK location and review optional configuration before installing.'
    uiFolder             = 'Folder for the Android SDK and its system images (optional)'
    uiFolderHint         = 'Packages are installed in this folder. Keep the default unless you need another drive.'
    uiFolderNotWritable  = 'The folder {0} cannot be written. Choose another folder.'
    uiFolderSet          = 'Android packages will be installed in {0}.'
    uiBrowse             = 'Browse...'
    uiOptionalSettings   = 'Optional settings'
    uiProxyServer        = 'Proxy server (optional)'
    uiProxyHint          = 'Used for downloads and package managers during this installation only. Format: host:port.'
    uiProxyBad           = 'Enter the proxy as host:port or http://host:port. User names and passwords are not supported here.'
    uiEnvVars            = 'Use system environment variables (recommended)'
    uiAddPath            = 'Add Android SDK tools to user PATH (recommended)'
    uiVmMode             = 'VirtualBox / VM compatibility mode (software GPU fallback)'
    uiVmTip              = 'Applies only to OctoSuite launches. Does not change global VM settings.'
    uiVmAuto             = 'A virtual machine was detected, so the software GPU fallback stays on automatically.'
    uiAccountHint        = 'Environment variables and PATH entries are stored for your Windows account. No administrator rights are needed.'
    uiTabComponents      = 'What will be installed'
    uiComponentsSubtitle = 'Review all components, requirements, install locations and manual setup guidance.'
    uiStatusCheck        = 'Refresh status'
    uiStatusInstalled    = 'Installed'
    uiStatusMissing      = 'Not installed'
    uiRequired           = 'Required'
    uiOptional           = 'Optional'
    uiLocation           = 'Location'
    compNodeName         = 'Node.js LTS (>= 22.12.0)'
    compNodeDesc         = 'Core JavaScript runtime powering Octo.su, OctoDetect.su and build toolchains.'
    compGitName          = 'Git for Windows (>= 2.40.0)'
    compGitDesc          = 'Version control tool for repository updates and branch management.'
    compAdbName          = 'Android SDK Command-line Tools & Platform-tools (adb)'
    compAdbDesc          = 'Android emulator bridges, device fingerprint control, ADB communication.'
    compPythonName       = 'Python 3 (>= 3.10)'
    compPythonDesc       = 'Helper automation and hardware profiling engine for isolation suites.'
    compObsName          = 'OBS Studio & OBS Virtual Camera'
    compObsDesc          = 'Virtual video device providing virtual camera emulation for vStudio.'
    compVbName           = 'VB-CABLE Virtual Audio Device'
    compVbDesc           = 'Virtual audio driver providing isolated microphone routing streams.'
    compAppName          = 'Electron Desktop Shell & OctoSuite Application'
    compAppDesc          = 'Sandboxed multi-profile Chromium browser engine with native fingerprint isolation.'
    uiPageInstalling     = 'Installing OctoSuite'
    uiRunSub             = 'Each step runs in the background. The window stays usable, and Cancel stops the work.'
    uiReady              = 'Ready to install.'
    uiStopping           = 'Stopping installation... (Background processes may complete).'
    uiEta                = 'Time left: about {0}'
    uiElapsed            = 'Took {0} s'
    uiStillWorking       = '{0} — still working ({1})'
    uiColStep            = 'Step'
    uiColType            = 'Type'
    uiColStatus          = 'Status'
    uiStWait             = 'Waiting'
    uiStRun              = 'Running'
    uiStDone             = 'Done'
    uiStWarn             = 'Done with warnings'
    uiStFail             = 'Failed'
    uiStSkip             = 'Skipped'
    uiStStopped          = 'Stopped'
    uiLogTitle           = 'Detailed log'
    uiOpenLog            = 'Open log file'
    uiPageDone           = 'Setup is complete'
    uiPageWarnings       = 'Setup is complete, with warnings'
    uiPageFailed         = 'Setup did not finish'
    uiPageCancelled      = 'Setup was stopped'
    uiCompleteSub        = 'Review the result below. Nothing is reported as finished unless every required step succeeded.'
    uiDoneSummary        = 'Every required step finished. OctoSuite is ready to start.'
    uiWarnSummary        = 'Every required step finished. These optional steps did not complete: {0}. OctoSuite works without them; run the installer again later to retry them.'
    uiFailedSummary      = 'A required step did not finish: {0}. Read the log, fix the problem, then press Retry. Steps that already finished are not repeated.'
    uiCancelledSummary   = 'The installation was stopped. Steps that already finished stay installed. Press Retry to continue.'
    uiStopAsk            = 'Stop the installation now? Steps that already finished stay installed, and you can continue later with Retry.'
    uiStartWhenDone      = 'Start Octo.su when finished'
    uiBack               = '< Back'
    uiNext               = 'Next >'
    uiInstall            = 'Install'
    uiCancel             = 'Cancel'
    uiRetry              = 'Retry'
    uiFinish             = 'Finish'
    uiClose              = 'Close'
    vendorBlocked     = 'Refused to download from an address outside the allowed vendor list: {0}'
    vbCableInstall    = 'VB-CABLE has no winget package; installing it from the vendor package. Accept the Windows prompt and reboot afterwards.'
    vbCableDone       = 'VB-CABLE installed. A reboot is needed before the virtual microphone appears.'
    vbCableManual     = 'VB-CABLE could not be installed automatically. Download it from {0}, extract it and run the setup as administrator.'
    cmdlineToolsInstall = 'No Android command-line tools found in the SDK. Downloading them from Google...'
    cmdlineToolsDone  = 'Android command-line tools installed in {0}.'
    cmdlineToolsFailed = 'The Android command-line tools could not be downloaded. Install "Android SDK Command-line Tools (latest)" from Android Studio SDK Manager.'
    javaUsing         = 'Using the JDK in {0} (Java {1}) for the Android SDK tools.'
    javaTooOld        = 'No Java {0} or newer was found. The Android SDK tools cannot run without it - install OpenJDK 17 (this script offers it) or Android Studio, then run the script again.'
    sdkToolsCheck     = 'Checking the Android SDK command line tools (sdkmanager, platform-tools, emulator)...'
    sdkToolsInstall   = 'Installing the Android SDK tools: {0}'
    sdkToolsOk        = 'Android SDK tools are ready. System images are NOT downloaded here - OctoBrowser downloads the one you pick when you press "Create device".'
    sdkToolsFailed    = 'The Android SDK tools could not be installed automatically ({0}). Open Android Studio once, or install them from its SDK Manager.'
    sdkToolsNoSdk     = 'No Android SDK was found yet. Start Android Studio once so it creates the SDK, then run this script again.'
    sdkToolsRoot      = 'SDK packages will be installed in {0} (a folder this user can write to).'
    sdkToolsNotWritable = 'The SDK in {0} is read-only and no writable SDK folder could be created. Free up %LOCALAPPDATA% or run Android Studio once as this user.'
    prereqTooOld      = '{0} {1} is installed but version {2} or newer is required ({3}).'
    firstInstallStart = 'Starting complete first-time installation of OctoSuite...'
    firstInstallSuccess = 'OctoSuite is fully installed and ready to use! Launch it via run.bat, start.bat, or your Desktop shortcut.'
    firstInstallIncomplete = 'Installation completed with warnings. Some optional components may need to be installed manually.'
    logAt             = 'Log: {0}'
    proxyUsed            = 'Proxy for downloads: {0}'
    proxyFailed          = 'The proxy could not be set for PowerShell downloads ({0}).'
    envSet               = 'Android variables set for your Windows account: ANDROID_HOME and ANDROID_SDK_ROOT = {0}'
    pathAdded            = 'Added to your PATH: {0}'
    stepNotFinished      = 'This step did not finish. The messages above say why.'
    wizardNotReady       = 'OctoSuite is not ready yet: it needs Node.js 22.12 or newer, the Electron package and both built apps.'
    wizardStartFailed    = 'The installation could not be started: {0}'
    defaultsNotSaved     = 'The VM compatibility choice could not be saved ({0}).'
    wizardFailed         = 'The installation did not finish. Open the log, fix the problem, and run the installer again.'
  }
  pl = @{
    notInstalled      = '{0} nie jest zainstalowany obok tych skryptów ({1}).'
    devMode           = 'Wykryto kopię deweloperską – uruchamianie przez Electron z node_modules.'
    notBuilt          = 'Aplikacja nie została jeszcze zbudowana. Najpierw uruchom "npm run build".'
    starting          = 'Uruchamianie {0}...'
    running           = '{0} jest uruchomiony. Zamknij go (łącznie z oknami profili) i spróbuj ponownie.'
    confirm           = 'Kontynuować? [t/N]'
    cancelled         = 'Anulowano.'
    done              = 'Gotowe.'
    noBootstrap       = '{0} nie został jeszcze skonfigurowany (nie ukończono pierwszego uruchomienia).'
    noInstaller       = 'Nie znaleziono pliku OctoSuite-Setup-*.exe w: {0}'
    usingInstaller    = 'Instalator: {0}'
    shaOk             = 'SHA-256 poprawne ({0})'
    shaBad            = 'NIEZGODNOŚĆ SHA-256 – plik jest uszkodzony lub zmieniony. Przerwano.'
    shaMissing        = 'Brak SHA256SUMS.txt obok instalatora – skrót zostanie sprawdzony tylko z podpisanym manifestem.'
    authOk            = 'Podpis Authenticode poprawny: {0}'
    authNone          = 'Instalator nie ma podpisu Authenticode. Weryfikacja opiera się na SHA-256 i podpisie Ed25519 manifestu.'
    authBad           = 'Podpis Authenticode NIEPRAWIDŁOWY ({0}). Przerwano.'
    sigOk             = 'Podpis manifestu aktualizacji (Ed25519) poprawny – wersja {0}.'
    sigBad            = 'Weryfikacja manifestu aktualizacji NIEUDANA (kod {0}): {1}'
    sigNotConfigured  = 'Ta kompilacja nie ma klucza podpisu aktualizacji – podpisane aktualizacje są niedostępne.'
    sigUnavailable    = 'Nie można tu zweryfikować podpisu Ed25519 manifestu (brak zainstalowanej aplikacji i Node.js).'
    sigUnavailableAsk = 'Sprawdzono tylko SHA-256 i Authenticode. Wpisz TAK, aby mimo to zainstalować'
    noManifest        = 'Nie znaleziono latest.json / latest.json.sig obok instalatora.'
    runInstaller      = 'Uruchamianie instalatora...'
    installerFailed   = 'Instalator zakończył się kodem {0}.'
    sigRequired       = 'Przerwano: nie można zweryfikować podpisu aktualizacji, więc niczego nie zainstalowano.'
    checking          = 'Sprawdzanie aktualizacji (oficjalne źródło: {0})...'
    upToDate          = 'Zainstalowana wersja {0} jest aktualna (najnowsza: {1}).'
    updateAvailable   = 'Dostępna aktualizacja: {0} -> {1} ({2}).'
    downloading       = 'Pobieranie {0}...'
    urlNotOfficial    = 'Odrzucono adres pobierania spoza oficjalnych wydań: {0}'
    backupConfig      = 'Kopia konfiguracji: {0}'
    keptForRollback   = 'Instalator zachowany do przywracania w {0}'
    repairStart       = 'Sprawdzanie instalacji i konfiguracji OctoSuite...'
    fileMissing       = 'Brak: {0}'
    filesOk           = '{0}: pliki programu są na miejscu.'
    reinstallOffer    = 'Pliki programu są uszkodzone. Zainstalować ponownie z najnowszego zweryfikowanego instalatora? [t/N]'
    bootstrapBroken   = '{0}: bootstrap.json jest uszkodzony – zmieniono jego nazwę; kreator pierwszego uruchomienia użyje ponownie Twojego folderu danych.'
    bootstrapOk       = '{0}: bootstrap.json poprawny (dane: {1})'
    dataDirMissing    = '{0}: folder danych nie istnieje: {1}'
    configOk          = '{0}: {1} poprawny'
    configBroken      = '{0}: {1} jest uszkodzony.'
    configRestored    = '{0}: {1} przywrócono z kopii {2}'
    configNoBackup    = '{0}: {1} – brak poprawnej kopii; aplikacja uruchomi się z ustawieniami domyślnymi.'
    tempCleared       = '{0}: usunięto pliki tymczasowe ({1}).'
    repairSummary     = 'Naprawa zakończona: naprawiono {0}, pozostało {1}.'
    uninstallerMissing = 'Nie znaleziono deinstalatora ({0}). Jeśli używasz wersji przenośnej, usuń jej folder ręcznie.'
    deleteDataAsk     = 'USUNĄĆ również wszystkie profile, ustawienia, raporty i logi w {0}? Tej operacji nie można cofnąć. Wpisz USUŃ, aby potwierdzić'
    dataDeleted       = 'Usunięto folder danych: {0}'
    dataKept          = 'Twoje dane pozostały w: {0}'
    profiles          = 'Profile:'
    profileNotFound   = 'Nie znaleziono profilu: {0}'
    chooseProfile     = 'Podaj nazwę lub numer profilu'
    resetAsk          = 'Zresetować profil „{0}”? Ciasteczka, dane witryn, historia i sesja zostaną usunięte; ustawienia i zakładki pozostaną.'
    resetDone         = 'Profil „{0}” został zresetowany.'
    backupUnencrypted = 'Uwaga: profil „{0}” NIE jest zaszyfrowany – kopia zawiera czytelne ciasteczka/logowania. Przechowuj ją bezpiecznie.'
    backupDone        = 'Utworzono kopię: {0}'
    noArchives        = 'Brak kopii profilu „{0}” w {1}'
    restoreAsk        = 'Przywrócić „{0}” z {1}? Najpierw zostanie utworzona kopia bieżących danych.'
    restoreDone       = 'Profil „{0}” przywrócony.'
    zipSlip           = 'Archiwum zawiera niebezpieczną ścieżkę ({0}). Przerwano.'
    archiveHashBad    = 'Suma kontrolna archiwum się nie zgadza ({0}). Przerwano.'
    archiveNoHash     = 'Brak pliku sumy kontrolnej dla tego archiwum – nie można potwierdzić integralności.'
    restoreNoEntry    = 'Profilu „{0}” nie było na liście profili. Zostanie dodany automatycznie przy następnym uruchomieniu Octo.su.'
    unknownCommand    = 'Nieznane polecenie: {0}'
    error             = 'Błąd: {0}'
    ghChecking        = 'Sprawdzanie wydań na GitHub ({0})...'
    ghNoRelease       = 'W oficjalnym repozytorium nie ma jeszcze żadnego opublikowanego wydania.'
    ghLatest          = 'Najnowsze wydanie na GitHub: {0} (opublikowane {1}).'
    ghNoAsset         = 'To wydanie nie zawiera pliku OctoSuite-Setup-*.exe dla Windows x64.'
    ghUnverifiedAsk   = 'To wydanie nie ma podpisanego manifestu (latest.json + latest.json.sig). Wpisz TAK, aby mimo to zainstalować'
    ghDevDetected     = 'Wykryto kopię deweloperską ({0}) – aktualizacja źródeł z GitHub zamiast instalacji wydania.'
    ghGitMissing      = 'Nie znaleziono git w PATH – nie można zaktualizować kopii deweloperskiej.'
    ghGitDirty        = 'Kopia robocza ma lokalne zmiany. Najpierw je zatwierdź lub odłóż (git stash).'
    ghGitUpToDate     = 'Źródła są już aktualne ({0}).'
    ghGitPulled       = 'Zaktualizowano źródła: {0} -> {1}'
    depsChecking      = 'Sprawdzanie zależności projektu...'
    depsNodeMissing   = 'Nie znaleziono Node.js w PATH (wymagany Node.js >= 22.12).'
    depsFailed        = 'Instalacja zależności projektu nie powiodła się (kod {0}). Odczytaj komunikaty powyżej i otwórz aplikację ponownie.'
    ghBuilding        = 'Budowanie obu aplikacji (npm run build)...'
    ghDevDone         = 'Kopia deweloperska zaktualizowana i zbudowana.'
    ghNpmMissing      = 'Nie znaleziono npm w PATH (wymagany Node.js >= 22.12).'
    ghNpmFailed       = 'npm {0} zakończyło się kodem {1}.'
    startAll          = 'Uruchamianie obu aplikacji...'
    updateSkipped     = 'Pominięto sprawdzanie aktualizacji (-NoUpdate).'
    updateFailed      = 'Sprawdzanie aktualizacji nie powiodło się ({0}) – uruchamianie zainstalowanej wersji.'
    prereqCheck       = 'Sprawdzanie, co jest potrzebne do uruchomienia OctoSuite...'
    prereqOk          = 'Znaleziono {0}: {1}'
    prereqMissing     = 'Brakuje {0} albo wersja jest za stara (wymagane: {1}).'
    prereqInstall     = 'Instalowanie {0} przez winget...'
    prereqNoWinget    = 'winget (Instalator aplikacji) jest niedostępny. Zainstaluj {0} {1} ręcznie z {2} i uruchom skrypt ponownie.'
    prereqFailed      = 'Automatyczna instalacja {0} nie powiodła się (kod {1}). Zainstaluj ręcznie z {2}.'
    prereqAsk         = 'Zainstalować brakujące składniki automatycznie przez winget?'
    prereqRestart     = 'Zainstalowano {0}, ale nie jest jeszcze widoczny w tej konsoli. Zamknij to okno, otwórz nowe i uruchom skrypt ponownie.'
    setupDone         = 'Wszystko gotowe. Uruchom aplikacje plikiem run.bat (albo start-all.bat).'
    setupBuilt        = 'Zbudowano aplikacje: apps\octobrowser\dist, apps\octodetect\dist'
    runHidden         = 'Uruchamianie bez okna konsoli...'
    noSources         = 'Nie ma tu ani instalatora, ani źródeł OctoSuite ({0}). Rozpakuj całe repozytorium (z plikami package.json, apps\ i tools\) albo połóż obok skryptów plik OctoSuite-Setup-*.exe.'
    installFromSources = 'Nie znaleziono instalatora wydania – konfigurowanie kopii źródłowej w {0}.'
    ghNoGitDir        = 'Te źródła nie są klonem git (brak folderu .git), więc nie można pobrać zmian. Odbudowana zostanie tylko aplikacja. Aby dostawać aktualizacje, użyj „git clone”.'
    runSetupVisible   = 'Czegoś jeszcze brakuje – najpierw w widocznym oknie uruchomi się instalacja wymagań.'
    prereqOpenSite    = 'Otworzyć teraz w przeglądarce oficjalną stronę pobierania ({0})?'
    prereqManual      = 'Zainstaluj {0} i uruchom ten skrypt ponownie.'
    androidCheck      = 'Sprawdzanie narzędzi Android używanych przez sekcję maszyn wirtualnych...'
    androidOk         = 'Znaleziono {0}.'
    androidMissing    = 'Brakuje {0}.'
    androidAsk        = 'Zainstalować brakujące składniki Androida ({0}) przez winget? Są potrzebne sekcji urządzeń Android oraz wirtualnej kamerze/mikrofonowi vStudio.'
    androidSkip       = 'Pomijam składniki Androida. Sekcja Android pozostanie niedostępna do czasu ich instalacji.'
    androidFailed     = 'Nie udało się automatycznie zainstalować {0} (kod {1}). Zainstaluj ręcznie z {2}.'
    androidDone       = 'Składniki Androida są gotowe. Uruchom raz Android Studio, aby dokończyło pobieranie SDK.'
    mediaCheck        = 'Sprawdzanie wymagań wtyczek vStudio Mobile i vStudio Web (Python, kamera wirtualna OBS, VB-CABLE)...'
    stepOf            = 'Krok {0} z {1}: {2}'
    stepShortcut      = 'Skrót do Octo.su na pulpicie'
    shortcutDone      = 'Utworzono skrót na pulpicie: {0}'
    shortcutFailed    = 'Nie udało się utworzyć skrótu na pulpicie ({0}). Uruchamiaj Octo.su przez scripts\open.bat.'
    shortcutNoDesktop = 'Nie znaleziono folderu Pulpit, więc skrót nie powstał.'
    stepPrereqs       = 'Node.js i git'
    stepMedia         = 'Wtyczki vStudio (Python, kamera wirtualna OBS, VB-CABLE)'
    stepAndroid       = 'Android Studio i Java 17'
    stepSdk           = 'Narzędzia wiersza poleceń Android SDK, adb i emulator'
    stepDeps          = 'Zależności projektu (npm ci)'
    stepRuntimes      = 'Natywny silnik Chromium (Firefox tymczasowo pominięty)'
    stepBuild         = 'Budowanie OctoBrowser i OctoDetect'
    uiTitle              = 'Instalator OctoSuite'
    uiVersion            = 'Wersja {0}'
    uiHeading            = 'Instalacja OctoSuite'
    uiIntro              = 'Wszystko zostanie zainstalowane bez dalszych pytań. Postęp widać poniżej; okno pozostaje używalne podczas każdego kroku.'
    uiConfigDesc         = 'Wybierz lokalizację Android SDK i sprawdź opcjonalne ustawienia przed instalacją.'
    uiFolder             = 'Folder Android SDK i jego obrazów systemowych (opcjonalnie)'
    uiFolderHint         = 'Pakiety zostaną zainstalowane w tym folderze. Zostaw domyślny, chyba że potrzebujesz innego dysku.'
    uiFolderNotWritable  = 'Do folderu {0} nie można zapisywać. Wybierz inny folder.'
    uiFolderSet          = 'Pakiety Android zostaną zainstalowane w {0}.'
    uiBrowse             = 'Przeglądaj...'
    uiOptionalSettings   = 'Opcjonalne ustawienia'
    uiProxyServer        = 'Serwer proxy (opcjonalnie)'
    uiProxyHint          = 'Używany tylko podczas tej instalacji do pobierania i menedżerów pakietów. Format: host:port.'
    uiProxyBad           = 'Podaj proxy jako host:port lub http://host:port. Nazwy użytkownika i hasła nie są tu obsługiwane.'
    uiEnvVars            = 'Używaj zmiennych środowiskowych systemu (zalecane)'
    uiAddPath            = 'Dodaj narzędzia Android SDK do PATH użytkownika (zalecane)'
    uiVmMode             = 'Tryb zgodności z VirtualBox / maszynami wirtualnymi (programowa obsługa GPU)'
    uiVmTip              = 'Dotyczy tylko uruchomień OctoSuite. Nie zmienia globalnych ustawień maszyn wirtualnych.'
    uiVmAuto             = 'Wykryto maszynę wirtualną, dlatego programowa obsługa GPU pozostaje włączona automatycznie.'
    uiAccountHint        = 'Zmienne środowiskowe i wpisy PATH są zapisywane dla Twojego konta Windows. Prawa administratora nie są potrzebne.'
    uiTabComponents      = 'Co zostanie zainstalowane'
    uiComponentsSubtitle = 'Sprawdź wszystkie składniki, wymagania, lokalizacje instalacji i wskazówki ręcznej konfiguracji.'
    uiStatusCheck        = 'Odśwież stan'
    uiStatusInstalled    = 'Zainstalowano'
    uiStatusMissing      = 'Nie zainstalowano'
    uiRequired           = 'Wymagany'
    uiOptional           = 'Opcjonalny'
    uiLocation           = 'Lokalizacja'
    compNodeName         = 'Node.js LTS (>= 22.12.0)'
    compNodeDesc         = 'Główne środowisko uruchomieniowe dla Octo.su, OctoDetect.su i narzędzi budowania.'
    compGitName          = 'Git for Windows (>= 2.40.0)'
    compGitDesc          = 'Narzędzie kontroli wersji do aktualizacji repozytorium i zarządzania gałęziami.'
    compAdbName          = 'Narzędzia wiersza poleceń Android SDK i Platform-tools (adb)'
    compAdbDesc          = 'Mosty do emulatora Android, kontrola odcisków urządzeń i komunikacja ADB.'
    compPythonName       = 'Python 3 (>= 3.10)'
    compPythonDesc       = 'Pomocniczy silnik automatyzacji i profilowania sprzętu dla zestawów izolacji.'
    compObsName          = 'OBS Studio i OBS Virtual Camera'
    compObsDesc          = 'Wirtualne urządzenie wideo, które udostępnia kamerę dla vStudio.'
    compVbName           = 'Wirtualne urządzenie audio VB-CABLE'
    compVbDesc           = 'Wirtualny sterownik audio dla odizolowanych strumieni mikrofonu.'
    compAppName          = 'Powłoka desktopowa Electron i aplikacja OctoSuite'
    compAppDesc          = 'Odizolowany, wieloprofilowy silnik przeglądarki Chromium z natywną izolacją odcisków.'
    uiPageInstalling     = 'Instalowanie OctoSuite'
    uiRunSub             = 'Każdy krok działa w tle. Okno pozostaje używalne, a Anuluj zatrzymuje pracę.'
    uiReady              = 'Gotowe do instalacji.'
    uiStopping           = 'Zatrzymywanie instalacji... (procesy w tle mogą jeszcze się zakończyć).'
    uiEta                = 'Pozostało około: {0}'
    uiElapsed            = 'Czas: {0} s'
    uiStillWorking       = '{0} — nadal pracuje ({1})'
    uiColStep            = 'Krok'
    uiColType            = 'Typ'
    uiColStatus          = 'Stan'
    uiStWait             = 'Czeka'
    uiStRun              = 'Trwa'
    uiStDone             = 'Gotowe'
    uiStWarn             = 'Gotowe z ostrzeżeniami'
    uiStFail             = 'Błąd'
    uiStSkip             = 'Pominięto'
    uiStStopped          = 'Zatrzymano'
    uiLogTitle           = 'Szczegółowy dziennik'
    uiOpenLog            = 'Otwórz plik dziennika'
    uiPageDone           = 'Instalacja zakończona'
    uiPageWarnings       = 'Instalacja zakończona z ostrzeżeniami'
    uiPageFailed         = 'Instalacja nie została zakończona'
    uiPageCancelled      = 'Instalacja została zatrzymana'
    uiCompleteSub        = 'Sprawdź wynik poniżej. Nic nie jest zgłaszane jako gotowe, dopóki każdy wymagany krok się nie powiedzie.'
    uiDoneSummary        = 'Wszystkie wymagane kroki zostały zakończone. OctoSuite jest gotowy do uruchomienia.'
    uiWarnSummary        = 'Wszystkie wymagane kroki zostały zakończone. Te opcjonalne kroki nie zostały ukończone: {0}. OctoSuite działa bez nich; instalator możesz uruchomić ponownie później.'
    uiFailedSummary      = 'Wymagany krok nie został zakończony: {0}. Przeczytaj dziennik, usuń przyczynę i naciśnij Ponów. Kroki, które już się powiodły, nie są powtarzane.'
    uiCancelledSummary   = 'Instalacja została zatrzymana. Kroki, które już się zakończyły, pozostają zainstalowane. Naciśnij Ponów, aby kontynuować.'
    uiStopAsk            = 'Zatrzymać instalację teraz? Kroki, które już się zakończyły, pozostaną zainstalowane. Instalację można wznowić przyciskiem Ponów.'
    uiStartWhenDone      = 'Uruchom Octo.su po zakończeniu'
    uiBack               = '< Wstecz'
    uiNext               = 'Dalej >'
    uiInstall            = 'Zainstaluj'
    uiCancel             = 'Anuluj'
    uiRetry              = 'Ponów'
    uiFinish             = 'Zakończ'
    uiClose              = 'Zamknij'
    vendorBlocked     = 'Odmowa pobierania z adresu spoza listy dozwolonych dostawców: {0}'
    vbCableInstall    = 'VB-CABLE nie ma pakietu w winget; instalacja z pakietu producenta. Zatwierdź monit Windows i uruchom komputer ponownie.'
    vbCableDone       = 'VB-CABLE zainstalowany. Wirtualny mikrofon pojawi się po ponownym uruchomieniu komputera.'
    vbCableManual     = 'Nie udało się zainstalować VB-CABLE automatycznie. Pobierz go z {0}, rozpakuj i uruchom instalator jako administrator.'
    cmdlineToolsInstall = 'W SDK nie ma narzędzi wiersza poleceń Androida. Pobieranie ich od Google...'
    cmdlineToolsDone  = 'Narzędzia wiersza poleceń Androida zainstalowane w {0}.'
    cmdlineToolsFailed = 'Nie udało się pobrać narzędzi wiersza poleceń Androida. Zainstaluj „Android SDK Command-line Tools (latest)” w SDK Manager Android Studio.'
    javaUsing         = 'Narzędzia Android SDK będą używać JDK z {0} (Java {1}).'
    javaTooOld        = 'Nie znaleziono Javy {0} ani nowszej. Narzędzia Android SDK bez niej nie działają – zainstaluj OpenJDK 17 (ten skrypt to proponuje) lub Android Studio i uruchom skrypt ponownie.'
    sdkToolsCheck     = 'Sprawdzanie narzędzi wiersza poleceń Android SDK (sdkmanager, platform-tools, emulator)...'
    sdkToolsInstall   = 'Instalowanie narzędzi Android SDK: {0}'
    sdkToolsOk        = 'Narzędzia Android SDK są gotowe. Obrazy systemu NIE są tu pobierane - OctoBrowser pobierze wybrany obraz po kliknięciu „Utwórz urządzenie”.'
    sdkToolsFailed    = 'Nie udało się automatycznie zainstalować narzędzi Android SDK ({0}). Uruchom raz Android Studio albo zainstaluj je w jego SDK Manager.'
    sdkToolsNoSdk     = 'Nie znaleziono jeszcze Android SDK. Uruchom raz Android Studio, aby utworzyło SDK, i uruchom ten skrypt ponownie.'
    sdkToolsRoot      = 'Pakiety SDK zostaną zainstalowane w {0} (folder zapisywalny dla tego użytkownika).'
    sdkToolsNotWritable = 'SDK w {0} jest tylko do odczytu i nie udało się utworzyć zapisywalnego folderu SDK. Zwolnij miejsce w %LOCALAPPDATA% lub uruchom raz Android Studio jako ten użytkownik.'
    prereqTooOld      = 'Zainstalowany {0} {1}, a wymagana jest wersja {2} lub nowsza ({3}).'
    firstInstallStart = 'Rozpoczynanie pełnej instalacji początkowej OctoSuite...'
    firstInstallSuccess = 'OctoSuite jest w pełni zainstalowany i gotowy do użycia! Uruchom go za pomocą run.bat, start.bat lub skrótu na Pulpicie.'
    firstInstallIncomplete = 'Instalacja zakończona z ostrzeżeniami. Niektóre opcjonalne składniki mogą wymagać ręcznej instalacji.'
    logAt             = 'Log: {0}'
    proxyUsed            = 'Proxy do pobierań: {0}'
    proxyFailed          = 'Nie udało się ustawić proxy dla pobierań PowerShell ({0}).'
    envSet               = 'Zmienne Android ustawione dla konta Windows: ANDROID_HOME i ANDROID_SDK_ROOT = {0}'
    pathAdded            = 'Dodano do Twojego PATH: {0}'
    stepNotFinished      = 'Ten krok nie został zakończony. Powyższe komunikaty wyjaśniają dlaczego.'
    wizardNotReady       = 'OctoSuite nie jest jeszcze gotowy: potrzebny jest Node.js 22.12 lub nowszy, pakiet Electron i obie zbudowane aplikacje.'
    wizardStartFailed    = 'Nie udało się uruchomić instalacji: {0}'
    defaultsNotSaved     = 'Nie udało się zapisać wyboru zgodności z maszyną wirtualną ({0}).'
    wizardFailed         = 'Instalacja nie została zakończona. Otwórz dziennik, usuń przyczynę i uruchom instalator ponownie.'
  }
}

# ------------------------------------------------------------------ helpers
function Get-BootstrapPath([string]$appId) {
  $a = $Apps[$appId]
  # Portable mode: portable.flag next to the executable => "<app id>.bootstrap.json" next to it
  # (same name as bootstrapFileFor() in packages/shell/src/prepare.ts - checked by tests).
  $exeDir = Join-Path $InstallRoot $a.Folder
  if (Test-Path -LiteralPath (Join-Path $exeDir 'portable.flag')) { return (Join-Path $exeDir ('{0}.bootstrap.json' -f $appId)) }
  return (Join-Path (Join-Path $env:APPDATA $a.Product) 'bootstrap.json')
}

function Read-Bootstrap([string]$appId) {
  $p = Get-BootstrapPath $appId
  if (-not (Test-Path -LiteralPath $p)) { return $null }
  try {
    $b = [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($b.schema -eq 1 -and $b.dataDir -and [System.IO.Path]::IsPathRooted([string]$b.dataDir)) { return $b }
  } catch { }
  return $null
}

if (-not $Lang) {
  $bs = Read-Bootstrap 'octobrowser'
  if (-not $bs) { $bs = Read-Bootstrap 'octodetect' }
  if ($bs -and ($bs.language -eq 'pl' -or $bs.language -eq 'en')) { $Lang = [string]$bs.language }
  elseif ((Get-UICulture).TwoLetterISOLanguageName -eq 'pl') { $Lang = 'pl' }
  else { $Lang = 'en' }
}

function T([string]$key) {
  $s = $Messages[$Lang][$key]
  if (-not $s) { $s = $Messages['en'][$key] }
  if (-not $s) { $s = $key }
  if ($args.Count -gt 0) { return ($s -f $args) }
  return $s
}

# Log file: <data>\logs\scripts-YYYYMMDD.log when configured, otherwise %TEMP%.
$LogFile = $null
function Initialize-Log {
  $bs = Read-Bootstrap 'octobrowser'
  if (-not $bs) { $bs = Read-Bootstrap 'octodetect' }
  $dir = $env:TEMP
  if ($bs -and (Test-Path -LiteralPath ([string]$bs.dataDir))) { $dir = Join-Path ([string]$bs.dataDir) 'logs' }
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $script:LogFile = Join-Path $dir ('scripts-{0}.log' -f (Get-Date -Format 'yyyyMMdd'))
}

function Protect-LogText([string]$text) {
  # Never log secrets: mask anything that looks like a credential or token, shorten user paths.
  $t = $text
  if ($env:USERPROFILE) { $t = $t.Replace($env:USERPROFILE, '%USERPROFILE%') }
  $t = [regex]::Replace($t, '(?i)(password|passwd|pwd|token|secret|key|authorization)\s*[=:]\s*\S+', '$1=[redacted]')
  $t = [regex]::Replace($t, '(?i)://[^/\s:@]+:[^/\s@]+@', '://[redacted]@')
  return $t
}

function Write-Log([string]$level, [string]$text) {
  if (-not $script:LogFile) { return }
  try {
    $line = '{0} {1} [{2}] {3}' -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss'), $level, $Command, (Protect-LogText $text)
    [System.IO.File]::AppendAllText($script:LogFile, $line + [Environment]::NewLine, [System.Text.Encoding]::UTF8)
  } catch { }
}

# When the graphical installer is open every message also goes to its log box.
$script:UiLogSink = $null
# Counts Warn calls; the installer steps compare it before and after to tell "done" from "done with warnings".
$script:WarnCount = 0
function Send-Ui([string]$text) { if ($script:UiLogSink) { try { & $script:UiLogSink $text } catch { } } }
function Say([string]$text, [string]$color = 'Gray') { Write-Host $text -ForegroundColor $color; Write-Log 'info' $text; Send-Ui $text }
function Warn([string]$text) { $script:WarnCount++; Write-Host $text -ForegroundColor Yellow; Write-Log 'warn' $text; Send-Ui $text }
# Fail = error (exit code 1). The message is shown here, so the top-level handler does not repeat it.
function Fail([string]$text) { Write-Host $text -ForegroundColor Red; Write-Log 'error' $text; $script:FailShown = $true; throw [System.Exception]::new($text) }
# Stop-Cancelled = the user declined a confirmation (exit code 2).
function Stop-Cancelled { Say (T 'cancelled') 'Yellow'; throw [System.OperationCanceledException]::new('cancelled') }

function Confirm-Action([string]$question) {
  if ($script:Yes) { Say $question; return $true }
  Write-Host $question -ForegroundColor Cyan
  $a = Read-Host (T 'confirm')
  return ($a -match '^(y|yes|t|tak)$')
}

function Confirm-Word([string]$question, [string[]]$words) {
  if ($script:Yes) { Say $question; return $true }
  $a = Read-Host $question
  return ($words -contains $a.Trim())
}

function Get-AppExe([string]$appId) { return (Join-Path (Join-Path $InstallRoot $Apps[$appId].Folder) $Apps[$appId].Exe) }

function Test-AppRunning([string]$appId) {
  return [bool](Get-Process -Name $Apps[$appId].Process -ErrorAction SilentlyContinue)
}

function Assert-NotRunning([string[]]$appIds) {
  foreach ($id in $appIds) { if (Test-AppRunning $id) { Fail (T 'running' $Apps[$id].Product) } }
}

function Get-FileSha256([string]$path) { return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }

function Test-Authenticode([string]$path) {
  $sig = Get-AuthenticodeSignature -LiteralPath $path
  switch ([string]$sig.Status) {
    'Valid' { Say (T 'authOk' $sig.SignerCertificate.Subject) 'Green'; return }
    'NotSigned' { Warn (T 'authNone'); return }
    default { Fail (T 'authBad' $sig.Status) }
  }
}

function Set-Tls { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 }

function Invoke-Download([string]$url, [string]$dest) {
  if (-not $url.StartsWith("$OfficialBase/")) { Fail (T 'urlNotOfficial' $url) }
  Set-Tls
  Say (T 'downloading' $url)
  $old = $ProgressPreference; $ProgressPreference = 'SilentlyContinue'
  try { Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -MaximumRedirection 5 -Headers @{ 'User-Agent' = 'OctoSuite-scripts' } }
  finally { $ProgressPreference = $old }
}

# Ed25519 manifest verification. Returns the parsed result object (ok, code, version, error).
function Invoke-ManifestVerify([string]$manifest, [string]$installer) {
  $resultFile = Join-Path $env:TEMP ('octo-verify-{0}.json' -f [guid]::NewGuid().ToString('N'))
  try {
    foreach ($id in @('octobrowser', 'octodetect')) {
      $exe = Get-AppExe $id
      if (-not (Test-Path -LiteralPath $exe)) { continue }
      $argList = @("--verify-manifest=`"$manifest`"", "--verify-result=`"$resultFile`"")
      if ($installer) { $argList += "--verify-installer=`"$installer`"" }
      $p = Start-Process -FilePath $exe -ArgumentList $argList -Wait -PassThru -WindowStyle Hidden
      if (Test-Path -LiteralPath $resultFile) {
        return ([System.IO.File]::ReadAllText($resultFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json)
      }
      return [pscustomobject]@{ ok = $false; code = $p.ExitCode; error = 'no result written' }
    }
    # Fresh install: fall back to Node.js + the public key shipped with the scripts.
    $node = Get-Command node -ErrorAction SilentlyContinue
    $pem = Join-Path $PSScriptRoot 'update-public-key.pem'
    if ($node -and (Test-Path -LiteralPath $pem)) {
      $js = @'
const fs=require('fs'),c=require('crypto');
const [m,pem,instArg,out]=process.argv.slice(1);const inst=instArg==='-'?'':instArg;
let r;
try{const b=fs.readFileSync(m),s=Buffer.from(fs.readFileSync(m+'.sig','utf8').trim(),'base64');
 const k=c.createPublicKey(fs.readFileSync(pem,'utf8'));
 if(k.asymmetricKeyType!=='ed25519'||s.length!==64||!c.verify(null,b,k,s)) r={ok:false,code:11,error:'bad signature'};
 else{const j=JSON.parse(b.toString('utf8'));const rel=j.apps&&j.apps.octobrowser;r={ok:!!rel,code:rel?0:14,version:rel&&rel.version};
  if(rel&&inst){const h=c.createHash('sha256').update(fs.readFileSync(inst)).digest('hex');const n=require('path').basename(inst).toLowerCase();
   const f=rel.files.find(x=>x.name.toLowerCase()===n);const ok=!!f&&f.sha256===h;r.ok=ok;r.code=ok?0:(f?12:14);r.installer={name:n,sha256:h,expected:f&&f.sha256,match:ok};}}}
catch(e){r={ok:false,code:13,error:String(e.message||e)}}
fs.writeFileSync(out,JSON.stringify(r));process.exit(r.code);
'@
      # PS 5.1 drops empty native arguments, so "-" stands for "no installer".
      $instArg = '-'
      if ($installer) { $instArg = $installer }
      # Through Invoke-Native: node may print to stderr, which would otherwise become a
      # terminating error under $ErrorActionPreference = 'Stop'. Only the result file counts.
      [void](Invoke-Native $node.Source @('-e', $js, $manifest, $pem, $instArg, $resultFile) $null -Quiet)
      if (Test-Path -LiteralPath $resultFile) {
        return ([System.IO.File]::ReadAllText($resultFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json)
      }
    }
    return $null
  } finally {
    Remove-Item -LiteralPath $resultFile -Force -ErrorAction SilentlyContinue
  }
}

function Assert-ManifestResult($r, [switch]$AllowUnavailable) {
  if ($null -eq $r) {
    Warn (T 'sigUnavailable')
    if (-not $AllowUnavailable) { Fail (T 'sigRequired') }
    if (-not (Confirm-Word (T 'sigUnavailableAsk') @('YES', 'TAK'))) { Stop-Cancelled }
    return
  }
  if ($r.code -eq 10) { Fail (T 'sigNotConfigured') }
  if (-not $r.ok) { Fail (T 'sigBad' $r.code $r.error) }
  Say (T 'sigOk' $r.version) 'Green'
}

function Get-ProfilesDoc([string]$dataDir) {
  $file = Join-Path (Join-Path $dataDir 'config') 'profiles.json'
  $envelope = [System.IO.File]::ReadAllText($file, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
  if ($envelope.encrypted) { throw 'profiles.json is encrypted and cannot be read by scripts' }
  return ($envelope.payload | ConvertFrom-Json)
}

function Select-Profile([string]$dataDir, [string]$query) {
  $doc = Get-ProfilesDoc $dataDir
  $list = @($doc.profiles)
  if (-not $query) {
    Say (T 'profiles') 'Cyan'
    for ($i = 0; $i -lt $list.Count; $i++) {
      Write-Host ('  {0,2}. {1}  [{2}]{3}' -f ($i + 1), $list[$i].name, $list[$i].kind, $(if ($list[$i].encrypted) { '  (enc)' } else { '' }))
    }
    $query = Read-Host (T 'chooseProfile')
  }
  $n = 0
  if ([int]::TryParse($query, [ref]$n) -and $n -ge 1 -and $n -le $list.Count) { return $list[$n - 1] }
  foreach ($p in $list) { if ($p.id -eq $query -or $p.name -eq $query) { return $p } }
  Fail (T 'profileNotFound' $query)
}

function Get-OBDataDir {
  $bs = Read-Bootstrap 'octobrowser'
  if (-not $bs) { Fail (T 'noBootstrap' 'Octo.su') }
  return [string]$bs.dataDir
}

function Assert-SafeProfileId([string]$id) {
  if ($id -notmatch '^[a-z0-9-]{3,64}$') { Fail "invalid profile id: $id" }
}

function Test-VirtualMachine {
  # The choice made in the installer window comes first. The apps and the launchers read it.
  try {
    $defaults = Read-InstallDefaults
    if ($defaults -and $defaults.vmCompatibility -eq $true) { return $true }
  } catch { }
  try {

    $bs = Read-Bootstrap 'octobrowser'
    if ($bs -and $bs.dataDir) {
      $setFile = Join-Path (Join-Path $bs.dataDir 'config') 'settings.json'
      if (Test-Path -LiteralPath $setFile) {
        $setObj = [System.IO.File]::ReadAllText($setFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        if ($setObj.ui.virtualBoxMode -eq $true -or $setObj.ui.vmMode -eq $true) { return $true }
      }
    }
  } catch { }
  return (Test-VirtualMachineHardware)
}

# True when the computer reports itself as a virtual machine (VirtualBox, VMware, Hyper-V, ...).
function Test-VirtualMachineHardware {
  try {
    $cs = Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue
    if ($cs -and $cs.Model -match 'VirtualBox|VMware|Virtual Machine|KVM|Bochs|QEMU|Parallels|Hyper-V') { return $true }
    $bios = Get-CimInstance Win32_BIOS -ErrorAction SilentlyContinue
    if ($bios -and ($bios.SerialNumber -match 'VirtualBox|VMware|Hyper-V' -or $bios.Version -match 'VBOX|VMWARE|Virtual')) { return $true }
    $gpu = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name
    if ($gpu -and ($gpu -match 'VirtualBox|VMware|Basic Display|Standard VGA')) { return $true }
  } catch { }
  return $false
}

# ------------------------------------------------------------------ commands
function Invoke-Open([string]$appId) {
  Update-SessionPath
  $exe = Get-AppExe $appId
  $a = $Apps[$appId]
  if (Test-Path -LiteralPath $exe) {
    Say (T 'starting' $a.Product)
    if ($Rest -and $Rest.Count -gt 0) { Start-Process -FilePath $exe -ArgumentList $Rest -WorkingDirectory (Split-Path -Parent $exe) }
    else { Start-Process -FilePath $exe -WorkingDirectory (Split-Path -Parent $exe) }
    return
  }
  # Development checkout: scripts\ lives in the repository root.
  if (Test-DevCheckout) {
    if (-not (Test-Ready)) {
      $setupOk = Invoke-Setup
      if (-not $setupOk -or -not (Test-Ready)) {
        Fail (T 'notBuilt')
      }
    }
    # A new version may have brought changed dependencies, so they are checked on every open.
    [void](Invoke-EnsureDependencies)
  }
  $electronExe = Join-Path $InstallRoot 'node_modules\electron\dist\electron.exe'
  $electronCmd = Join-Path $InstallRoot 'node_modules\.bin\electron.cmd'
  $appDir = Join-Path $InstallRoot $a.DevDir
  $appMain = Join-Path $appDir 'dist\main.js'

  if (-not (Test-Path -LiteralPath $appMain)) {
    try {
      Invoke-Npm @('run', 'build')
    } catch {
      $nodeExe = Resolve-Tool 'node'
      $buildMjs = Join-Path $InstallRoot 'tools\build.mjs'
      if ($nodeExe -and (Test-Path -LiteralPath $buildMjs)) {
        [void](Invoke-Native $nodeExe @($buildMjs) $InstallRoot)
      }
    }
  }


  $vmArgs = @()
  if (Test-VirtualMachine) {
    $vmArgs += @('--disable-gpu', '--in-process-gpu')
  }

  $allArgs = @()
  $allArgs += "`"$appDir`""
  if ($vmArgs.Count -gt 0) { $allArgs += $vmArgs }
  if ($Rest) {
    foreach ($r in $Rest) {
      if ($r) {
        if ($r -match '\s' -and -not ($r -match '^".*"$')) { $allArgs += "`"$r`"" }
        else { $allArgs += $r }
      }
    }
  }
  $argString = $allArgs -join ' '


  if (Test-Path -LiteralPath $electronExe) {
    if (-not (Test-Path -LiteralPath $appMain)) { Fail (T 'notBuilt') }
    Say (T 'devMode')

    $proc = Start-Process -FilePath $electronExe -ArgumentList $argString -WorkingDirectory $InstallRoot -PassThru
    Start-Sleep -Milliseconds 600
    if ($proc.HasExited -and $proc.ExitCode -ne 0) {
      Fail "Electron exited unexpectedly with code $($proc.ExitCode). Check %LOCALAPPDATA%\OctoSuite\logs."
    }

    return
  }
  if (Test-Path -LiteralPath $electronCmd) {
    if (-not (Test-Path -LiteralPath $appMain)) { Fail (T 'notBuilt') }
    Say (T 'devMode')
    # electron.cmd is a command interpreter wrapper. Hide it explicitly so a
    # source checkout has the same GUI-only launch as an installed build.

    $proc = Start-Process -FilePath $electronCmd -ArgumentList $argString -WorkingDirectory $InstallRoot -WindowStyle Hidden -PassThru
    Start-Sleep -Milliseconds 600
    if ($proc.HasExited -and $proc.ExitCode -ne 0) {
      Fail "Electron exited unexpectedly with code $($proc.ExitCode). Check %LOCALAPPDATA%\OctoSuite\logs."
    }

    return
  }
  Fail (T 'notInstalled' $a.Product $InstallRoot)
}

function Find-Installer([string[]]$dirs) {
  foreach ($d in $dirs) {
    if (-not $d -or -not (Test-Path -LiteralPath $d)) { continue }
    # "OctoSuite-Setup-<version>.exe" (release download) or "<version>.exe" (kept by the updater).
    $cands = @(Get-ChildItem -LiteralPath $d -Filter '*.exe' -File -ErrorAction SilentlyContinue |
      Where-Object { $_.BaseName -match '^(OctoSuite-Setup-)?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$' })
    if ($cands.Count -gt 0) {
      return ($cands | Sort-Object -Property @{ Expression = { try { [version]($_.BaseName -replace '^OctoSuite-Setup-', '' -replace '-.*$', '') } catch { [version]'0.0.0' } } } -Descending | Select-Object -First 1)
    }
  }
  return $null
}

function Test-Sha256Sums([string]$file) {
  $sums = Join-Path (Split-Path -Parent $file) 'SHA256SUMS.txt'
  if (-not (Test-Path -LiteralPath $sums)) { Warn (T 'shaMissing'); return }
  $name = Split-Path -Leaf $file
  $expected = $null
  foreach ($line in [System.IO.File]::ReadAllLines($sums)) {
    if ($line -match '^([0-9a-fA-F]{64})\s+\*?(.+)$' -and $Matches[2].Trim() -eq $name) { $expected = $Matches[1].ToLowerInvariant() }
  }
  $actual = Get-FileSha256 $file
  if (-not $expected -or $expected -ne $actual) { Fail (T 'shaBad') }
  Say (T 'shaOk' $actual) 'Green'
}

# -Silent (used by update): progress window only, no wizard pages - the user has already
# confirmed the update here. Same switches as the in-app updater (core installerArgs()).
function Invoke-Installer([string]$file, [switch]$Silent) {
  Say (T 'runInstaller')
  $log = Join-Path $env:TEMP 'OctoSuite-setup.log'
  $installerArgs = @("/LOG=`"$log`"")
  if ($Silent) { $installerArgs += @('/SILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLOSEAPPLICATIONS', "/LANG=$Lang") }
  $p = Start-Process -FilePath $file -ArgumentList $installerArgs -Wait -PassThru
  if ($p.ExitCode -ne 0) { Fail (T 'installerFailed' $p.ExitCode) }
}

function Invoke-Install {
  # Inside the source tree "install" means "make this copy runnable". An unrelated
  # OctoSuite-Setup-*.exe sitting in Downloads must never be picked up instead;
  # pass -Source <folder> explicitly when you really want to run an installer.
  if ((Test-DevCheckout) -and -not $Source) { Say (T 'installFromSources' $InstallRoot) 'Cyan'; if (-not (Invoke-Setup)) { Fail (T 'wizardFailed') }; return }
  $dirs = @($Source, $ScriptsDir, $InstallRoot, (Join-Path $env:USERPROFILE 'Downloads'))
  $inst = Find-Installer $dirs
  if (-not $inst) {
    # No release installer next to the scripts: this is a source checkout, so install
    # everything needed to run it from sources instead of failing.
    if (Test-DevCheckout) { Say (T 'installFromSources' $InstallRoot) 'Cyan'; if (-not (Invoke-Setup)) { Fail (T 'wizardFailed') }; return }
    Warn (T 'noInstaller' (($dirs | Where-Object { $_ }) -join '; '))
    Fail (T 'noSources' $InstallRoot)
  }
  $file = $inst.FullName
  Say (T 'usingInstaller' $file) 'Cyan'
  Test-Sha256Sums $file
  Test-Authenticode $file
  $manifest = Join-Path $inst.DirectoryName 'latest.json'
  if ((Test-Path -LiteralPath $manifest) -and (Test-Path -LiteralPath "$manifest.sig")) {
    Assert-ManifestResult (Invoke-ManifestVerify $manifest $file) -AllowUnavailable
  } else {
    Warn (T 'noManifest')
    if (-not (Confirm-Word (T 'sigUnavailableAsk') @('YES', 'TAK'))) { Stop-Cancelled }
  }
  Assert-NotRunning @('octobrowser', 'octodetect')
  Invoke-Installer $file
  Say (T 'done') 'Green'
}

function Backup-Configs([string]$stamp) {
  foreach ($id in @('octobrowser', 'octodetect')) {
    $bs = Read-Bootstrap $id
    if (-not $bs) { continue }
    $cfg = Join-Path ([string]$bs.dataDir) 'config'
    if (-not (Test-Path -LiteralPath $cfg)) { continue }
    $dest = Join-Path (Join-Path ([string]$bs.dataDir) 'backups') "pre-update-$stamp"
    New-Item -ItemType Directory -Path $dest -Force | Out-Null
    Copy-Item -LiteralPath $cfg -Destination $dest -Recurse -Force
    Say (T 'backupConfig' $dest)
  }
}

function Invoke-Update {
  $exe = Get-AppExe 'octobrowser'
  if (-not (Test-Path -LiteralPath $exe)) { Fail (T 'notInstalled' 'Octo.su' $InstallRoot) }
  $installed = [string](Get-Item -LiteralPath $exe).VersionInfo.ProductVersion
  Say (T 'checking' $OfficialBase) 'Cyan'
  $work = Join-Path $env:TEMP ('OctoSuite-update-{0}' -f [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $work -Force | Out-Null
  try {
    $manifest = Join-Path $work 'latest.json'
    Invoke-Download "$OfficialBase/latest/download/latest.json" $manifest
    Invoke-Download "$OfficialBase/latest/download/latest.json.sig" "$manifest.sig"
    $r = Invoke-ManifestVerify $manifest $null
    Assert-ManifestResult $r
    $m = [System.IO.File]::ReadAllText($manifest, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    $rel = $m.apps.octobrowser
    $newer = $false
    try { $newer = ([version]($rel.version -replace '-.*$', '')) -gt ([version]($installed -replace '-.*$', '')) } catch { $newer = $rel.version -ne $installed }
    if (-not $newer) { Say (T 'upToDate' $installed $rel.version) 'Green'; return }
    Say (T 'updateAvailable' $installed $rel.version $rel.severity) 'Cyan'
    if ($Lang -eq 'pl') { Write-Host $rel.changelog.pl } else { Write-Host $rel.changelog.en }
    if ($CheckOnly) { return }
    if (-not (Confirm-Action '')) { Stop-Cancelled }
    $f = @($rel.files | Where-Object { $_.platform -eq 'win32' -and $_.arch -eq 'x64' })[0]
    if ($f.name -notmatch '^[\w.-]+$') { Fail 'invalid file name in manifest' }
    $installer = Join-Path $work $f.name
    Invoke-Download ([string]$f.url) $installer
    Assert-ManifestResult (Invoke-ManifestVerify $manifest $installer)
    Test-Authenticode $installer
    Assert-NotRunning @('octobrowser', 'octodetect')
    Backup-Configs (Get-Date -Format 'yyyyMMdd-HHmmss')
    # Keep the verified installer for rollback (same folder the in-app updater uses; newest 3 kept).
    $bs = Read-Bootstrap 'octobrowser'
    if ($bs) {
      $keep = Join-Path ([string]$bs.dataDir) 'updater\installed'
      New-Item -ItemType Directory -Path $keep -Force | Out-Null
      # Same naming as the in-app updater ("<version>.exe") so the app offers it for rollback.
      if ([string]$rel.version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') { Fail 'invalid version in manifest' }
      Copy-Item -LiteralPath $installer -Destination (Join-Path $keep ('{0}.exe' -f $rel.version)) -Force
      Get-ChildItem -LiteralPath $keep -Filter '*.exe' -File | Sort-Object LastWriteTime -Descending | Select-Object -Skip 3 | Remove-Item -Force -ErrorAction SilentlyContinue
      Say (T 'keptForRollback' $keep)
    }
    Invoke-Installer $installer -Silent
    Say (T 'done') 'Green'
  } finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# VersionedStore envelope check: { schema:1, sha256:<hex of payload>, encrypted, payload }
function Test-Envelope([string]$file) {
  try {
    $e = [System.IO.File]::ReadAllText($file, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($e.schema -ne 1 -or -not ($e.payload -is [string]) -or -not ($e.sha256 -is [string])) { return $false }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $h = -join ($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($e.payload)) | ForEach-Object { $_.ToString('x2') }) }
    finally { $sha.Dispose() }
    return ($h -eq $e.sha256)
  } catch { return $false }
}

function Invoke-Repair {
  Say (T 'repairStart') 'Cyan'
  Assert-NotRunning @('octobrowser', 'octodetect')
  $fixed = 0; $remaining = 0
  $filesBroken = $false
  foreach ($id in @('octobrowser', 'octodetect')) {
    $a = $Apps[$id]
    $dir = Join-Path $InstallRoot $a.Folder
    $need = @((Join-Path $dir $a.Exe), (Join-Path $dir 'resources\app.asar'))
    $missing = @($need | Where-Object { -not (Test-Path -LiteralPath $_) })
    if ($missing.Count -gt 0) { foreach ($m in $missing) { Warn (T 'fileMissing' $m) }; $filesBroken = $true }
    else { Say (T 'filesOk' $a.Product) 'Green' }
  }
  foreach ($id in @('octobrowser', 'octodetect')) {
    $a = $Apps[$id]
    $bp = Get-BootstrapPath $id
    if (-not (Test-Path -LiteralPath $bp)) { Say (T 'noBootstrap' $a.Product); continue }
    $bs = Read-Bootstrap $id
    if (-not $bs) {
      Move-Item -LiteralPath $bp -Destination ('{0}.broken-{1}' -f $bp, (Get-Date -Format 'yyyyMMdd-HHmmss')) -Force
      Warn (T 'bootstrapBroken' $a.Product); $fixed++; continue
    }
    $data = [string]$bs.dataDir
    if (-not (Test-Path -LiteralPath $data)) { Warn (T 'dataDirMissing' $a.Product $data); $remaining++; continue }
    Say (T 'bootstrapOk' $a.Product $data) 'Green'
    $names = @('settings.json')
    if ($id -eq 'octobrowser') { $names += 'profiles.json' }
    foreach ($n in $names) {
      $f = Join-Path (Join-Path $data 'config') $n
      if (-not (Test-Path -LiteralPath $f)) { continue }
      if (Test-Envelope $f) { Say (T 'configOk' $a.Product $n) 'Green'; continue }
      Warn (T 'configBroken' $a.Product $n)
      $bdir = Join-Path $data 'backups\config'
      $restored = $false
      if (Test-Path -LiteralPath $bdir) {
        foreach ($b in (Get-ChildItem -LiteralPath $bdir -Filter "$n.*.bak" -File | Sort-Object LastWriteTime -Descending)) {
          if (Test-Envelope $b.FullName) {
            Copy-Item -LiteralPath $f -Destination ('{0}.corrupt-{1}' -f $f, (Get-Date -Format 'yyyyMMdd-HHmmss')) -Force
            Copy-Item -LiteralPath $b.FullName -Destination $f -Force
            Say (T 'configRestored' $a.Product $n $b.Name) 'Green'; $restored = $true; $fixed++; break
          }
        }
      }
      if (-not $restored) { Warn (T 'configNoBackup' $a.Product $n); $remaining++ }
    }
    $tmp = Join-Path $data 'temp'
    if (Test-Path -LiteralPath $tmp) {
      $items = @(Get-ChildItem -LiteralPath $tmp -Force -ErrorAction SilentlyContinue)
      $items | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
      Say (T 'tempCleared' $a.Product $items.Count)
    }
  }
  if ($filesBroken) {
    $bs = Read-Bootstrap 'octobrowser'
    $inst = $null
    if ($bs) { $inst = Find-Installer @((Join-Path ([string]$bs.dataDir) 'updater\installed')) }
    if ($inst -and (Confirm-Action (T 'reinstallOffer'))) {
      Test-Authenticode $inst.FullName
      Invoke-Installer $inst.FullName; $fixed++
    } else { $remaining++ }
  }
  Say (T 'repairSummary' $fixed $remaining) $(if ($remaining -gt 0) { 'Yellow' } else { 'Green' })
}

function Invoke-Uninstall {
  Assert-NotRunning @('octobrowser', 'octodetect')
  $dataDirs = @()
  foreach ($id in @('octobrowser', 'octodetect')) { $bs = Read-Bootstrap $id; if ($bs) { $dataDirs += [string]$bs.dataDir } }
  $unins = Get-ChildItem -LiteralPath $InstallRoot -Filter 'unins*.exe' -File -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($DeleteData -and $dataDirs.Count -gt 0) {
    foreach ($d in $dataDirs) {
      if (-not (Test-Path -LiteralPath $d)) { continue }
      # Only delete folders that really are OctoSuite data folders.
      if (-not (Test-Path -LiteralPath (Join-Path $d 'config'))) { continue }
      if (Confirm-Word (T 'deleteDataAsk' $d) @('DELETE', 'USUŃ', 'USUN')) {
        Remove-Item -LiteralPath $d -Recurse -Force
        Say (T 'dataDeleted' $d) 'Yellow'
      } else { Say (T 'dataKept' $d) }
    }
    foreach ($id in @('octobrowser', 'octodetect')) {
      $bp = Get-BootstrapPath $id
      if (Test-Path -LiteralPath $bp) { Remove-Item -LiteralPath (Split-Path -Parent $bp) -Recurse -Force -ErrorAction SilentlyContinue }
    }
  } else {
    foreach ($d in $dataDirs) { Say (T 'dataKept' $d) }
  }
  if (-not $unins) { Warn (T 'uninstallerMissing' $InstallRoot); return }
  # Inno Setup's uninstaller copies itself to %TEMP% and removes the program folder.
  Start-Process -FilePath $unins.FullName -Wait
  Say (T 'done') 'Green'
}

function Get-ArchiveDir([string]$dataDir) { return (Join-Path $dataDir 'backups\profile-archives') }

function New-ProfileArchive([string]$dataDir, $p, [string]$destDir) {
  Assert-SafeProfileId $p.id
  $src = Join-Path (Join-Path $dataDir 'profiles') $p.id
  if (-not (Test-Path -LiteralPath $src)) { Fail (T 'profileNotFound' $p.id) }
  if (-not $p.encrypted) { Warn (T 'backupUnencrypted' $p.name) }
  if (-not $destDir) { $destDir = Get-ArchiveDir $dataDir }
  New-Item -ItemType Directory -Path $destDir -Force | Out-Null
  # Milliseconds + a counter: two backups in the same second must not collide (CreateNew below).
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
  $zip = Join-Path $destDir ('{0}-{1}.zip' -f $p.id, $stamp)
  for ($n = 2; Test-Path -LiteralPath $zip; $n++) { $zip = Join-Path $destDir ('{0}-{1}-{2}.zip' -f $p.id, $stamp, $n) }
  $fs = [System.IO.File]::Open($zip, [System.IO.FileMode]::CreateNew)
  try {
    $za = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
      $root = (Resolve-Path -LiteralPath $src).ProviderPath.TrimEnd('\') + '\'
      foreach ($f in (Get-ChildItem -LiteralPath $src -Recurse -File -Force)) {
        $rel = $f.FullName.Substring($root.Length).Replace('\', '/')
        [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($za, $f.FullName, "profile/$rel", [System.IO.Compression.CompressionLevel]::Optimal)
      }
      # Profile settings entry (from profiles.json, contains no secrets - proxy passwords live in secrets.bin).
      $entry = $za.CreateEntry('profile-entry.json')
      $w = New-Object System.IO.StreamWriter($entry.Open(), (New-Object System.Text.UTF8Encoding($false)))
      try { $w.Write(($p | ConvertTo-Json -Depth 10)) } finally { $w.Dispose() }
    } finally { $za.Dispose() }
  } finally { $fs.Dispose() }
  $hash = Get-FileSha256 $zip
  [System.IO.File]::WriteAllText("$zip.sha256", ('{0}  {1}' -f $hash, (Split-Path -Leaf $zip)) + "`n", (New-Object System.Text.UTF8Encoding($false)))
  return $zip
}

function Invoke-BackupProfile {
  $data = Get-OBDataDir
  Assert-NotRunning @('octobrowser')
  $p = Select-Profile $data $ProfileName
  $zip = New-ProfileArchive $data $p $Destination
  Say (T 'backupDone' $zip) 'Green'
}

function Invoke-ResetProfile {
  $data = Get-OBDataDir
  Assert-NotRunning @('octobrowser')
  $p = Select-Profile $data $ProfileName
  Assert-SafeProfileId $p.id
  if (-not (Confirm-Action (T 'resetAsk' $p.name))) { Stop-Cancelled }
  if (-not $NoBackup) { $zip = New-ProfileArchive $data $p $null; Say (T 'backupDone' $zip) }
  $dir = Join-Path (Join-Path $data 'profiles') $p.id
  foreach ($x in @('engine', 'engine.vault', 'history.enc', 'session.enc')) {
    $t = Join-Path $dir $x
    if (Test-Path -LiteralPath $t) { Remove-Item -LiteralPath $t -Recurse -Force }
  }
  New-Item -ItemType Directory -Path (Join-Path $dir 'engine') -Force | Out-Null
  Say (T 'resetDone' $p.name) 'Green'
}

function Invoke-RestoreProfile {
  $data = Get-OBDataDir
  Assert-NotRunning @('octobrowser')
  $zipPath = $Archive
  $p = $null
  if (-not $zipPath) {
    $p = Select-Profile $data $ProfileName
    Assert-SafeProfileId $p.id
    $dir = Get-ArchiveDir $data
    $cand = @(Get-ChildItem -LiteralPath $dir -Filter "$($p.id)-*.zip" -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
    if ($cand.Count -eq 0) { Fail (T 'noArchives' $p.name $dir) }
    $zipPath = $cand[0].FullName
  }
  $zipPath = (Resolve-Path -LiteralPath $zipPath).ProviderPath
  # Integrity (sidecar checksum written by backup-profile).
  $side = "$zipPath.sha256"
  if (Test-Path -LiteralPath $side) {
    $expected = ([System.IO.File]::ReadAllText($side).Trim() -split '\s+')[0].ToLowerInvariant()
    if ($expected -ne (Get-FileSha256 $zipPath)) { Fail (T 'archiveHashBad' $zipPath) }
  } else { Warn (T 'archiveNoHash') }
  $za = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    $entryJson = $za.Entries | Where-Object { $_.FullName -eq 'profile-entry.json' } | Select-Object -First 1
    if (-not $entryJson) { Fail 'profile-entry.json missing in archive' }
    $r = New-Object System.IO.StreamReader($entryJson.Open(), [System.Text.Encoding]::UTF8)
    try { $metaJson = $r.ReadToEnd() } finally { $r.Dispose() }
    $meta = $metaJson | ConvertFrom-Json
    Assert-SafeProfileId $meta.id
    if ($p -and $p.id -ne $meta.id) { Fail (T 'profileNotFound' $meta.id) }
    if (-not (Confirm-Action (T 'restoreAsk' $meta.name $zipPath))) { Stop-Cancelled }
    $target = Join-Path (Join-Path $data 'profiles') $meta.id
    $staging = "$target.restore-$([guid]::NewGuid().ToString('N'))"
    $stagingRoot = [System.IO.Path]::GetFullPath($staging).TrimEnd('\') + '\'
    New-Item -ItemType Directory -Path $staging -Force | Out-Null
    try {
      foreach ($e in $za.Entries) {
        if (-not $e.FullName.StartsWith('profile/') -or $e.FullName.EndsWith('/')) { continue }
        $rel = $e.FullName.Substring(8)
        $dest = [System.IO.Path]::GetFullPath((Join-Path $staging $rel))
        if (-not $dest.StartsWith($stagingRoot, [System.StringComparison]::OrdinalIgnoreCase)) { Fail (T 'zipSlip' $e.FullName) }
        New-Item -ItemType Directory -Path (Split-Path -Parent $dest) -Force | Out-Null
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, $dest, $true)
      }
      # Back up the current state first, then swap folders.
      if (Test-Path -LiteralPath $target) {
        $doc = Get-ProfilesDoc $data
        $cur = @($doc.profiles | Where-Object { $_.id -eq $meta.id })[0]
        if ($cur) { $zip = New-ProfileArchive $data $cur $null; Say (T 'backupDone' $zip) }
        Remove-Item -LiteralPath $target -Recurse -Force
      }
      Move-Item -LiteralPath $staging -Destination $target
    } finally {
      if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }
    }
    $doc2 = Get-ProfilesDoc $data
    if (-not (@($doc2.profiles | Where-Object { $_.id -eq $meta.id }).Count)) {
      # The entry was deleted from the list. The script never edits profiles.json (the app is its
      # only writer); instead it leaves the archived entry for OctoBrowser, which validates it and
      # adds the profile back at next start (ProfileManager.adoptRestoredEntries).
      $marker = Join-Path $target 'restored-entry.json'
      [System.IO.File]::WriteAllText($marker, $metaJson, (New-Object System.Text.UTF8Encoding($false)))
      Write-Log 'info' "restored-entry marker written for $($meta.id)"
      Say (T 'restoreNoEntry' $meta.name) 'Yellow'
    }
    Say (T 'restoreDone' $meta.name) 'Green'
  } finally { $za.Dispose() }
}

# ------------------------------------------------------ prerequisites (install.bat / run.bat)
# Everything OctoSuite needs to run from sources. Nothing is installed silently behind the
# user's back: winget is used only after a confirmation (or with -Yes), packages come from
# the official winget repository and each step is logged.
$Prereqs = @(
  @{ Id = 'OpenJS.NodeJS.LTS'; Name = 'Node.js'; Cmd = 'node'; Min = '22.12.0'; Site = 'https://nodejs.org/'; DirectUrl = 'https://nodejs.org/dist/v22.12.0/node-v22.12.0-x64.msi'; ZipUrl = 'https://nodejs.org/dist/v22.12.0/node-v22.12.0-win-x64.zip'; InstallerType = 'msi' }
  @{ Id = 'Git.Git';           Name = 'git';     Cmd = 'git';  Min = '2.30.0';  Site = 'https://git-scm.com/'; DirectUrl = 'https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.1/Git-2.47.1-64-bit.exe'; ZipUrl = 'https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.1/MinGit-2.47.1-64-bit.zip'; InstallerType = 'inno' }
)

# Tools are looked up in PATH first, then - because a console started before the installer
# ran keeps an old PATH - in the registry copy of PATH and in the standard install folders.
# Everything resolved here is used by absolute path afterwards.
$ToolHints = @{
  'node' = @('nodejs\node.exe')
  'npm'  = @('nodejs\npm.cmd')
  'git'  = @('Git\cmd\git.exe', 'Git\bin\git.exe')
}
$ToolRoots = @(
  "$env:ProgramFiles\nodejs",
  "${env:ProgramFiles(x86)}\nodejs",
  "$env:ProgramW6432\nodejs",
  "$env:ProgramFiles\Git\cmd",
  "$env:ProgramFiles\Git\bin",
  "${env:ProgramFiles(x86)}\Git\cmd",
  "${env:ProgramFiles(x86)}\Git\bin",
  "$env:ProgramW6432\Git\cmd",
  "$env:LOCALAPPDATA\Programs\node",
  "$env:LOCALAPPDATA\Programs\Git\cmd",
  "$env:LOCALAPPDATA\Programs\Git\bin",
  "$env:LOCALAPPDATA\Programs\Git",
  (Join-Path $env:LOCALAPPDATA 'Programs\node'),
  (Join-Path $env:LOCALAPPDATA 'Programs\Git'),
  (Join-Path $env:LOCALAPPDATA 'Programs\git'),
  "$env:APPDATA\npm",
  $env:ProgramFiles,
  ${env:ProgramFiles(x86)},
  $env:ProgramW6432,
  (Join-Path $env:LOCALAPPDATA 'Programs'),
  $env:LOCALAPPDATA
)
$script:ToolCache = @{}

# winget writes the new PATH to the registry; this console keeps the old copy until refreshed.
function Update-SessionPath {
  $parts = @()
  foreach ($scope in @('Machine', 'User')) {
    $value = [Environment]::GetEnvironmentVariable('Path', $scope)
    if ($value) { $parts += $value.Split(';') }
  }
  if ($env:Path) { $parts += $env:Path.Split(';') }
  $commonDirs = @(
    "$env:ProgramFiles\nodejs",
    "${env:ProgramFiles(x86)}\nodejs",
    "$env:ProgramW6432\nodejs",
    "$env:LOCALAPPDATA\Programs\node",
    "$env:APPDATA\npm",
    "$env:ProgramFiles\Git\cmd",
    "$env:ProgramFiles\Git\bin",
    "${env:ProgramFiles(x86)}\Git\cmd",
    "${env:ProgramFiles(x86)}\Git\bin",
    "$env:ProgramW6432\Git\cmd",
    "$env:LOCALAPPDATA\Programs\Git\cmd",
    "$env:LOCALAPPDATA\Programs\Git\bin"
  )
  foreach ($dir in $commonDirs) {
    if ($dir -and (Test-Path -LiteralPath $dir)) { $parts += $dir }
  }
  $nodeProg = Join-Path $env:LOCALAPPDATA 'Programs\node'
  if (Test-Path -LiteralPath $nodeProg) {
    foreach ($cd in (Get-ChildItem -LiteralPath $nodeProg -Directory -ErrorAction SilentlyContinue)) {
      $parts += $cd.FullName
    }
  }
  $seen = @{}
  $clean = @()
  foreach ($part in $parts) {
    $p = $part.Trim()
    if (-not $p -or $seen.ContainsKey($p.ToLowerInvariant())) { continue }
    $seen[$p.ToLowerInvariant()] = $true
    $clean += $p
  }
  $env:Path = $clean -join ';'
  $script:ToolCache = @{}
}

# Absolute path of a tool, or $null. Finding node.exe outside PATH also fixes PATH for this
# session, so npm.cmd and node_modules\.bin\electron.cmd work afterwards.
function Resolve-Tool([string]$name) {
  if ($script:ToolCache.ContainsKey($name)) { return $script:ToolCache[$name] }
  $found = $null
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Path) { $found = $cmd.Path }
  if (-not $found -and $name -eq 'npm') {
    $cmd = Get-Command 'npm.cmd' -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Path) { $found = $cmd.Path }
  }
  if (-not $found -and $ToolHints.ContainsKey($name)) {
    foreach ($root in $ToolRoots) {
      if (-not $root -or -not (Test-Path -LiteralPath $root)) { continue }
      foreach ($hint in $ToolHints[$name]) {
        $candidate = Join-Path $root $hint
        if (Test-Path -LiteralPath $candidate) { $found = $candidate; break }
        $candidateDirect = Join-Path $root (Split-Path -Leaf $hint)
        if (Test-Path -LiteralPath $candidateDirect) { $found = $candidateDirect; break }
        if ($hint -like '*\*') {
          $childDirs = Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue
          foreach ($cd in $childDirs) {
            $candSub = Join-Path $cd.FullName (Split-Path -Leaf $hint)
            if (Test-Path -LiteralPath $candSub) { $found = $candSub; break }
          }
          if ($found) { break }
        }
      }
      if ($found) { break }
    }
  }
  if ($found) {
    $dir = Split-Path -Parent $found
    $onPath = $false
    if ($env:Path) { $onPath = [bool](@($env:Path.Split(';') | Where-Object { $_.Trim().TrimEnd('\') -ieq $dir.TrimEnd('\') }).Count) }
    if (-not $onPath) {
      $env:Path = "$dir;$env:Path"
      Write-Log 'info' "added to PATH for this session: $dir"
    }
  }
  $script:ToolCache[$name] = $found
  return $found
}

# Runs an external program and returns its exit code.
#
# Why this wrapper: the script runs with $ErrorActionPreference = 'Stop', and in that mode
# ANY line a native program writes to stderr is turned into a terminating error. npm writes
# its "npm warn deprecated ..." notices to stderr, git writes progress there - none of which
# means failure. Here the preference is relaxed for the duration of the call, every line is
# printed as plain text, and only the exit code decides whether something went wrong.
function Invoke-Native([string]$exe, [string[]]$argList, [string]$workDir, [switch]$Quiet) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $lines = New-Object System.Collections.Generic.List[string]
  $lastGitProgressAt = [datetime]::MinValue
  $oldDir = $null
  if ($workDir) {
    $oldDir = [System.IO.Directory]::GetCurrentDirectory()
    Push-Location -LiteralPath $workDir
    try { [System.IO.Directory]::SetCurrentDirectory($workDir) } catch { }
  }
  try {
    & $exe @argList 2>&1 | ForEach-Object {
      $line = if ($_ -is [System.Management.Automation.ErrorRecord]) { [string]$_.Exception.Message } else { [string]$_ }
      $lines.Add($line)
      if (-not $Quiet) {
        # A terminal renders Git's carriage-return progress in place. Through
        # PowerShell's pipe each update becomes a new line, so show occasional
        # checkpoints while retaining every line in the returned diagnostics.
        $displayLine = $line.Trim()
        if ($displayLine -match '^Still working on:\s*(.+)$') { $displayLine = "Chromium checkout active: $($matches[1])" }
        $isGitProgress = $displayLine -match '^(remote:\s*)?(Counting objects|Compressing objects|Receiving objects|Resolving deltas|Updating files)|^Chromium checkout active:'
        if (-not $isGitProgress -or ([datetime]::UtcNow - $lastGitProgressAt).TotalSeconds -ge 15) {
          Write-Host $displayLine
          if ($isGitProgress) { $lastGitProgressAt = [datetime]::UtcNow }
        }
      }
      try { [System.Windows.Forms.Application]::DoEvents() } catch { }
    }
    $code = $LASTEXITCODE
    if ($null -eq $code) { $code = 0 }
    return [pscustomobject]@{ code = $code; text = ($lines -join [Environment]::NewLine) }
  } finally {
    if ($workDir) {
      Pop-Location
      if ($oldDir) { try { [System.IO.Directory]::SetCurrentDirectory($oldDir) } catch { } }
    }
    $ErrorActionPreference = $previous
  }
}

function Get-ToolVersion([string]$name) {
  $exe = Resolve-Tool $name
  if (-not $exe) { return $null }
  try {
    $raw = (Invoke-Native $exe @('--version') $null -Quiet).text
    $m = [regex]::Match($raw, '\d+\.\d+(\.\d+)?')
    if ($m.Success) { return [version]($m.Value + ('.0' * (2 - ([regex]::Matches($m.Value, '\.')).Count))) }
  } catch { }
  return $null
}

# winget exit codes that mean "nothing to do", not "it failed".
# 0x8A15002B = -1978335189 no applicable update, 0x8A150014 = -1978335212 already installed.
$WingetBenign = @(0, -1978335189, -1978335212)

function Install-PrerequisiteDirect($tool) {
  if (-not $tool.DirectUrl) { return $false }
  Say (T 'prereqInstall' $tool.Name) 'Cyan'
  $tempDir = [System.IO.Path]::GetTempPath()
  $ext = if ($tool.InstallerType -eq 'msi') { '.msi' } else { '.exe' }
  $dest = Join-Path $tempDir ("octo-prereq-$($tool.Cmd)$ext")
  try {
    $downloaded = Invoke-VendorDownload $tool.DirectUrl $dest
    if ($downloaded -and (Test-Path -LiteralPath $dest)) {
      Say (T 'prereqInstall' $tool.Name) 'Cyan'
      if ($tool.InstallerType -eq 'msi') {
        $msiArgs = if ($tool.DirectArgs) { $tool.DirectArgs } else { @('/i', "`"$dest`"", '/qn', '/norestart') }
        $p = Start-Process -FilePath 'msiexec.exe' -ArgumentList $msiArgs -Wait -PassThru -NoNewWindow
        if ($p.ExitCode -eq 0 -or $p.ExitCode -eq 3010) {
          Update-SessionPath
          if ($tool.Cmd) {
            $ver = Get-ToolVersion $tool.Cmd
            if ($ver -and $ver -ge [version]$tool.Min) { return $true }
          }
          if ($tool.Test) {
            try { if (& $tool.Test) { return $true } } catch { }
          }
        }
      } else {
        $exeArgs = if ($tool.DirectArgs) { $tool.DirectArgs } else { @('/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-', '/CLOSEAPPLICATIONS') }
        $p = Start-Process -FilePath $dest -ArgumentList $exeArgs -Wait -PassThru -NoNewWindow
        if ($p.ExitCode -eq 0) {
          Update-SessionPath
          if ($tool.Cmd) {
            $ver = Get-ToolVersion $tool.Cmd
            if ($ver -and $ver -ge [version]$tool.Min) { return $true }
          }
          if ($tool.Test) {
            try { if (& $tool.Test) { return $true } } catch { }
          }
        }
      }
    }
  } catch {
    Warn "Direct install of $($tool.Name) failed: $($_.Exception.Message)"
  } finally {
    if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Force -ErrorAction SilentlyContinue }
  }

  if ($tool.ZipUrl) {
    $zipDest = Join-Path $tempDir ("octo-prereq-$($tool.Cmd).zip")
    $extractTarget = Join-Path $env:LOCALAPPDATA ("Programs\$($tool.Cmd)")
    try {
      Say (T 'downloading' $tool.ZipUrl)
      if (Invoke-VendorDownload $tool.ZipUrl $zipDest) {
        if (-not (Test-Path -LiteralPath $extractTarget)) { New-Item -ItemType Directory -Path $extractTarget -Force | Out-Null }
        Say (T 'prereqInstall' "$($tool.Name) (portable)") 'Cyan'
        Expand-Archive -LiteralPath $zipDest -DestinationPath $extractTarget -Force
        Update-SessionPath
        $ver = Get-ToolVersion $tool.Cmd
        if ($ver -and $ver -ge [version]$tool.Min) { return $true }
      }
    } catch {
      Warn "Portable zip extract for $($tool.Name) failed: $($_.Exception.Message)"
    } finally {
      if (Test-Path -LiteralPath $zipDest) { Remove-Item -LiteralPath $zipDest -Force -ErrorAction SilentlyContinue }
    }
  }

  return $false
}

function Install-Prerequisite($tool) {
  $winget = Get-Command 'winget' -ErrorAction SilentlyContinue
  $installed = $false
  if ($winget) {
    Say (T 'prereqInstall' $tool.Name) 'Cyan'
    # Official winget source only, no interactive prompts; Windows may still show UAC for
    # a machine-wide package (Node.js MSI) - that consent is the user's, not ours to bypass.
    $wingetArgs = @('install', '--id', $tool.Id, '--exact', '--source', 'winget', '--silent',
      '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity')
    $p = Start-Process -FilePath $winget.Source -ArgumentList $wingetArgs -Wait -PassThru -NoNewWindow
    Update-SessionPath
    if ($WingetBenign -contains $p.ExitCode) {
      # Already installed (possibly only in the registry PATH this console has not seen yet).
      if ($p.ExitCode -ne 0) { Write-Log 'info' "winget: nothing to install for $($tool.Id) (code $($p.ExitCode))" }
      $installed = $true
    }
  }
  if (-not $installed) {
    $installed = Install-PrerequisiteDirect $tool
  }
  Update-SessionPath
  if (-not $installed) {
    Warn (T 'prereqNoWinget' $tool.Name $tool.Min $tool.Site)
    if (Confirm-Action (T 'prereqOpenSite' $tool.Site)) { Start-Process $tool.Site }
    Fail (T 'prereqManual' $tool.Name)
  }
}

# Returns $true when every prerequisite is present (after installing the missing ones).
function Install-Prerequisites([switch]$GitRequired) {
  Say (T 'prereqCheck') 'Cyan'
  # A console opened before the tool was installed still has the old PATH - refresh it first,
  # otherwise a perfectly good Node.js looks "missing".
  Update-SessionPath
  $missing = @()
  foreach ($tool in $Prereqs) {
    if ($tool.Cmd -eq 'git' -and -not $GitRequired) { continue }
    $have = Get-ToolVersion $tool.Cmd
    if ($have -and $have -ge [version]$tool.Min) { Say (T 'prereqOk' $tool.Name $have) 'Green'; continue }
    Warn (T 'prereqMissing' $tool.Name $tool.Min)
    $missing += $tool
  }
  if ($missing.Count -eq 0) { return $true }
  if (-not $script:Yes -and -not (Confirm-Action (T 'prereqAsk'))) { Stop-Cancelled }
  foreach ($tool in $missing) {
    Install-Prerequisite $tool
    Update-SessionPath
    $have = Get-ToolVersion $tool.Cmd
    if (-not $have) {
      Update-SessionPath
      $have = Get-ToolVersion $tool.Cmd
    }
    if (-not $have) { Warn (T 'prereqRestart' $tool.Name); return $false }
    if ($have -lt [version]$tool.Min) {
      # winget reported success/"already installed" but the version is still too low
      # (an old package, nvm, or a second copy earlier in PATH).
      Warn (T 'prereqTooOld' $tool.Name $have $tool.Min (Resolve-Tool $tool.Cmd))
      if (Confirm-Action (T 'prereqOpenSite' $tool.Site)) { Start-Process $tool.Site }
      Fail (T 'prereqManual' $tool.Name)
    }
    Say (T 'prereqOk' $tool.Name $have) 'Green'
  }
  return $true
}

# Chromium's Windows source build needs depot_tools before npm can run
# build-chromium-source.mjs. Keep this separate from the small application
# prerequisites above: depot_tools is a developer toolchain and is installed
# only when a source-built Chromium runtime is actually missing.
function Ensure-ChromiumBuildToolchain {
  if ($env:OS -ne 'Windows_NT') { return $true }
  $git = Resolve-Tool 'git'
  if (-not $git) { Warn 'Chromium source build needs Git for Windows, but git was not found.'; return $false }

  $depot = Join-Path $env:LOCALAPPDATA 'InkBrowser\depot_tools'
  $fetch = Join-Path $depot 'fetch.bat'
  if (-not (Test-Path -LiteralPath $fetch)) {
    $parent = Split-Path -Parent $depot
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    if (Test-Path -LiteralPath $depot) {
      $entries = @(Get-ChildItem -LiteralPath $depot -Force -ErrorAction SilentlyContinue)
      if ($entries.Count -gt 0) { Warn "The depot_tools folder is incomplete: $depot"; return $false }
      Remove-Item -LiteralPath $depot -Force -ErrorAction SilentlyContinue
    }
    Say 'Downloading official Chromium depot_tools...' 'Cyan'
    $clone = Invoke-Native $git @('clone', '--depth', '1', 'https://chromium.googlesource.com/chromium/tools/depot_tools.git', $depot) $parent
    if ($clone.code -ne 0 -or -not (Test-Path -LiteralPath $fetch)) {
      Warn "depot_tools could not be downloaded into $depot (exit code $($clone.code))."
      return $false
    }
  }

  # Chromium requires depot_tools to be first, and DEPOT_TOOLS_WIN_TOOLCHAIN=0
  # tells it to use the user's local Visual Studio installation.
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $pathParts = @($userPath -split ';' | Where-Object { $_ -and $_.Trim() })
  if (-not (@($pathParts | Where-Object { $_.TrimEnd('\').Equals($depot.TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase) }).Count)) {
    [Environment]::SetEnvironmentVariable('Path', (($depot + ';' + ($pathParts -join ';')).Trim(';')), 'User')
  }
  [Environment]::SetEnvironmentVariable('DEPOT_TOOLS_WIN_TOOLCHAIN', '0', 'User')
  $env:DEPOT_TOOLS_WIN_TOOLCHAIN = '0'
  $env:Path = $depot + ';' + $env:Path
  Update-SessionPath

  $vswhereCandidates = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft Visual Studio\Installer\vswhere.exe')
  )
  $vswhere = $vswhereCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $vswhere) {
    $winget = Get-Command 'winget' -ErrorAction SilentlyContinue
    if (-not $winget) {
      Warn 'Visual Studio Build Tools are missing and winget is unavailable. Install Desktop development with C++ and MFC/ATL support, then run install.bat again.'
      return $false
    }
    Say 'Installing Visual Studio Build Tools with C++ and MFC/ATL support...' 'Cyan'
    $vsArgs = @('install', '--exact', '--id', 'Microsoft.VisualStudio.BuildTools', '--source', 'winget', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity', '--override', '--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --add Microsoft.VisualStudio.Component.VC.ATLMFC --includeRecommended')
    $vsInstall = Start-Process -FilePath $winget.Source -ArgumentList $vsArgs -Wait -PassThru -NoNewWindow
    if ($WingetBenign -notcontains $vsInstall.ExitCode) {
      Warn "Visual Studio Build Tools installation failed with exit code $($vsInstall.ExitCode)."
      return $false
    }
    $vswhere = $vswhereCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  }
  if (-not $vswhere) {
    Warn 'Visual Studio Build Tools were not found after installation. Open Visual Studio Installer, select Desktop development with C++ plus MFC/ATL support, and run install.bat again.'
    return $false
  }
  # First gclient run installs depot_tools' managed Python and Windows helpers.
  $gclient = Join-Path $depot 'gclient.bat'
  if (Test-Path -LiteralPath $gclient) {
    # depot_tools prints a recommendation on every invocation unless this
    # explicit opt-out is present. Keep the user's global Git configuration
    # from being rewritten by depot_tools and silence the harmless warning.
    $git = Resolve-Tool 'git'
    if ($git) { [void](Invoke-Native $git @('config', '--global', 'depot-tools.allowGlobalGitConfig', 'false') $depot -Quiet) }
    $bootstrap = Invoke-Native $gclient @() $depot
    if ($bootstrap.code -ne 0) { Warn "depot_tools bootstrap failed with exit code $($bootstrap.code)."; return $false }
  }
  return $true
}

# ------------------------------------------------- Android prerequisites (virtual machines section)
# The "virtual machines -> Android" section drives a locally installed Android
# Studio (AVD), and the bundled vStudio virtual camera/microphone runs on Python with
# the OBS virtual camera and the VB-CABLE virtual audio device. These are
# optional for the rest of OctoSuite, so they are installed only after a
# confirmation and a failure never blocks the build.
# Everything the two vStudio media plugins need. vStudio Web (browser
# profiles) needs these even when no Android device is ever created, so they
# are installed independently of the Android tooling.
$MediaPrereqs = @(
  @{ Id = 'Python.Python.3.12';     Name = 'Python 3';       Site = 'https://www.python.org/downloads/';    DirectUrl = 'https://www.python.org/ftp/python/3.12.7/python-3.12.7-amd64.exe'; InstallerType = 'inno'; DirectArgs = @('/quiet', 'InstallAllUsers=0', 'PrependPath=1'); Test = { [bool](Get-Command 'python' -ErrorAction SilentlyContinue) -or [bool](Get-Command 'python3' -ErrorAction SilentlyContinue) } }
  @{ Id = 'OBSProject.OBSStudio';   Name = 'OBS Studio (virtual camera)'; Site = 'https://obsproject.com/'; DirectUrl = 'https://github.com/obsproject/obs-studio/releases/download/30.2.3/OBS-Studio-30.2.3-Windows-Installer.exe'; InstallerType = 'inno'; DirectArgs = @('/S'); Test = { Test-PathAny @("$env:ProgramFiles\obs-studio", "${env:ProgramFiles(x86)}\obs-studio") } }
  @{ Id = 'VB-Audio.Cable';         Name = 'VB-CABLE (virtual microphone)'; Site = 'https://vb-audio.com/Cable/'; Fallback = { Install-VbCable }; Test = { Test-PathAny @("$env:SystemRoot\System32\drivers\vbaudio_cable64_win7.sys", "$env:SystemRoot\System32\drivers\vbaudio_cable_win7.sys", "$env:SystemRoot\System32\drivers\vbaudio_cable64_win10.sys") } }
)

$AndroidPrereqs = @(
  @{ Id = 'Google.AndroidStudio';   Name = 'Android Studio'; Site = 'https://developer.android.com/studio'; Test = { Test-AndroidStudioPresent } }
  @{ Id = 'Microsoft.OpenJDK.17';   Name = 'Java (OpenJDK 17)'; Site = 'https://learn.microsoft.com/java/openjdk/download'; Test = { Test-JavaPresent } }
)

function Test-PathAny([string[]]$candidates) {
  foreach ($candidate in $candidates) { if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $true } }
  return $false
}

# sdkmanager refuses to run on anything below Java 17 ('Java version 17 or
# higher is required'), so the version is what counts - not merely that some
# java.exe exists. The number is read from the JDK's own 'release' file.
$MinJavaMajor = 17

function Get-JavaMajor([string]$home_) {
  if (-not $home_) { return 0 }
  $release = Join-Path $home_ 'release'
  $text = ''
  if (Test-Path -LiteralPath $release) {
    try { $text = (Select-String -LiteralPath $release -Pattern 'JAVA_VERSION' | Select-Object -First 1).Line } catch { $text = '' }
  }
  if (-not $text) { $text = Split-Path $home_ -Leaf }
  $m = [regex]::Match($text, '(?<!\d)(\d{1,2})(?:[._]\d+)*')
  if (-not $m.Success) { return 0 }
  $major = [int]$m.Groups[1].Value
  if ($major -eq 1) {
    $legacy = [regex]::Match($text, '1\.(\d+)')
    if ($legacy.Success) { return [int]$legacy.Groups[1].Value }
  }
  return $major
}

# Every JDK we might be able to use, Android Studio's bundled jbr included.
function Get-JavaCandidates {
  $list = New-Object System.Collections.Generic.List[string]
  if ($env:JAVA_HOME) { $list.Add($env:JAVA_HOME) }
  foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
    if (-not $base) { continue }
    $list.Add((Join-Path $base 'Android\Android Studio\jbr'))
    $list.Add((Join-Path $base 'Programs\Android Studio\jbr'))
    foreach ($vendor in @('Java', 'Eclipse Adoptium', 'Microsoft', 'Zulu', 'Amazon Corretto', 'BellSoft')) {
      $dir = Join-Path $base $vendor
      if (Test-Path -LiteralPath $dir) {
        foreach ($entry in (Get-ChildItem -LiteralPath $dir -Directory -ErrorAction SilentlyContinue)) { $list.Add($entry.FullName) }
      }
    }
  }
  return ($list | Where-Object { $_ -and (Test-Path -LiteralPath (Join-Path $_ 'bin\java.exe')) } | Select-Object -Unique)
}

# Newest JDK that is at least Java 17, or $null.
function Get-ModernJavaHome {
  $best = $null
  $bestMajor = 0
  foreach ($candidate in (Get-JavaCandidates)) {
    $major = Get-JavaMajor $candidate
    if ($major -ge $MinJavaMajor -and $major -gt $bestMajor) { $best = $candidate; $bestMajor = $major }
  }
  return $best
}

function Test-JavaPresent {
  return [bool](Get-ModernJavaHome)
}

function Test-AndroidStudioPresent {
  $paths = @("$env:ProgramFiles\Android\Android Studio\bin\studio64.exe", "$env:LOCALAPPDATA\Programs\Android Studio\bin\studio64.exe")
  if (Test-PathAny $paths) { return $true }
  # An SDK on its own (command-line tools) is enough for the Android section.
  return Test-PathAny @("$env:LOCALAPPDATA\Android\Sdk", $env:ANDROID_SDK_ROOT, $env:ANDROID_HOME)
}

# Downloads from vendor hosts the tooling really needs. The
# allow-list is exact: anything else is refused, the same rule Invoke-Download
# applies to our own release host.
$VendorHosts = @('dl.google.com', 'download.vb-audio.com', 'vb-audio.com', 'nodejs.org', 'github.com', 'git-scm.com', 'www.python.org', 'obsproject.com')

function Invoke-VendorDownload([string]$url, [string]$dest) {
  try { $host_ = ([uri]$url).Host } catch { return $false }
  if ($VendorHosts -notcontains $host_) { Warn (T 'vendorBlocked' $url); return $false }
  Set-Tls
  Say (T 'downloading' $url)
  $parent = Split-Path -Path $dest -Parent
  if ($parent -and -not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }

  try {
    $req = [System.Net.HttpWebRequest]::Create($url)
    $req.UserAgent = 'OctoSuite-scripts'
    $req.Timeout = 300000
    $req.ReadWriteTimeout = 300000
    $req.AllowAutoRedirect = $true
    $req.MaximumAutomaticRedirections = 5
    $resp = $req.GetResponse()
    $stream = $resp.GetResponseStream()
    $fs = New-Object System.IO.FileStream($dest, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    $buffer = New-Object byte[] 65536
    $lastTick = [Environment]::TickCount
    try {
      while (($bytesRead = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
        $fs.Write($buffer, 0, $bytesRead)
        $now = [Environment]::TickCount
        if ($now - $lastTick -ge 150) {
          $lastTick = $now
          try { [System.Windows.Forms.Application]::DoEvents() } catch { }
        }
      }
    } finally {
      $fs.Dispose()
      $stream.Dispose()
      $resp.Dispose()
    }
    return (Test-Path -LiteralPath $dest)
  } catch {
    $old = $ProgressPreference; $ProgressPreference = 'SilentlyContinue'
    try {
      Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -MaximumRedirection 5 -Headers @{ 'User-Agent' = 'OctoSuite-scripts' }
      return (Test-Path -LiteralPath $dest)
    } catch {
      Write-Log 'warn' "download failed: $url $($_.Exception.Message)"
      return $false
    } finally {
      $ProgressPreference = $old
    }
  }
}

# VB-CABLE is not on winget at all ('No package found matching input
# criteria'), so it is fetched from the vendor and its setup is started.
$VbCableZip = 'https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip'

function Install-VbCable {
  $zip = Join-Path $env:TEMP ('vbcable-{0}.zip' -f [guid]::NewGuid().ToString('N'))
  $dir = Join-Path $env:TEMP ('vbcable-{0}' -f [guid]::NewGuid().ToString('N'))
  if (-not (Invoke-VendorDownload $VbCableZip $zip)) { Warn (T 'vbCableManual' 'https://vb-audio.com/Cable/'); return $false }
  try {
    Expand-Archive -LiteralPath $zip -DestinationPath $dir -Force
  } catch { Warn (T 'vbCableManual' 'https://vb-audio.com/Cable/'); return $false }
  $setup = Get-ChildItem -LiteralPath $dir -Filter 'VBCABLE_Setup*.exe' -Recurse -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending | Select-Object -First 1
  if (-not $setup) { Warn (T 'vbCableManual' 'https://vb-audio.com/Cable/'); return $false }
  Say (T 'vbCableInstall') 'Cyan'
  try {
    # The driver installer needs elevation and shows its own window.
    $p = Start-Process -FilePath $setup.FullName -ArgumentList @('-i', '-h') -Verb RunAs -Wait -PassThru
    if ($p.ExitCode -ne 0) { Warn (T 'vbCableManual' $setup.FullName); return $false }
  } catch { Warn (T 'vbCableManual' $setup.FullName); return $false }
  Say (T 'vbCableDone') 'Green'
  return $true
}

# The command-line tools Google publishes standalone. Newest build first: the
# first URL that answers is used, so an older fallback still works when a new
# build number appears.
$CmdlineToolsUrls = @(
  'https://dl.google.com/android/repository/commandlinetools-win-16111833_latest.zip',
  'https://dl.google.com/android/repository/commandlinetools-win-14742923_latest.zip',
  'https://dl.google.com/android/repository/commandlinetools-win-10406996_latest.zip',
  'https://dl.google.com/android/repository/commandlinetools-win-9477386_latest.zip',
  'https://dl.google.com/android/repository/commandlinetools-win-8512546_latest.zip',
  'https://dl.google.com/android/repository/commandlinetools-win-7583922_latest.zip',
  'https://dl.google.com/android/repository/commandlinetools-win-6858069_latest.zip',
  'https://dl.google.com/android/repository/commandlinetools-win-6609375_latest.zip',
  'https://dl.google.com/android/repository/commandlinetools-win-6514223_latest.zip',
  'https://dl.google.com/android/repository/commandlinetools-win-6200805_latest.zip'
)

# Installs cmdline-tools (sdkmanager + the new 'android' CLI) into a writable
# SDK folder when the detected SDK has none. Returns the folder or $null.
function Install-CommandLineTools([string]$root) {
  if (-not $root) { return $null }
  $zip = Join-Path $env:TEMP ('cmdline-tools-{0}.zip' -f [guid]::NewGuid().ToString('N'))
  $ok = $false
  foreach ($url in $CmdlineToolsUrls) {
    if (Invoke-VendorDownload $url $zip) { $ok = $true; break }
  }
  if (-not $ok) { Warn (T 'cmdlineToolsFailed'); return $null }
  $staging = Join-Path $env:TEMP ('cmdline-tools-{0}' -f [guid]::NewGuid().ToString('N'))
  try { Expand-Archive -LiteralPath $zip -DestinationPath $staging -Force } catch { Warn (T 'cmdlineToolsFailed'); return $null }
  $inner = Join-Path $staging 'cmdline-tools'
  if (-not (Test-Path -LiteralPath $inner)) { Warn (T 'cmdlineToolsFailed'); return $null }
  $target = Join-Path $root 'cmdline-tools\latest'
  try {
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
    Move-Item -LiteralPath $inner -Destination $target -Force
  } catch { Warn (T 'cmdlineToolsFailed'); return $null }
  Say (T 'cmdlineToolsDone' $target) 'Green'
  return $target
}

# Installs the missing prerequisites of the vStudio media plugins and of the
# Android tooling. Both return $true when nothing is left missing; neither throws.
function Install-MediaPrerequisites {
  Say (T 'mediaCheck') 'Cyan'
  return (Install-PrereqTable $MediaPrereqs)
}

function Install-AndroidPrerequisites {
  Say (T 'androidCheck') 'Cyan'
  return (Install-PrereqTable $AndroidPrereqs)
}

# Shared winget loop for a table of prerequisites. Never throws.
function Install-PrereqTable($table) {
  Update-SessionPath
  $missing = @()
  foreach ($tool in $table) {
    $present = $false
    try { $present = [bool](& $tool.Test) } catch { $present = $false }
    if ($present) { Say (T 'androidOk' $tool.Name) 'Green' } else { Warn (T 'androidMissing' $tool.Name); $missing += $tool }
  }
  if ($missing.Count -eq 0) { return $true }
  if (-not $script:Yes -and -not (Confirm-Action (T 'androidAsk' (($missing | ForEach-Object { $_.Name }) -join ', ')))) { Warn (T 'androidSkip'); return $false }
  $winget = Get-Command 'winget' -ErrorAction SilentlyContinue
  $ok = $true
  foreach ($tool in $missing) {
    Say (T 'prereqInstall' $tool.Name) 'Cyan'
    $installed = $false
    if ($winget) {
      $wingetArgs = @('install', '--id', $tool.Id, '--exact', '--source', 'winget', '--silent',
        '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity')
      $p = Start-Process -FilePath $winget.Source -ArgumentList $wingetArgs -Wait -PassThru -NoNewWindow
      Update-SessionPath
      if ($WingetBenign -contains $p.ExitCode) {
        $installed = $true
      }
    }
    if (-not $installed) {
      if ($tool.DirectUrl) {
        $installed = Install-PrerequisiteDirect $tool
      }
      if (-not $installed -and $tool.Fallback) {
        try { $installed = [bool](& $tool.Fallback) } catch { $installed = $false }
      }
    }
    if (-not $installed) {
      try { $present = [bool](& $tool.Test) } catch { $present = $false }
      if ($present) { $installed = $true }
    }
    if (-not $installed) {
      Warn (T 'androidFailed' $tool.Name '1' $tool.Site)
      $ok = $false
    }
  }
  if ($ok) { Say (T 'androidDone') 'Green' }
  return $ok
}
# The Android SDK pieces OctoBrowser needs before it can do anything: the
# command line tools (sdkmanager/avdmanager), adb and the emulator binary.
# System images are deliberately NOT installed here - they are large, and the
# user picks one inside the app, where "Create device" downloads exactly that
# image with a progress bar.
$AndroidSdkPackages = @('cmdline-tools;latest', 'platform-tools', 'emulator', 'build-tools;34.0.0')

function Get-AndroidSdkRoot {
  foreach ($candidate in @($env:ANDROID_SDK_ROOT, $env:ANDROID_HOME, (Join-Path $env:LOCALAPPDATA 'Android\Sdk'),
      (Join-Path $env:ProgramFiles 'Android\android-sdk'), (Join-Path ${env:ProgramFiles(x86)} 'Android\android-sdk'))) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }
  return $null
}

# Can this user write here? Program Files needs elevation, and sdkmanager
# reacts to that by downloading a package and then failing to unpack it.
function Test-FolderWritable([string]$dir) {
  if (-not $dir) { return $false }
  try {
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $probe = Join-Path $dir ('.octo-write-' + [System.Guid]::NewGuid().ToString('N'))
    Set-Content -LiteralPath $probe -Value 'octo' -Encoding ascii
    Remove-Item -LiteralPath $probe -Force
    return $true
  } catch { return $false }
}

# Where SDK packages are installed: the first writable candidate, otherwise the
# per-user SDK folder. Never Program Files.
function Get-AndroidInstallRoot {
  # The folder chosen in the installer window comes first and is created when missing.
  # After it: the folders the SDK normally lives in. The first writable one wins.
  $chosen = [string]$env:OCTO_SETUP_SDK
  if ($chosen -and (Test-FolderWritable $chosen)) { return $chosen }
  foreach ($candidate in @($env:ANDROID_SDK_ROOT, $env:ANDROID_HOME, (Join-Path $env:LOCALAPPDATA 'Android\Sdk'))) {
    if ($candidate -and (Test-Path -LiteralPath $candidate) -and (Test-FolderWritable $candidate)) { return $candidate }
  }
  $fallback = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
  if (Test-FolderWritable $fallback) { return $fallback }
  return $null
}

# Tell OctoBrowser which folder the installer used, so the app installs system
# images and the vStudio plugins in the same writable place.
function Save-AndroidInstallRoot([string]$root) {
  if (-not $root) { return }
  try {
    $dir = Join-Path $env:USERPROFILE '.octobrowser'
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $file = Join-Path $dir 'android-sdk.json'
    $current = @{}
    if (Test-Path -LiteralPath $file) {
      try { (Get-Content -LiteralPath $file -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $current[$_.Name] = $_.Value } } catch { $current = @{} }
    }
    $current['installRoot'] = $root
    ($current | ConvertTo-Json -Depth 4) | Set-Content -LiteralPath $file -Encoding utf8
  } catch { Write-Log 'warn' "install root not recorded: $($_.Exception.Message)" }
}

function Get-SdkManagerPath([string]$root) {
  if (-not $root) { return $null }
  foreach ($relative in @('cmdline-tools\latest\bin\sdkmanager.bat', 'cmdline-tools\bin\sdkmanager.bat', 'tools\bin\sdkmanager.bat')) {
    $candidate = Join-Path $root $relative
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  # Any other cmdline-tools revision folder counts too (11.0, 13.0, ...).
  $cmdline = Join-Path $root 'cmdline-tools'
  if (Test-Path -LiteralPath $cmdline) {
    foreach ($entry in (Get-ChildItem -LiteralPath $cmdline -Directory -ErrorAction SilentlyContinue)) {
      $candidate = Join-Path $entry.FullName 'bin\sdkmanager.bat'
      if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
  }
  return $null
}

function Get-AndroidJavaHome {
  if ($env:JAVA_HOME -and (Test-Path -LiteralPath (Join-Path $env:JAVA_HOME 'bin\java.exe'))) { return $env:JAVA_HOME }
  foreach ($candidate in @("$env:ProgramFiles\Android\Android Studio\jbr", "$env:LOCALAPPDATA\Programs\Android Studio\jbr")) {
    if (Test-Path -LiteralPath (Join-Path $candidate 'bin\java.exe')) { return $candidate }
  }
  return $null
}

# Installs the SDK tool packages (no system images). Never throws.
function Install-AndroidSdkComponents {
  Say (T 'sdkToolsCheck') 'Cyan'
  $toolsRoot = Get-AndroidSdkRoot
  # Packages are written to a folder this user owns, even when the SDK that
  # carries sdkmanager.bat sits in Program Files.
  $root = Get-AndroidInstallRoot
  if (-not $root) { Warn (T 'sdkToolsNotWritable' $toolsRoot); return $false }
  $sdkmanager = Get-SdkManagerPath $root
  if (-not $sdkmanager) { $sdkmanager = Get-SdkManagerPath $toolsRoot }
  if (-not $sdkmanager) {
    # An Android Studio install without command-line tools is the normal case:
    # download them from Google instead of telling the user to do it by hand.
    Say (T 'cmdlineToolsInstall') 'Cyan'
    [void](Install-CommandLineTools $root)
    $sdkmanager = Get-SdkManagerPath $root
  }
  if (-not $sdkmanager) { Warn (T 'sdkToolsFailed' 'sdkmanager') ; return $false }
  Save-AndroidInstallRoot $root
  Say (T 'sdkToolsRoot' $root) 'Cyan'
  $java = Get-ModernJavaHome
  if (-not $java) { $java = Get-AndroidJavaHome }
  if (-not $java) { Warn (T 'javaTooOld' $MinJavaMajor); return $false }
  $env:JAVA_HOME = $java
  $env:Path = "$java\bin;$env:Path"
  # sdkmanager's own JDK check is skipped: $java was selected by version.
  $env:SKIP_JDK_VERSION_CHECK = '1'
  Say (T 'javaUsing' $java (Get-JavaMajor $java)) 'Cyan'
  # Remember the good JDK for this user, so OctoBrowser and any later console
  # inherit it instead of an old Java 8 left over in JAVA_HOME.
  try {
    $userJava = [Environment]::GetEnvironmentVariable('JAVA_HOME', 'User')
    if ((-not $userJava) -or ((Get-JavaMajor $userJava) -lt $MinJavaMajor)) {
      [Environment]::SetEnvironmentVariable('JAVA_HOME', $java, 'User')
    }
  } catch { Write-Log 'warn' "JAVA_HOME not persisted: $($_.Exception.Message)" }
  Say (T 'sdkToolsInstall' ($AndroidSdkPackages -join ', ')) 'Cyan'
  # The command line is built from plain strings: nesting escaped quotes inside
  # an expanding string is what made this script fail to parse before.
  $q = [char]34
  $tool = $q + $sdkmanager + $q
  $rootArg = $q + '--sdk_root=' + $root + $q
  $packages = (($AndroidSdkPackages | ForEach-Object { $q + $_ + $q }) -join ' ')
  try {
    # "y" answers the licence prompts; only tool packages are listed here.
    $licence = Invoke-Native $env:ComSpec @('/d', '/s', '/c', ('echo y| ' + $tool + ' ' + $rootArg + ' --licenses')) $null -Quiet
    $install = Invoke-Native $env:ComSpec @('/d', '/s', '/c', ('echo y| ' + $tool + ' ' + $rootArg + ' ' + $packages)) $null
    if ($install.code -ne 0) { Warn (T 'sdkToolsFailed' $install.code); return $false }
    if ($licence.code -ne 0) { Write-Log 'warn' "sdkmanager --licenses exit $($licence.code)" }
  } catch {
    Warn (T 'sdkToolsFailed' $_.Exception.Message)
    return $false
  }
  Say (T 'sdkToolsOk') 'Green'
  return $true
}

# Full setup of a development checkout: prerequisites -> dependencies -> npm run build.
# Desktop shortcut to Octo.su. It goes through lib\hidden.vbs so the
# browser starts with no console window, carries the product icon, and is
# rewritten on every setup so a moved checkout never leaves a dead link.
function New-DesktopShortcut {
  $desktop = [Environment]::GetFolderPath('Desktop')
  if (-not $desktop -or -not (Test-Path -LiteralPath $desktop)) { Warn (T 'shortcutNoDesktop'); return $false }
  $open = Join-Path $ScriptsDir 'open.bat'
  $hidden = Join-Path $ScriptsDir 'lib\hidden.vbs'
  if (-not (Test-Path -LiteralPath $open)) { Warn (T 'shortcutFailed' $open); return $false }
  $link = Join-Path $desktop 'Octo.su.lnk'
  $icon = Join-Path $InstallRoot 'branding\octobrowser\icon.ico'
  try {
    $shell = New-Object -ComObject WScript.Shell
    $cut = $shell.CreateShortcut($link)
    if (Test-Path -LiteralPath $hidden) {
      $cut.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
      $q = [char]34
      $cut.Arguments = '//nologo //B ' + $q + $hidden + $q + ' ' + $q + $open + $q
    } else {
      $cut.TargetPath = $open
      $cut.Arguments = ''
    }
    $cut.WorkingDirectory = $InstallRoot
    $cut.Description = 'Octo.su'
    if (Test-Path -LiteralPath $icon) { $cut.IconLocation = $icon }
    $cut.Save()
  } catch { Warn (T 'shortcutFailed' $_.Exception.Message); return $false }
  Say (T 'shortcutDone' $link) 'Green'
  return $true
}

# Checks the dependencies against package-lock.json and the workspace manifests
# and installs what is missing or stale, through tools\ensure-deps.mjs. The npm
# start hooks run the same script, so every way of opening the app passes
# through it. An installed copy has no sources to check and returns at once.
function Invoke-EnsureDependencies {
  $ensureScript = Join-Path $InstallRoot 'tools\ensure-deps.mjs'
  if (-not (Test-Path -LiteralPath $ensureScript)) { return $true }
  $nodeExe = Resolve-Tool 'node'
  if (-not $nodeExe) { Fail (T 'depsNodeMissing') }
  Say (T 'depsChecking') 'Cyan'
  $r = Invoke-Native $nodeExe @($ensureScript) $InstallRoot
  if ($r.code -ne 0) {
    # Keep the tail of the output in the log so a failed install can be diagnosed later.
    foreach ($line in @($r.text -split "`r?`n" | Select-Object -Last 20)) { Write-Log 'error' $line }
    Fail (T 'depsFailed' $r.code)
  }
  return $true
}

# Validate one staged native runtime without trusting its filename alone. Chromium on
# Windows must explicitly identify itself as a modified source build; a renamed vendor
# archive is not accepted. Both engines must carry a manifest hash matching the file.
function Test-NativeRuntimeReady([string]$kind, [string]$target) {
  $isWindows = $target -like 'win32-*'
  $version = if ($kind -eq 'chromium') { '155.0.8059.39' } else { '140.0' }
  $root = if ($kind -eq 'chromium') { Join-Path $InstallRoot "resources\engines\chromium\$version" } else { Join-Path $InstallRoot "resources\engines\gecko\$version" }
  $exeName = if ($kind -eq 'chromium') { if ($isWindows) { 'inkbrowser-chrome.exe' } else { 'inkbrowser-chrome' } } else { if ($isWindows) { 'inkbrowser-firefox.exe' } else { 'inkbrowser-firefox' } }
  $exe = Join-Path $root $exeName
  $manifestPath = Join-Path $root 'runtime.json'
  if (-not (Test-Path -LiteralPath $exe) -or -not (Test-Path -LiteralPath $manifestPath)) { return $false }
  try {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]$manifest.version -ne $version -or [string]$manifest.kind -ne $kind) { return $false }
    if (@($manifest.platforms) -notcontains $target) { return $false }
    if ($kind -eq 'chromium' -and $isWindows -and ([string]$manifest.distribution -ne 'source-built' -or $manifest.modified -ne $true)) { return $false }
    $expected = if ($manifest.executableSha256) { [string]$manifest.executableSha256 } else { [string]$manifest.sha256 }
    if ($expected -notmatch '^[0-9a-fA-F]{64}$') { return $false }
    $actual = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash
    return $actual.Equals($expected, [System.StringComparison]::OrdinalIgnoreCase)
  } catch { return $false }
}

# The setup broken into named steps. The console installer, the installer window and the
# work process (wizard-run) all walk exactly this list, so they can never drift apart.
# Only the first step (Node.js/git) is fatal, as in the console installer: when it fails the rest
# is not run. Required steps must succeed for the result to be ok; optional steps only add features.
function Get-SetupSteps {
  return @(
    @{ Key = 'stepPrereqs'; Required = $true; Fatal = $true; Action = {
        if (Test-GitCheckout) { return (ConvertTo-StepResult (Install-Prerequisites -GitRequired)) }
        return (ConvertTo-StepResult (Install-Prerequisites))
      } }
    @{ Key = 'stepMedia'; Required = $false; Fatal = $false; Action = { return (ConvertTo-StepResult (Install-MediaPrerequisites)) } }
    @{ Key = 'stepAndroid'; Required = $false; Fatal = $false; Action = { return (ConvertTo-StepResult (Install-AndroidPrerequisites)) } }
    @{ Key = 'stepSdk'; Required = $false; Fatal = $false; Action = {
        $ok = (ConvertTo-StepResult (Install-AndroidSdkComponents))
        Set-AndroidUserEnvironment (Get-AndroidInstallRoot)
        return $ok
      } }
    @{ Key = 'stepDeps'; Required = $true; Fatal = $false; Action = { [void](Invoke-EnsureDependencies); return $true } }
    @{ Key = 'stepRuntimes'; Required = $true; Fatal = $true; Action = {
        $target = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'win32-arm64' } else { 'win32-x64' }
        if ($env:OS -ne 'Windows_NT') { $target = 'linux-x64' }
        if ($target -notin @('win32-x64', 'linux-x64')) { Warn "Native runtimes are not staged for $target"; return $false }
        $stageChromium = if ($target -eq 'win32-x64') { 'stage:chromium:windows' } else { 'stage:chromium' }
        try {
          # Do not rebuild or overwrite an already verified runtime on every install.
          # Windows Chromium is source-built only; the stage script deliberately rejects
          # Chrome for Testing archives, so a missing runtime must remain a hard failure.
          if (-not (Test-NativeRuntimeReady 'chromium' $target)) {
            if ($target -eq 'win32-x64' -and -not (Ensure-ChromiumBuildToolchain)) { return $false }
            $previousDepotToolsUpdate = [Environment]::GetEnvironmentVariable('DEPOT_TOOLS_UPDATE', 'Process')
            try {
              # The Node source builder must not inherit a developer/system
              # DEPOT_TOOLS_UPDATE=1 and start another depot_tools self-update.
              $env:DEPOT_TOOLS_UPDATE = '0'
              Invoke-Npm @('run', $stageChromium)
            } finally {
              if ($null -eq $previousDepotToolsUpdate) { Remove-Item Env:DEPOT_TOOLS_UPDATE -ErrorAction SilentlyContinue }
              else { $env:DEPOT_TOOLS_UPDATE = $previousDepotToolsUpdate }
            }
          } else {
            Say 'Verified source-built Chromium runtime already present; reusing it.' 'Green'
          }
          # Firefox staging is intentionally disabled for this installer pass.
          # It must never block a usable Chromium installation or be silently
          # substituted with another engine; Firefox remains unavailable until
          # its verified runtime download path is repaired separately.
          Say 'Firefox runtime skipped for now; Chromium is the active native engine.' 'Yellow'
          $nodeExe = Resolve-Tool 'node'
          if (-not $nodeExe) { throw 'Node.js is unavailable for native runtime verification.' }
          $check = Invoke-Native $nodeExe @('tools\verify-native-engines.mjs', '--allow-missing-firefox') $InstallRoot
          if ($check.code -ne 0) { throw "Native Chromium verification failed with exit code $($check.code)." }
          return $true
        } catch { Warn $_.Exception.Message; return $false }
      } }
    @{ Key = 'stepShortcut'; Required = $false; Fatal = $false; Action = { return (ConvertTo-StepResult (New-DesktopShortcut)) } }
    @{ Key = 'stepBuild'; Required = $true; Fatal = $false; Action = {
        $built = (Test-Path -LiteralPath (Join-Path $InstallRoot 'apps\octobrowser\dist\main.js')) -and
                 (Test-Path -LiteralPath (Join-Path $InstallRoot 'apps\octodetect\dist\main.js'))
        if (-not $built) {
          Say (T 'ghBuilding')
          try {
            Invoke-Npm @('run', 'build')
          } catch {
            Warn "npm run build failed, attempting direct build with node: $($_.Exception.Message)"
            $nodeExe = Resolve-Tool 'node'
            $buildMjs = Join-Path $InstallRoot 'tools\build.mjs'
            if ($nodeExe -and (Test-Path -LiteralPath $buildMjs)) {
              $res = Invoke-Native $nodeExe @($buildMjs) $InstallRoot
              if ($res.code -ne 0) { Fail "build.mjs failed with code $($res.code)" }
            } else {
              throw
            }
          }
          Say (T 'setupBuilt') 'Green'
        }
        return $true
      } }
  )
}

# Opens the graphical installer. Returns its outcome ('ok', 'warn', 'failed' or 'cancelled')
# when the window ran, or $null when no window could be shown: the console path then runs.
function Show-InstallerWindow {
  $ui = Join-Path $ScriptsDir 'lib\octo-ui.ps1'
  if (-not (Test-Path -LiteralPath $ui)) { return $null }
  try {
    . $ui
    return (Show-SetupUi)
  } catch {
    Write-Log 'warn' "installer window unavailable: $($_.Exception.Message)"
    return $null
  }
}

function Invoke-Setup([switch]$Quiet) {
  if (-not (Test-DevCheckout)) { Fail (T 'noSources' $InstallRoot) }
  $steps = Get-SetupSteps
  $index = 0
  $requiredFailed = $false
  foreach ($step in $steps) {
    $index++
    Say (T 'stepOf' $index $steps.Count (T $step.Key)) 'Cyan'
    $ok = $false
    try { $ok = [bool](& $step.Action) } catch { Warn $_.Exception.Message; $ok = $false }
    # A fatal step cannot produce a usable installation. Do not continue into
    # shortcuts or an app build when the native runtime is missing.
    if (-not $ok -and $step.Key -eq 'stepPrereqs') { return $false }
    if (-not $ok -and $step.Fatal) { return $false }
    # Non-fatal steps still run, but setup is complete only when every required step succeeded.
    if (-not $ok -and $step.Required) { $requiredFailed = $true }
  }
  if ($requiredFailed) { return $false }
  if (-not $Quiet) { Say (T 'setupDone') 'Green' }
  return $true
}

function Invoke-FirstInstall {

  if (-not $NoGui -and -not $Interactive -and (Test-DevCheckout) -and -not $Source) {
    $outcome = Show-InstallerWindow
    if ($null -ne $outcome) { Resolve-WizardOutcome $outcome; return }
  }

  Say (T 'firstInstallStart') 'Cyan'
  $requiredFailed = $false
  $optionalFailed = $false
  if (-not (Test-DevCheckout)) {
    $dirs = @($Source, $ScriptsDir, $InstallRoot, (Join-Path $env:USERPROFILE 'Downloads'))
    $inst = Find-Installer $dirs
    if ($inst) {
      Invoke-Install
      return
    }
    Fail (T 'noSources' $InstallRoot)
  }
  $steps = Get-SetupSteps
  $index = 0
  foreach ($step in $steps) {
    $index++
    Say (T 'stepOf' $index $steps.Count (T $step.Key)) 'Cyan'
    $ok = $false
    try { $ok = [bool](& $step.Action) } catch { Warn $_.Exception.Message; $ok = $false }
    if (-not $ok) {
      if ($step.Key -eq 'stepPrereqs') { Fail (T 'prereqManual' 'Node.js / git') }
      # A fatal step stops the run. A failed required step fails the setup; a failed optional
      # step only leaves warnings. Success is shown only when neither happened.
      if ($step.Required) { $requiredFailed = $true } else { $optionalFailed = $true }
      if ($step.Fatal) { break }
    }
  }
  [void](New-DesktopShortcut)
  if ($requiredFailed) { Fail (T 'wizardFailed') }
  if (-not (Test-Ready)) { Fail (T 'wizardNotReady') }
  if ($optionalFailed) {
    Warn (T 'firstInstallIncomplete')
  } else {
    Say (T 'firstInstallSuccess') 'Green'
  }
}

# ------------------------------------------------ graphical installer support
# The installer window (octo-ui.ps1) hands its choices to the work process as OCTO_SETUP_*
# environment variables. Flags are '1' or '0'. The console installer never sets them, so
# it keeps its previous behaviour: the Android variables and PATH stay as they are.
function Get-SetupFlag([string]$name, [bool]$default) {
  $value = [Environment]::GetEnvironmentVariable("OCTO_SETUP_$name")
  if ($value -eq '1') { return $true }
  if ($value -eq '0') { return $false }
  return $default
}

# Choices made in the installer that the apps read when they start. Per user, in
# %APPDATA%\OctoSuite, so they do not depend on where the program files are.
function Get-InstallDefaultsPath {
  return (Join-Path (Join-Path $env:APPDATA 'OctoSuite') 'install-defaults.json')
}

function Read-InstallDefaults {
  $file = Get-InstallDefaultsPath
  if (-not (Test-Path -LiteralPath $file)) { return $null }
  try {
    $value = [System.IO.File]::ReadAllText($file, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($value.schema -eq 1) { return $value }
  } catch { }
  return $null
}

function Save-InstallDefaults([bool]$vmCompatibility) {
  $file = Get-InstallDefaultsPath
  $dir = Split-Path -Parent $file
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $record = [ordered]@{ schema = 1; vmCompatibility = $vmCompatibility; savedBy = 'installer' }
  [System.IO.File]::WriteAllText($file, ($record | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
}

# The version of the project this copy belongs to (package.json), shown in the installer.
function Get-SuiteVersion {
  try {
    $file = Join-Path $InstallRoot 'package.json'
    if (Test-Path -LiteralPath $file) {
      $version = [string]([System.IO.File]::ReadAllText($file, [System.Text.Encoding]::UTF8) | ConvertFrom-Json).version
      if ($version) { return $version }
    }
  } catch { }
  return '?'
}

# "host:port" or "http(s)://host:port" -> the normalised URL. '' when nothing was entered,
# $null when the text is not a plain proxy address. Credentials are refused: they would end
# up in the log and in the command line of the work process.
function ConvertTo-ProxyUrl([string]$text) {
  $value = ([string]$text).Trim()
  if (-not $value) { return '' }
  if ($value -notmatch '^(https?://)?[A-Za-z0-9.\-]+:\d{1,5}/?$') { return $null }
  $portText = [regex]::Match($value, ':(\d{1,5})/?$').Groups[1].Value
  $port = [int]$portText
  if ($port -lt 1 -or $port -gt 65535) { return $null }
  if ($value -notmatch '^https?://') { $value = 'http://' + $value }
  return $value.TrimEnd('/')
}

# The proxy is used by npm, git and the PowerShell downloads of this installation.
function Set-WizardProxy([string]$url) {
  foreach ($name in @('HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy')) {
    [Environment]::SetEnvironmentVariable($name, $url, 'Process')
  }
  try {
    [System.Net.WebRequest]::DefaultWebProxy = New-Object System.Net.WebProxy($url)
  } catch {
    Warn (T 'proxyFailed' $_.Exception.Message)
  }
  Say (T 'proxyUsed' $url) 'Cyan'
}

# Sets the Android SDK variables and the PATH entries for the current Windows account, when
# the installer window asked for them. Nothing is written when it did not.
function Set-AndroidUserEnvironment([string]$root) {
  if (-not $root -or -not (Test-Path -LiteralPath $root)) { return }
  if (Get-SetupFlag 'ENVVARS' $false) {
    foreach ($name in @('ANDROID_HOME', 'ANDROID_SDK_ROOT')) {
      [Environment]::SetEnvironmentVariable($name, $root, 'User')
      Set-Item -LiteralPath ('env:' + $name) -Value $root
    }
    Say (T 'envSet' $root) 'Cyan'
  }
  if (Get-SetupFlag 'PATH' $false) {
    $tools = @(@(
      (Join-Path $root 'platform-tools'),
      (Join-Path $root 'emulator'),
      (Join-Path $root 'cmdline-tools\latest\bin')
    ) | Where-Object { Test-Path -LiteralPath $_ })
    $entries = @()
    $current = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($current) { $entries = @($current.Split(';') | Where-Object { $_ }) }
    $added = @()
    foreach ($tool in $tools) {
      $known = @($entries | Where-Object { $_.TrimEnd('\') -ieq $tool.TrimEnd('\') })
      if ($known.Count -eq 0) { $entries += $tool; $added += $tool }
    }
    if ($added.Count -gt 0) {
      [Environment]::SetEnvironmentVariable('Path', ($entries -join ';'), 'User')
      Say (T 'pathAdded' ($added -join '; ')) 'Cyan'
    }
    Update-SessionPath
  }
}

# A step's result is the last value it produced, read as a boolean. Earlier output (a
# message, a process object) is ignored, so it can never turn a failure into a success.
function ConvertTo-StepResult($values) {
  $list = @($values)
  return ($list.Count -gt 0 -and [bool]$list[-1])
}

# Marker lines read by the installer window (see the header of scripts\lib\octo-ui.ps1).
function ConvertTo-MarkerText([string]$text) {
  return (([string]$text) -replace '[\r\n\t]+', ' ').Trim()
}

function Write-WizardMarker([string[]]$fields) {
  $parts = @('@@OCTO@@')
  foreach ($field in $fields) { $parts += (ConvertTo-MarkerText $field) }
  [Console]::Out.WriteLine(($parts -join "`t"))
  [Console]::Out.Flush()
}

# The work of the installer window, run in its own process (octo.ps1 wizard-run). It applies
# the window's choices, runs the steps in order and reports each one. Exit code 0 means every
# required step and the readiness check passed; 1 means the run stopped at a required step.
function Invoke-WizardRun {
  $script:WizardExit = 1
  $script:Yes = $true
  Write-WizardMarker @('log', $script:LogFile)
  $sdk = [string]$env:OCTO_SETUP_SDK
  if ($sdk) { Say (T 'uiFolderSet' $sdk) 'Cyan' }
  $proxy = [string]$env:OCTO_SETUP_PROXY
  if ($proxy) { Set-WizardProxy $proxy }
  try {
    Save-InstallDefaults (Get-SetupFlag 'VM' $false)
  } catch {
    Warn (T 'defaultsNotSaved' $_.Exception.Message)
  }
  $only = @()
  $wanted = [string]$env:OCTO_SETUP_STEPS
  if ($wanted) { $only = @($wanted.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
  $steps = @(Get-SetupSteps)
  $total = $steps.Count
  $index = 0
  $fatalAt = ''
  $requiredFailed = ''
  foreach ($step in $steps) {
    $index++
    if ($only.Count -gt 0 -and -not ($only -contains $step.Key)) { continue }
    if ($fatalAt) {
      Write-WizardMarker @('step', 'skip', $step.Key, $index, $total)
      continue
    }
    Write-WizardMarker @('step', 'start', $step.Key, $index, $total)
    $warningsBefore = $script:WarnCount
    $message = ''
    $ok = $false
    try {
      # The last value the step produced is its result; earlier output is ignored.
      $output = @(& $step.Action)
      $ok = ($output.Count -gt 0) -and [bool]$output[-1]
    } catch {
      $message = $_.Exception.Message
    }
    if (-not $ok) {
      if (-not $message) { $message = (T 'stepNotFinished') }
      Write-WizardMarker @('step', 'fail', $step.Key, $index, $total, $message)
      # Only the fatal step stops the run. Any other failure lets the run go on, so the steps
      # that can still succeed do (a failed Electron download, for example, does not stop the
      # build). A failed required step makes the result failed; an optional one only warns.
      if ($step.Required -and -not $requiredFailed) { $requiredFailed = [string]$step.Key }
      if ($step.Fatal) { $fatalAt = [string]$step.Key }
    } elseif ($script:WarnCount -gt $warningsBefore) {
      Write-WizardMarker @('step', 'warn', $step.Key, $index, $total)
    } else {
      Write-WizardMarker @('step', 'done', $step.Key, $index, $total)
    }
  }
  if (-not $fatalAt -and -not $requiredFailed -and -not (Test-Ready)) {
    Warn (T 'wizardNotReady')
    $requiredFailed = 'ready'
  }
  if ($requiredFailed) {
    Write-WizardMarker @('result', 'failed', $requiredFailed)
    $script:WizardExit = 1
    return
  }
  Write-WizardMarker @('result', 'ok', '-')
  $script:WizardExit = 0
}

# Turns the outcome of the installer window into the result of the command line.
function Resolve-WizardOutcome([string]$outcome) {
  if ($outcome -eq 'failed') { Fail (T 'wizardFailed') }
  if ($outcome -eq 'cancelled') { Stop-Cancelled }
}

# Everything that must be true before the apps can start from sources.
function Test-Ready {
  Update-SessionPath
  $node = Get-ToolVersion 'node'
  if (-not $node -or $node -lt [version]'22.12.0') { return $false }
  if (-not (Test-Path -LiteralPath (Join-Path $InstallRoot 'node_modules\.bin\electron.cmd')) -and -not (Test-Path -LiteralPath (Join-Path $InstallRoot 'node_modules\electron\dist\electron.exe'))) { return $false }
  foreach ($a in @('octobrowser', 'octodetect')) {
    if (-not (Test-Path -LiteralPath (Join-Path $InstallRoot "apps\$a\dist\main.js"))) { return $false }
  }
  $target = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'win32-arm64' } else { 'win32-x64' }
  if ($env:OS -ne 'Windows_NT') { $target = 'linux-x64' }
  if (-not (Test-NativeRuntimeReady 'chromium' $target)) { return $false }
  # Firefox is intentionally not part of the current install pass. Do not let
  # its deferred runtime block a verified Chromium installation.
  return $true
}

# run.bat has no visible window, so it can neither show progress nor ask anything.
# When something is missing, the setup is started in a normal console the user can see.
function Start-VisibleSetup {
  $bat = Join-Path $ScriptsDir 'setup.bat'
  if (-not (Test-Path -LiteralPath $bat)) { Fail (T 'fileMissing' $bat) }
  Say (T 'runSetupVisible') 'Cyan'
  $noPause = $env:OCTO_NOPAUSE
  $hidden = $env:OCTO_HIDDEN
  [Environment]::SetEnvironmentVariable('OCTO_NOPAUSE', $null)
  [Environment]::SetEnvironmentVariable('OCTO_HIDDEN', $null)
  try {
    $p = Start-Process -FilePath $env:ComSpec -ArgumentList @('/c', ('"' + $bat + '" -Yes')) -Wait -PassThru
    return ($p.ExitCode -eq 0)
  } finally {
    if ($noPause) { $env:OCTO_NOPAUSE = $noPause }
    if ($hidden) { $env:OCTO_HIDDEN = $hidden }
  }
}

# run.bat: make sure the apps can start, then start both of them with no console window.
function Invoke-Run {
  $script:UpdateFirst = [bool]$Update
  if (-not (Test-Path -LiteralPath (Get-AppExe 'octobrowser'))) {
    if (-not (Test-DevCheckout)) { Fail (T 'noSources' $InstallRoot) }
    if (-not (Test-Ready)) {
      $setupOk = Invoke-Setup
      if (-not $setupOk -or -not (Test-Ready)) {
        if (-not (Start-VisibleSetup)) { return }
        if (-not (Test-Ready)) { Fail (T 'notBuilt') }
      }
    }
    if ($script:UpdateFirst -and (Test-GitCheckout)) {
      try { Update-DevCheckout } catch { Warn (T 'updateFailed' $_.Exception.Message); $script:FailShown = $false }
    }
  }
  # An installed build updates itself from inside the app (it can show a window for that).
  Say (T 'startAll') 'Cyan'
  $script:Rest = @()
  Invoke-Open 'octobrowser'
  Start-Sleep -Milliseconds 800
  Invoke-Open 'octodetect'
}

# ------------------------------------------------------ GitHub update (github-update.bat)
# Two modes:
#   * installed build  -> read the newest GitHub release through the REST API, verify it
#                         (signed manifest when published, otherwise SHA256SUMS.txt +
#                         Authenticode + an explicit typed confirmation) and install it;
#   * development copy -> git pull --ff-only + npm ci (only when the lockfile changed) + npm run build.
# Only the official repository is contacted; any other host is refused.
$OfficialApi = "https://api.github.com/repos/$OfficialRepo"

# True when the scripts sit inside the OctoSuite source tree. A ZIP downloaded from GitHub
# has no .git folder, so git must NOT be part of this test (only github-update needs it).
function Test-DevCheckout {
  foreach ($f in @('package.json', 'tools\build.mjs', 'apps\octobrowser\package.json', 'apps\octodetect\package.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $InstallRoot $f))) { return $false }
  }
  return $true
}

# True only for a real git clone (github-update can fast-forward it).
function Test-GitCheckout {
  return ((Test-DevCheckout) -and (Test-Path -LiteralPath (Join-Path $InstallRoot '.git')))
}

function Get-GithubJson([string]$url) {
  if (-not $url.StartsWith("$OfficialApi/")) { Fail (T 'urlNotOfficial' $url) }
  Set-Tls
  $headers = @{ 'User-Agent' = 'OctoSuite-scripts'; 'Accept' = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28' }
  $old = $ProgressPreference; $ProgressPreference = 'SilentlyContinue'
  try { return (Invoke-RestMethod -Uri $url -Headers $headers -UseBasicParsing -MaximumRedirection 5 -TimeoutSec 30) }
  finally { $ProgressPreference = $old }
}

# Newest published release (a pre-release is used only when there is no stable one).
function Get-GithubLatestRelease {
  try { return (Get-GithubJson "$OfficialApi/releases/latest") } catch { Write-Log 'warn' "releases/latest: $($_.Exception.Message)" }
  try {
    $all = @(Get-GithubJson "$OfficialApi/releases?per_page=10" | Where-Object { -not $_.draft })
    if ($all.Count -gt 0) { return $all[0] }
  } catch { Write-Log 'warn' "releases: $($_.Exception.Message)" }
  return $null
}

function Get-ReleaseAsset($release, [string]$pattern) {
  foreach ($a in @($release.assets)) {
    if ([string]$a.name -match $pattern) { return $a }
  }
  return $null
}

# Downloads a release asset after checking its name and that the URL is an official release URL.
function Save-ReleaseAsset($asset, [string]$dir) {
  if ([string]$asset.name -notmatch '^[\w.-]+$') { Fail 'invalid asset name in the GitHub release' }
  $dest = Join-Path $dir ([string]$asset.name)
  Invoke-Download ([string]$asset.browser_download_url) $dest
  return $dest
}

function Invoke-Npm([string[]]$npmArgs) {
  $npm = Resolve-Tool 'npm'
  if (-not $npm) { Fail (T 'ghNpmMissing') }
  $r = Invoke-Native $npm $npmArgs $InstallRoot
  if ($r.code -ne 0) {
    # Keep the tail of the output in the log so a failed install can be diagnosed later.
    foreach ($line in @($r.text -split "`r?`n" | Select-Object -Last 20)) { Write-Log 'error' $line }
    Fail (T 'ghNpmFailed' ($npmArgs -join ' ') $r.code)
  }
}

function Invoke-Git([string[]]$gitArgs) {
  $git = Resolve-Tool 'git'
  if (-not $git) { Fail (T 'ghGitMissing') }
  return (Invoke-Native $git (@('-C', $InstallRoot) + $gitArgs) $null -Quiet)
}

function Update-DevCheckout {
  Say (T 'ghDevDetected' $InstallRoot) 'Cyan'
  $status = Invoke-Git @('status', '--porcelain')
  if ($status.code -ne 0) { Fail $status.text }
  if ($status.text) { Fail (T 'ghGitDirty') }
  $before = (Invoke-Git @('rev-parse', '--short', 'HEAD')).text
  Say (T 'checking' "https://github.com/$OfficialRepo") 'Cyan'
  $pull = Invoke-Git @('pull', '--ff-only')
  if ($pull.code -ne 0) { Fail $pull.text }
  Write-Log 'info' $pull.text
  $after = (Invoke-Git @('rev-parse', '--short', 'HEAD')).text
  $changed = ($after -ne $before)
  if (-not $changed) { Say (T 'ghGitUpToDate' $after) 'Green' } else { Say (T 'ghGitPulled' $before $after) 'Green' }
  if ($CheckOnly) { return }
  # Dependencies follow the pulled manifests: only changed ones are installed.
  [void](Invoke-EnsureDependencies)
  $built = (Test-Path -LiteralPath (Join-Path $InstallRoot 'apps\octobrowser\dist\main.js')) -and
           (Test-Path -LiteralPath (Join-Path $InstallRoot 'apps\octodetect\dist\main.js'))
  if ($changed -or -not $built) {
    Say (T 'ghBuilding')
    Invoke-Npm @('run', 'build')
  }
  Say (T 'ghDevDone') 'Green'
}

function Update-InstalledFromGithub {
  $exe = Get-AppExe 'octobrowser'
  $installed = [string](Get-Item -LiteralPath $exe).VersionInfo.ProductVersion
  Say (T 'ghChecking' $OfficialBase) 'Cyan'
  $release = Get-GithubLatestRelease
  if (-not $release) { Say (T 'ghNoRelease') 'Yellow'; return }
  $version = ([string]$release.tag_name) -replace '^v', ''
  if ($version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') { Fail "invalid release tag: $($release.tag_name)" }
  Say (T 'ghLatest' $version ([string]$release.published_at))
  $newer = $false
  try { $newer = ([version]($version -replace '-.*$', '')) -gt ([version]($installed -replace '-.*$', '')) } catch { $newer = ($version -ne $installed) }
  if (-not $newer) { Say (T 'upToDate' $installed $version) 'Green'; return }
  $severity = 'recommended'
  if ($release.prerelease) { $severity = 'optional' }
  Say (T 'updateAvailable' $installed $version $severity) 'Cyan'
  if ($release.body) { Write-Host ([string]$release.body) }
  if ($CheckOnly) { return }
  if (-not (Confirm-Action '')) { Stop-Cancelled }

  $setup = Get-ReleaseAsset $release '^OctoSuite-Setup-.+\.exe$'
  if (-not $setup) { Fail (T 'ghNoAsset') }
  $work = Join-Path $env:TEMP ('OctoSuite-gh-{0}' -f [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $work -Force | Out-Null
  try {
    $installer = Save-ReleaseAsset $setup $work
    $manifestAsset = Get-ReleaseAsset $release '^latest\.json$'
    $sigAsset = Get-ReleaseAsset $release '^latest\.json\.sig$'
    if ($manifestAsset -and $sigAsset) {
      $manifest = Save-ReleaseAsset $manifestAsset $work
      Save-ReleaseAsset $sigAsset $work | Out-Null
      Assert-ManifestResult (Invoke-ManifestVerify $manifest $installer)
    } else {
      Warn (T 'noManifest')
      $sums = Get-ReleaseAsset $release '^SHA256SUMS\.txt$'
      if ($sums) { Save-ReleaseAsset $sums $work | Out-Null }
      Test-Sha256Sums $installer
      if (-not (Confirm-Word (T 'ghUnverifiedAsk') @('YES', 'TAK'))) { Stop-Cancelled }
    }
    Test-Authenticode $installer
    Assert-NotRunning @('octobrowser', 'octodetect')
    Backup-Configs (Get-Date -Format 'yyyyMMdd-HHmmss')
    $bs = Read-Bootstrap 'octobrowser'
    if ($bs) {
      $keep = Join-Path ([string]$bs.dataDir) 'updater\installed'
      New-Item -ItemType Directory -Path $keep -Force | Out-Null
      Copy-Item -LiteralPath $installer -Destination (Join-Path $keep ('{0}.exe' -f $version)) -Force
      Get-ChildItem -LiteralPath $keep -Filter '*.exe' -File | Sort-Object LastWriteTime -Descending | Select-Object -Skip 3 | Remove-Item -Force -ErrorAction SilentlyContinue
      Say (T 'keptForRollback' $keep)
    }
    Invoke-Installer $installer -Silent
    Say (T 'done') 'Green'
  } finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-GithubUpdate {
  if (Test-Path -LiteralPath (Get-AppExe 'octobrowser')) { Update-InstalledFromGithub; return }
  if (Test-GitCheckout) { Update-DevCheckout; return }
  # Sources without .git (ZIP download): there is nothing to pull, but we can still
  # make sure everything is installed and built.
  if (Test-DevCheckout) { Warn (T 'ghNoGitDir'); if (-not (Invoke-Setup)) { Fail (T 'wizardFailed') }; return }
  Fail (T 'notInstalled' 'Octo.su' $InstallRoot)
}

# ------------------------------------------------------ start both apps (start-all.bat)
function Invoke-StartAll {
  if ($NoUpdate) {
    Say (T 'updateSkipped')
  } else {
    try {
      Invoke-GithubUpdate
    } catch [System.OperationCanceledException] {
      Say (T 'cancelled') 'Yellow'
    } catch {
      Warn (T 'updateFailed' $_.Exception.Message)
    }
    # An update problem must never stop the apps from starting.
    $script:FailShown = $false
  }
  Say (T 'startAll') 'Cyan'
  $script:Rest = @()
  Invoke-Open 'octobrowser'
  Start-Sleep -Milliseconds 800
  Invoke-Open 'octodetect'
  Say (T 'done') 'Green'
}

# ------------------------------------------------------------------ main
$exitCode = 0
$script:FailShown = $false
try {
  Initialize-Log
  Write-Log 'info' ("start lang={0} ps={1}" -f $Lang, $PSVersionTable.PSVersion)
  switch ($Command.ToLowerInvariant()) {
    'open' { Invoke-Open 'octobrowser' }
    'open-detect' { Invoke-Open 'octodetect' }
    'install' {
      # Installing is unattended unless -Interactive was passed: no y/N stops.
      if (-not $Interactive) { $script:Yes = $true }
      # In a source checkout the graphical installer is the default face; the
      # console path stays available with -NoGui and is used automatically when
      # WinForms is unavailable (Server Core, PowerShell without a desktop).
      $outcome = $null
      if (-not $NoGui -and -not $Interactive -and (Test-DevCheckout) -and -not $Source) { $outcome = Show-InstallerWindow }
      if ($null -ne $outcome) { Resolve-WizardOutcome $outcome } else { Invoke-Install }
    }
    'setup' {
      if (-not $Interactive) { $script:Yes = $true }
      if (-not (Invoke-Setup)) { Fail (T 'wizardFailed') }
    }
    'wizard-run' {
      # Internal: the work of the graphical installer (scripts\lib\octo-ui.ps1), one step at a time.
      $script:Yes = $true
      Invoke-WizardRun
      $exitCode = $script:WizardExit
    }
    'first-install' {
      if (-not $Interactive) { $script:Yes = $true }
      Invoke-FirstInstall
    }
    'firstinstall' {
      if (-not $Interactive) { $script:Yes = $true }
      Invoke-FirstInstall
    }
    'run' {
      if (-not $Interactive) { $script:Yes = $true }
      Invoke-Run
    }
    'update' { Invoke-Update }
    'github-update' { Invoke-GithubUpdate }
    'start-all' { Invoke-StartAll }
    'repair' { Invoke-Repair }
    'uninstall' { Invoke-Uninstall }
    'reset-profile' { Invoke-ResetProfile }
    'backup-profile' { Invoke-BackupProfile }
    'restore-profile' { Invoke-RestoreProfile }
    default { Fail (T 'unknownCommand' $Command) }
  }
} catch [System.OperationCanceledException] {
  $exitCode = 2
} catch {
  $exitCode = 1
  if (-not $script:FailShown) {
    Write-Host (T 'error' $_.Exception.Message) -ForegroundColor Red
    Write-Log 'error' $_.Exception.Message
  }
} finally {
  if ($script:LogFile -and $Command -notmatch '^(open|run$)') { Write-Host (T 'logAt' (Protect-LogText $script:LogFile)) -ForegroundColor DarkGray }
  Write-Log 'info' "end code=$exitCode"
}
exit $exitCode
