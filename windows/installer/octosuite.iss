; installer/octosuite.iss
;
; Inno Setup 6 script for the OctoSuite installer (Octo.su + OctoDetect.su).
; Built by `npm run installer` (tools/build-installer.mjs), which passes:
;   /DAppVersion=<x.y.z>  /DRepoRoot=<repository root>  [/DSign=1 /Soctosign=...]
;
; Design:
;  * Per-user install by default ({localappdata}\Programs\OctoSuite) - NO administrator
;    rights needed. A per-machine install can be chosen in the privileges dialog.
;  * Both apps are installed side by side: {app}\OctoBrowser and {app}\OctoDetect
;    (each app finds the other through ..\<Other>\<Other>.su.exe).
;  * User data is NOT inside {app}; it lives in the folder chosen at first run
;    (default Documents\OctoSuite) and is never removed by the uninstaller.
;  * Running apps are closed through the Windows Restart Manager before files are replaced.
;  * The same installer file is the update package referenced by latest.json.

#ifndef AppVersion
  #error AppVersion must be defined (/DAppVersion=x.y.z)
#endif
#ifndef RepoRoot
  #define RepoRoot ".."
#endif

#define SuiteName "OctoSuite"
#define Publisher "OctoSuite contributors"
#define RepoUrl "https://github.com/chargehuobey/lvocto"

[Setup]
; Fixed AppId - never change it, otherwise upgrades install side by side.
AppId={{6B0E7C1A-3D4F-4E8B-9C2A-0C7A5D1E8F42}
AppName={#SuiteName}
AppVersion={#AppVersion}
AppVerName={#SuiteName} {#AppVersion}
AppPublisher={#Publisher}
AppPublisherURL={#RepoUrl}
AppSupportURL={#RepoUrl}/issues
AppUpdatesURL={#RepoUrl}/releases
DefaultDirName={autopf}\{#SuiteName}
DefaultGroupName={#SuiteName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputDir={#RepoRoot}\release
OutputBaseFilename={#SuiteName}-Setup-{#AppVersion}
SetupIconFile={#RepoRoot}\branding\suite\installer.ico
UninstallDisplayIcon={app}\OctoBrowser\Octo.su.exe
UninstallDisplayName={#SuiteName} (Octo.su, OctoDetect.su)
LicenseFile={#RepoRoot}\LICENSE
; Classic wizard layout with dark OctoSuite artwork. Silent update invocations
; remain quiet and do not show the post-install launch page.
WizardStyle=classic
WizardImageFile={#RepoRoot}\branding\suite\installer-wizard.bmp
WizardSmallImageFile={#RepoRoot}\branding\suite\installer-wizard-small.bmp
WizardImageStretch=no
WizardResizable=no
Compression=lzma2/ultra64
SolidCompression=yes
CloseApplications=yes
CloseApplicationsFilter=*.exe
RestartApplications=no
SetupLogging=yes
VersionInfoVersion={#AppVersion}
VersionInfoProductName={#SuiteName}
VersionInfoDescription={#SuiteName} Setup
#ifdef Sign
SignTool=octosign
SignedUninstaller=yes
#endif

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"
Name: "pl"; MessagesFile: "compiler:Languages\Polish.isl"

[CustomMessages]
en.DesktopIcons=Create desktop shortcuts
en.Protocol=Open octobrowser:// links with Octo.su
en.LaunchBrowser=Start Octo.su
en.LaunchDetect=Start OctoDetect.su
en.DataKept=Your profiles and settings are stored in the data folder you chose at first run (default: Documents\OctoSuite). They were NOT removed. Use scripts\uninstall.bat before uninstalling if you also want to delete them.
en.ScriptsGroup=Maintenance scripts
en.StartAll=Start both apps (with update)
en.RunQuiet=Start both apps (no console window)
en.GithubUpdate=Update from GitHub
pl.DesktopIcons=Utwórz skróty na pulpicie
pl.Protocol=Otwieraj linki octobrowser:// w Octo.su
pl.LaunchBrowser=Uruchom Octo.su
pl.LaunchDetect=Uruchom OctoDetect.su
pl.DataKept=Twoje profile i ustawienia znajdują się w folderze danych wybranym przy pierwszym uruchomieniu (domyślnie: Dokumenty\OctoSuite). NIE zostały usunięte. Jeśli chcesz je również usunąć, przed odinstalowaniem użyj scripts\uninstall.bat.
pl.ScriptsGroup=Skrypty serwisowe
pl.StartAll=Uruchom obie aplikacje (z aktualizacją)
pl.RunQuiet=Uruchom obie aplikacje (bez okna konsoli)
pl.GithubUpdate=Aktualizuj z GitHub

[Tasks]
Name: "desktopicons"; Description: "{cm:DesktopIcons}"; Flags: unchecked
Name: "protocol"; Description: "{cm:Protocol}"

[Files]
; Application folders produced by electron-builder (`npm run dist`).
Source: "{#RepoRoot}\release\octobrowser\win-unpacked\*"; DestDir: "{app}\OctoBrowser"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#RepoRoot}\release\octodetect\win-unpacked\*"; DestDir: "{app}\OctoDetect"; Flags: ignoreversion recursesubdirs createallsubdirs
; Maintenance scripts and licenses.
Source: "{#RepoRoot}\scripts\*.bat"; DestDir: "{app}\scripts"; Flags: ignoreversion
Source: "{#RepoRoot}\scripts\lib\*"; DestDir: "{app}\scripts\lib"; Flags: ignoreversion recursesubdirs
Source: "{#RepoRoot}\licenses\*"; DestDir: "{app}\licenses"; Flags: ignoreversion recursesubdirs
Source: "{#RepoRoot}\LICENSE"; DestDir: "{app}"; Flags: ignoreversion

[InstallDelete]
; Remove files of the previous version that no longer exist (the app folders are fully owned by us).
Type: filesandordirs; Name: "{app}\OctoBrowser\resources"
Type: filesandordirs; Name: "{app}\OctoDetect\resources"

[Icons]
; Keep direct launch links in the folder a user opens after installation, not
; only in Start Menu. The target executables supply their own branded icons.
Name: "{app}\Start Octo.su"; Filename: "{app}\OctoBrowser\Octo.su.exe"; WorkingDir: "{app}\OctoBrowser"; IconFilename: "{app}\OctoBrowser\Octo.su.exe"; AppUserModelID: "su.octo.browser"
Name: "{app}\Start OctoDetect.su"; Filename: "{app}\OctoDetect\OctoDetect.su.exe"; WorkingDir: "{app}\OctoDetect"; IconFilename: "{app}\OctoDetect\OctoDetect.su.exe"; AppUserModelID: "su.octo.detect"
Name: "{group}\Octo.su"; Filename: "{app}\OctoBrowser\Octo.su.exe"; WorkingDir: "{app}\OctoBrowser"; AppUserModelID: "su.octo.browser"
Name: "{group}\OctoDetect.su"; Filename: "{app}\OctoDetect\OctoDetect.su.exe"; WorkingDir: "{app}\OctoDetect"; AppUserModelID: "su.octo.detect"
Name: "{group}\{cm:RunQuiet}"; Filename: "{app}\scripts\run.bat"; WorkingDir: "{app}\scripts"; IconFilename: "{app}\OctoBrowser\Octo.su.exe"
Name: "{group}\{cm:StartAll}"; Filename: "{app}\scripts\start-all.bat"; WorkingDir: "{app}\scripts"; IconFilename: "{app}\OctoBrowser\Octo.su.exe"
Name: "{group}\{cm:GithubUpdate}"; Filename: "{app}\scripts\github-update.bat"; WorkingDir: "{app}\scripts"; IconFilename: "{app}\OctoDetect\OctoDetect.su.exe"
Name: "{group}\{cm:ScriptsGroup}"; Filename: "{app}\scripts"
Name: "{group}\{cm:UninstallProgram,{#SuiteName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Octo.su"; Filename: "{app}\OctoBrowser\Octo.su.exe"; WorkingDir: "{app}\OctoBrowser"; Tasks: desktopicons
Name: "{autodesktop}\OctoDetect.su"; Filename: "{app}\OctoDetect\OctoDetect.su.exe"; WorkingDir: "{app}\OctoDetect"; Tasks: desktopicons

[Registry]
; octobrowser:// deep links (open?profile=<id|name>). Per-user when installed per-user.
Root: HKA; Subkey: "Software\Classes\octobrowser"; ValueType: string; ValueName: ""; ValueData: "URL:Octo.su"; Flags: uninsdeletekey; Tasks: protocol
Root: HKA; Subkey: "Software\Classes\octobrowser"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""; Tasks: protocol
Root: HKA; Subkey: "Software\Classes\octobrowser\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: """{app}\OctoBrowser\Octo.su.exe"",0"; Tasks: protocol
Root: HKA; Subkey: "Software\Classes\octobrowser\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\OctoBrowser\Octo.su.exe"" ""%1"""; Tasks: protocol

[Run]
; Start the primary browser by default after a normal installation. OctoDetect
; remains available as an optional second launch and is deliberately unchecked.
Filename: "{app}\OctoBrowser\Octo.su.exe"; Description: "{cm:LaunchBrowser}"; Flags: nowait postinstall skipifsilent runasoriginaluser
Filename: "{app}\OctoDetect\OctoDetect.su.exe"; Description: "{cm:LaunchDetect}"; Flags: nowait postinstall skipifsilent unchecked runasoriginaluser
; In-app updates run Setup with /SILENT /RELAUNCH=<app id>: start that app again afterwards.
Filename: "{app}\OctoBrowser\Octo.su.exe"; Flags: nowait runasoriginaluser; Check: RelaunchRequested('octobrowser')
Filename: "{app}\OctoDetect\OctoDetect.su.exe"; Flags: nowait runasoriginaluser; Check: RelaunchRequested('octodetect')

[UninstallDelete]
; Only program files. User data (profiles, settings, logs) lives elsewhere and is kept.
Type: filesandordirs; Name: "{app}\OctoBrowser"
Type: filesandordirs; Name: "{app}\OctoDetect"
Type: filesandordirs; Name: "{app}\scripts"

[Code]
procedure InitializeWizard;
begin
  { Match the classic wizard surfaces to the black artwork. }
  WizardForm.Color := $000A0A0C;
  WizardForm.Font.Color := clWhite;
  WizardForm.InnerNotebook.Color := $000A0A0C;
  WizardForm.OuterNotebook.Color := $000A0A0C;
  WizardForm.WizardBitmapImage.Visible := True;
  WizardForm.WizardSmallBitmapImage.Visible := True;
end;

{ True when Setup was started with /RELAUNCH=<AppId> (by the in-app updater). }
function RelaunchRequested(AppId: String): Boolean;
begin
  Result := CompareText(ExpandConstant('{param:RELAUNCH|}'), AppId) = 0;
end;

{ Tell the user that their data is kept after uninstalling. }
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if (CurUninstallStep = usPostUninstall) and (not UninstallSilent) then
    MsgBox(CustomMessage('DataKept'), mbInformation, MB_OK);
end;
