# scripts/lib/octo-ui.ps1
#
# The graphical installer for install.bat and first-install.bat in a source checkout:
# a classic setup wizard built with Windows Forms (Windows PowerShell 5.1, built into
# Windows 10/11). Dot-sourced by octo.ps1.
#
# Pages: 1 Install OctoSuite (setup options), 2 What will be installed, 3 installation
# progress, 4 the result. The installation runs in its own Windows PowerShell process
# (octo.ps1 wizard-run), which applies the chosen options and runs the same steps as the
# console installer. The window therefore stays responsive, Cancel really stops the work,
# and every step reports itself with a marker line:
#   @@OCTO@@<TAB>step<TAB>start|done|warn|fail|skip<TAB><step key><TAB><n><TAB><total>[<TAB><message>]
#   @@OCTO@@<TAB>result<TAB>ok|failed<TAB><step key, ready, or ->
#   @@OCTO@@<TAB>log<TAB><log file>
# Any other line goes to the detailed log. A run is shown as finished only after a
# result 'ok' marker and exit code 0. A process that ends without a result counts as failed.

Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue

# Human ETA from the steps done so far. Deliberately coarse: it is an estimate.
function Format-Eta([timespan]$elapsed, [int]$done, [int]$total) {
  if ($done -le 0 -or $done -ge $total) { return '' }
  $perStep = $elapsed.TotalSeconds / $done
  $left = [TimeSpan]::FromSeconds([Math]::Max(1, [Math]::Round($perStep * ($total - $done))))
  if ($left.TotalHours -ge 1) { return ('{0}h {1:00}m' -f [int]$left.TotalHours, $left.Minutes) }
  if ($left.TotalMinutes -ge 1) { return ('{0}m {1:00}s' -f [int]$left.TotalMinutes, $left.Seconds) }
  return ('{0}s' -f [int]$left.TotalSeconds)
}

# Hides the console this script was started from.
Add-Type -Name OctoConsoleWindow -Namespace Octo -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow();
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr window, int command);
'@ -ErrorAction SilentlyContinue

function Set-ConsoleVisible([bool]$visible) {
  try {
    $window = [Octo.OctoConsoleWindow]::GetConsoleWindow()
    if ($window -eq [System.IntPtr]::Zero) { return }
    # 0 = SW_HIDE, 5 = SW_SHOW.
    [void][Octo.OctoConsoleWindow]::ShowWindow($window, $(if ($visible) { 5 } else { 0 }))
  } catch { }
}

# The process runner behind the installation pages. Output lines are queued from
# background callbacks and read by the window timer on the UI thread.
function Add-WizardRunnerType {
  if ('Octo.SetupRunner' -as [type]) { return }
  Add-Type -ReferencedAssemblies 'System' -TypeDefinition @'
using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using System.Threading;

namespace Octo
{
    public sealed class SetupRunner
    {
        private readonly ConcurrentQueue<string> _lines = new ConcurrentQueue<string>();
        private Process _process;
        private int _openStreams;

        public bool Start(string fileName, string arguments, string workingDirectory, IDictionary environment)
        {
            var info = new ProcessStartInfo(fileName, arguments);
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            // Input is redirected and closed at once: a prompt that nobody can answer reads
            // end-of-file instead of waiting forever in a window without a console.
            info.RedirectStandardInput = true;
            info.StandardOutputEncoding = Encoding.UTF8;
            info.StandardErrorEncoding = Encoding.UTF8;
            info.WorkingDirectory = workingDirectory;
            if (environment != null)
            {
                foreach (DictionaryEntry entry in environment)
                {
                    info.EnvironmentVariables[(string)entry.Key] = entry.Value == null ? null : entry.Value.ToString();
                }
            }
            _process = new Process();
            _process.StartInfo = info;
            _openStreams = 2;
            _process.OutputDataReceived += OnData;
            _process.ErrorDataReceived += OnData;
            _process.Start();
            _process.StandardInput.Close();
            _process.BeginOutputReadLine();
            _process.BeginErrorReadLine();
            return true;
        }

        private void OnData(object sender, DataReceivedEventArgs e)
        {
            if (e.Data == null)
            {
                Interlocked.Decrement(ref _openStreams);
                return;
            }
            _lines.Enqueue(e.Data);
        }

        public bool TryReadLine(out string line)
        {
            return _lines.TryDequeue(out line);
        }

        // True once the process has exited and both of its output streams are closed.
        public bool Finished
        {
            get { return _process != null && _process.HasExited && Thread.VolatileRead(ref _openStreams) <= 0; }
        }

        public int ExitCode
        {
            get { return _process == null ? -1 : _process.ExitCode; }
        }

        // Ends the process and everything it started (winget, npm, installers it launched).
        public void KillTree()
        {
            if (_process == null || _process.HasExited) return;
            try
            {
                var kill = new ProcessStartInfo("taskkill.exe", "/PID " + _process.Id + " /T /F");
                kill.UseShellExecute = false;
                kill.CreateNoWindow = true;
                using (var killer = Process.Start(kill)) { killer.WaitForExit(15000); }
            }
            catch (Exception) { }
            try { if (!_process.HasExited) _process.Kill(); } catch (Exception) { }
        }
    }
}
'@
}

# ------------------------------------------------------------- look and feel
function Get-WizColors {
  return @{
    Surface = [System.Drawing.Color]::FromArgb(15, 15, 19)
    Panel   = [System.Drawing.Color]::FromArgb(24, 24, 31)
    Footer  = [System.Drawing.Color]::FromArgb(10, 10, 14)
    Border  = [System.Drawing.Color]::FromArgb(55, 55, 68)
    Text    = [System.Drawing.Color]::FromArgb(240, 240, 246)
    Muted   = [System.Drawing.Color]::FromArgb(158, 158, 176)
    Accent  = [System.Drawing.Color]::FromArgb(139, 92, 246)
    Done    = [System.Drawing.Color]::FromArgb(52, 211, 153)
    Warn    = [System.Drawing.Color]::FromArgb(251, 191, 36)
    Fail    = [System.Drawing.Color]::FromArgb(248, 113, 113)
    Run     = [System.Drawing.Color]::FromArgb(96, 165, 250)
  }
}

function New-WizLabel([string]$text, [int]$x, [int]$y, [int]$w, [int]$h, [System.Drawing.Color]$color, $font) {
  $label = New-Object System.Windows.Forms.Label
  $label.Text = $text
  $label.SetBounds($x, $y, $w, $h)
  $label.ForeColor = $color
  if ($font) { $label.Font = $font }
  return $label
}

function New-WizButton([string]$text, [int]$x, [int]$y, [int]$w, [bool]$primary, $colors) {
  $button = New-Object System.Windows.Forms.Button
  $button.Text = $text
  $button.SetBounds($x, $y, $w, 30)
  $button.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
  $button.UseVisualStyleBackColor = $false
  if ($primary) {
    $button.BackColor = $colors.Accent
    $button.ForeColor = [System.Drawing.Color]::White
    $button.FlatAppearance.BorderSize = 0
  } else {
    $button.BackColor = $colors.Surface
    $button.ForeColor = $colors.Text
    $button.FlatAppearance.BorderColor = $colors.Border
  }
  return $button
}

function New-WizLink([string]$text, [int]$x, [int]$y, [int]$w, [int]$h, $colors) {
  $link = New-Object System.Windows.Forms.LinkLabel
  $link.Text = $text
  $link.SetBounds($x, $y, $w, $h)
  $link.LinkColor = $colors.Accent
  $link.ActiveLinkColor = $colors.Accent
  $link.Visible = $false
  return $link
}

function New-WizStepColumns([System.Windows.Forms.ListView]$list) {
  $list.View = [System.Windows.Forms.View]::Details
  $list.FullRowSelect = $true
  $list.GridLines = $false
  $list.HeaderStyle = [System.Windows.Forms.ColumnHeaderStyle]::Nonclickable
  $list.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
  [void]$list.Columns.Add((T 'uiColStep'), 368)
  [void]$list.Columns.Add((T 'uiColType'), 130)
  [void]$list.Columns.Add((T 'uiColStatus'), 190)
}

# Runs an event action without letting an error close the window.
function Invoke-WizSafely([scriptblock]$action) {
  try { & $action } catch {
    Add-WizLogLine ('! ' + $_.Exception.Message)
    Write-Log 'error' $_.Exception.Message
  }
}

# ------------------------------------------------------------- layout
function Build-WizLayout([string]$version) {
  $ui = $script:Ui
  $c = $ui.Colors
  $form = $ui.Form
  $titleFont = New-Object System.Drawing.Font('Segoe UI', 14, [System.Drawing.FontStyle]::Bold)
  $boldFont = New-Object System.Drawing.Font('Segoe UI', 9.5, [System.Drawing.FontStyle]::Bold)
  $logFont = New-Object System.Drawing.Font('Consolas', 9)

  # Header: page title and subtitle on the left, the program version on the right.
  $header = New-Object System.Windows.Forms.Panel
  $header.SetBounds(0, 0, 760, 84)
  $header.BackColor = $c.Surface
  $form.Controls.Add($header)
  $ui.HeaderTitle = New-WizLabel '' 24 14 480 26 $c.Text $titleFont
  $ui.HeaderSub = New-WizLabel '' 24 44 712 34 $c.Muted $null
  $ui.VersionLabel = New-WizLabel (T 'uiVersion' $version) 500 16 170 20 $c.Muted $null
  $ui.VersionLabel.TextAlign = [System.Drawing.ContentAlignment]::MiddleRight
  $header.Controls.Add($ui.HeaderTitle)
  $header.Controls.Add($ui.HeaderSub)
  $header.Controls.Add($ui.VersionLabel)
  # The OctoSuite icon, when the branding files are present (they are in a source checkout).
  if ($form.Icon) {
    $logo = New-Object System.Windows.Forms.PictureBox
    $logo.SetBounds(684, 14, 52, 52)
    $logo.SizeMode = [System.Windows.Forms.PictureBoxSizeMode]::Zoom
    $logo.Image = $form.Icon.ToBitmap()
    $header.Controls.Add($logo)
  }
  $accent = New-Object System.Windows.Forms.Panel
  $accent.SetBounds(0, 84, 760, 3)
  $accent.BackColor = $c.Accent
  $form.Controls.Add($accent)

  # Pages share one area between the header and the footer.
  foreach ($number in 1..4) {
    $page = New-Object System.Windows.Forms.Panel
    $page.SetBounds(0, 88, 760, 440)
    $page.BackColor = $c.Surface
    $page.Visible = ($number -eq 1)
    $form.Controls.Add($page)
    $ui.Pages[$number] = $page
  }

  # Footer with the wizard buttons.
  $rule = New-Object System.Windows.Forms.Panel
  $rule.SetBounds(0, 528, 760, 1)
  $rule.BackColor = $c.Border
  $form.Controls.Add($rule)
  $footer = New-Object System.Windows.Forms.Panel
  $footer.SetBounds(0, 529, 760, 71)
  $footer.BackColor = $c.Footer
  $form.Controls.Add($footer)
  $ui.Back = New-WizButton (T 'uiBack') 396 21 100 $false $c
  $ui.Next = New-WizButton (T 'uiNext') 504 21 100 $true $c
  $ui.Cancel = New-WizButton (T 'uiCancel') 620 21 116 $false $c
  $footer.Controls.Add($ui.Back)
  $footer.Controls.Add($ui.Next)
  $footer.Controls.Add($ui.Cancel)

  # ---- Page 1: Install OctoSuite (setup options)
  $p1 = $ui.Pages[1]
  $p1.Controls.Add((New-WizLabel (T 'uiConfigDesc') 24 14 712 20 $c.Text $null))
  $p1.Controls.Add((New-WizLabel (T 'uiFolder') 24 44 712 18 $c.Text $null))
  $ui.Sdk = New-Object System.Windows.Forms.TextBox
  $ui.Sdk.SetBounds(24, 66, 572, 24)
  $ui.Sdk.Text = [string](Get-AndroidInstallRoot)
  $ui.Sdk.BackColor = $c.Panel
  $ui.Sdk.ForeColor = $c.Text
  $p1.Controls.Add($ui.Sdk)
  $ui.Browse = New-WizButton (T 'uiBrowse') 606 65 130 $false $c
  $p1.Controls.Add($ui.Browse)
  $p1.Controls.Add((New-WizLabel (T 'uiFolderHint') 24 94 712 18 $c.Muted $null))

  $group = New-Object System.Windows.Forms.GroupBox
  $group.Text = (T 'uiOptionalSettings')
  $group.SetBounds(24, 122, 712, 206)
  $group.ForeColor = $c.Text
  $group.BackColor = $c.Surface
  $p1.Controls.Add($group)
  $group.Controls.Add((New-WizLabel (T 'uiProxyServer') 16 28 320 18 $c.Text $null))
  $ui.Proxy = New-Object System.Windows.Forms.TextBox
  $ui.Proxy.SetBounds(16, 48, 360, 24)
  $ui.Proxy.BackColor = $c.Panel
  $ui.Proxy.ForeColor = $c.Text
  $group.Controls.Add($ui.Proxy)
  $group.Controls.Add((New-WizLabel (T 'uiProxyHint') 16 76 680 18 $c.Muted $null))
  $ui.EnvVars = New-Object System.Windows.Forms.CheckBox
  $ui.EnvVars.Text = (T 'uiEnvVars')
  $ui.EnvVars.Checked = $true
  $ui.EnvVars.SetBounds(16, 106, 680, 22)
  $ui.EnvVars.BackColor = $c.Surface
  $ui.EnvVars.ForeColor = $c.Text
  $group.Controls.Add($ui.EnvVars)
  $ui.AddPath = New-Object System.Windows.Forms.CheckBox
  $ui.AddPath.Text = (T 'uiAddPath')
  $ui.AddPath.Checked = $true
  $ui.AddPath.SetBounds(16, 130, 680, 22)
  $ui.AddPath.BackColor = $c.Surface
  $ui.AddPath.ForeColor = $c.Text
  $group.Controls.Add($ui.AddPath)
  $ui.Vm = New-Object System.Windows.Forms.CheckBox
  $ui.Vm.Text = (T 'uiVmMode')
  $ui.Vm.Checked = (Get-WizVmDefault)
  $ui.Vm.SetBounds(16, 154, 680, 22)
  $ui.Vm.BackColor = $c.Surface
  $ui.Vm.ForeColor = $c.Text
  $group.Controls.Add($ui.Vm)
  # The tooltip states the scope: the choice applies only to OctoSuite launches.
  $ui.VmTip = New-Object System.Windows.Forms.ToolTip
  $ui.VmTip.AutoPopDelay = 15000
  $ui.VmTip.SetToolTip($ui.Vm, (T 'uiVmTip'))
  $vmNote = ''
  if (Test-VirtualMachineHardware) { $vmNote = (T 'uiVmAuto') }
  $group.Controls.Add((New-WizLabel $vmNote 36 178 660 18 $c.Muted $null))
  $ui.Error = New-WizLabel '' 24 340 712 36 $c.Fail $null
  $p1.Controls.Add($ui.Error)
  $p1.Controls.Add((New-WizLabel (T 'uiAccountHint') 24 384 712 36 $c.Muted $null))

  # ---- Page 2: What will be installed
  $p2 = $ui.Pages[2]
  $ui.Refresh = New-WizButton (T 'uiStatusCheck') 556 6 180 $false $c
  $p2.Controls.Add($ui.Refresh)
  $ui.Cards = New-Object System.Windows.Forms.Panel
  $ui.Cards.SetBounds(24, 44, 712, 384)
  $ui.Cards.AutoScroll = $true
  $ui.Cards.BackColor = $c.Panel
  $p2.Controls.Add($ui.Cards)

  # ---- Page 3: installation progress
  $p3 = $ui.Pages[3]
  $ui.StepNow = New-WizLabel (T 'uiReady') 24 8 712 20 $c.Text $boldFont
  $ui.Bar = New-Object System.Windows.Forms.ProgressBar
  $ui.Bar.SetBounds(24, 34, 600, 22)
  $ui.Bar.Minimum = 0
  $ui.Bar.Maximum = 100
  $ui.Bar.Value = 0
  $p3.Controls.Add($ui.Bar)
  $ui.Pct = New-WizLabel '0%' 634 32 102 24 $c.Text $null
  $ui.Pct.TextAlign = [System.Drawing.ContentAlignment]::MiddleRight
  $p3.Controls.Add($ui.Pct)
  $ui.Eta = New-WizLabel '' 24 62 712 18 $c.Muted $null
  $p3.Controls.Add($ui.Eta)
  $ui.StepList = New-Object System.Windows.Forms.ListView
  $ui.StepList.SetBounds(24, 86, 712, 176)
  $ui.StepList.Font = New-Object System.Drawing.Font('Segoe UI', 9)
  $ui.StepList.BackColor = $c.Panel
  $ui.StepList.ForeColor = $c.Text
  New-WizStepColumns $ui.StepList
  $p3.Controls.Add($ui.StepList)
  $p3.Controls.Add((New-WizLabel (T 'uiLogTitle') 24 272 360 18 $c.Text $boldFont))
  $ui.LogLink = New-WizLink (T 'uiOpenLog') 560 272 176 18 $c
  $p3.Controls.Add($ui.LogLink)
  $ui.Log = New-Object System.Windows.Forms.TextBox
  $ui.Log.Multiline = $true
  $ui.Log.ReadOnly = $true
  $ui.Log.ScrollBars = [System.Windows.Forms.ScrollBars]::Vertical
  $ui.Log.SetBounds(24, 294, 712, 138)
  $ui.Log.BackColor = $c.Panel
  $ui.Log.ForeColor = $c.Text
  $ui.Log.Font = $logFont
  $p3.Controls.Add($ui.Log)

  # ---- Page 4: the result
  $p4 = $ui.Pages[4]
  $ui.Summary = New-WizLabel '' 24 14 712 60 $c.Text $null
  $p4.Controls.Add($ui.Summary)
  $ui.Outcome = New-Object System.Windows.Forms.ListView
  $ui.Outcome.SetBounds(24, 84, 712, 214)
  $ui.Outcome.Font = New-Object System.Drawing.Font('Segoe UI', 9)
  $ui.Outcome.BackColor = $c.Panel
  $ui.Outcome.ForeColor = $c.Text
  New-WizStepColumns $ui.Outcome
  $p4.Controls.Add($ui.Outcome)
  $ui.StartApp = New-Object System.Windows.Forms.CheckBox
  $ui.StartApp.Text = (T 'uiStartWhenDone')
  $ui.StartApp.Checked = $true
  $ui.StartApp.SetBounds(24, 316, 712, 22)
  $ui.StartApp.BackColor = $c.Surface
  $ui.StartApp.ForeColor = $c.Text
  $p4.Controls.Add($ui.StartApp)
  $ui.DoneLog = New-WizLink (T 'uiOpenLog') 24 346 200 18 $c
  $p4.Controls.Add($ui.DoneLog)
  $ui.LogPathLabel = New-WizLabel '' 24 368 712 36 $c.Muted $null
  $p4.Controls.Add($ui.LogPathLabel)

  # Timer that drains the runner's output on the UI thread.
  $ui.Timer = New-Object System.Windows.Forms.Timer
  $ui.Timer.Interval = 150

  # Event handlers.
  $ui.Browse.Add_Click({ Invoke-WizSafely { Invoke-WizBrowse } })
  $ui.Refresh.Add_Click({ Invoke-WizSafely { Show-WizCards } })
  $ui.Back.Add_Click({ Invoke-WizSafely { Invoke-WizBack } })
  $ui.Next.Add_Click({ Invoke-WizSafely { Invoke-WizNext } })
  $ui.Cancel.Add_Click({ Invoke-WizSafely { Invoke-WizCancel } })
  $ui.LogLink.Add_LinkClicked({ Open-WizLog })
  $ui.DoneLog.Add_LinkClicked({ Open-WizLog })
  $ui.Timer.Add_Tick({ Invoke-WizSafely { Invoke-WizTick } })
  $form.Add_FormClosing({ param($sender, $closing) try { Confirm-WizClose $closing } catch { Write-Log 'error' $_.Exception.Message } })
}

function Show-WizPage([int]$page) {
  $script:Wiz.Page = $page
  foreach ($number in 1..4) { $script:Ui.Pages[$number].Visible = ($number -eq $page) }
  Update-WizHeader
  Update-WizFooter
}

function Update-WizHeader {
  $page = [int]$script:Wiz.Page
  if ($page -eq 1) {
    $script:Ui.HeaderTitle.Text = (T 'uiHeading')
    $script:Ui.HeaderSub.Text = (T 'uiIntro')
  } elseif ($page -eq 2) {
    $script:Ui.HeaderTitle.Text = (T 'uiTabComponents')
    $script:Ui.HeaderSub.Text = (T 'uiComponentsSubtitle')
  } elseif ($page -eq 3) {
    $script:Ui.HeaderTitle.Text = (T 'uiPageInstalling')
    $script:Ui.HeaderSub.Text = (T 'uiRunSub')
  }
}

# Button captions, visibility and enabled state for the current page and run state.
function Update-WizFooter {
  $ui = $script:Ui
  $page = [int]$script:Wiz.Page
  $outcome = [string]$script:Wiz.Outcome
  $ui.Back.Visible = $true
  $ui.Next.Visible = $true
  $ui.Cancel.Visible = $true
  $ui.Back.Enabled = $false
  $ui.Next.Enabled = $true
  $ui.Cancel.Enabled = $true
  if ($page -eq 1) {
    $ui.Next.Text = (T 'uiNext')
    $ui.Cancel.Text = (T 'uiCancel')
  } elseif ($page -eq 2) {
    $ui.Back.Enabled = $true
    $ui.Next.Text = (T 'uiInstall')
    $ui.Cancel.Text = (T 'uiCancel')
  } elseif ($page -eq 3) {
    $ui.Next.Visible = $false
    $ui.Cancel.Text = (T 'uiCancel')
    $ui.Cancel.Enabled = (-not $script:Wiz.Cancelling)
  } elseif ($page -eq 4) {
    if ($outcome -eq 'ok' -or $outcome -eq 'warn') {
      $ui.Back.Visible = $false
      $ui.Cancel.Visible = $false
      $ui.Next.Text = (T 'uiFinish')
    } else {
      $ui.Back.Enabled = $true
      $ui.Next.Text = (T 'uiRetry')
      $ui.Cancel.Text = (T 'uiClose')
    }
  }
  $ui.Form.AcceptButton = $(if ($ui.Next.Visible) { $ui.Next } else { $null })
  $ui.Form.CancelButton = $(if ($ui.Cancel.Visible) { $ui.Cancel } else { $null })
}

# ------------------------------------------------------------- page 1 and 2
# Checks the options before the first step starts. Shows the reason on the page and
# returns $false when something must be changed.
function Test-WizOptions {
  $ui = $script:Ui
  $sdk = ([string]$ui.Sdk.Text).Trim()
  if ($sdk) {
    $writable = $false
    if ([System.IO.Path]::IsPathRooted($sdk)) { $writable = Test-FolderWritable $sdk }
    if (-not $writable) {
      $ui.Error.Text = (T 'uiFolderNotWritable' $sdk)
      return $false
    }
  }
  $proxy = ConvertTo-ProxyUrl $ui.Proxy.Text
  if ($null -eq $proxy) {
    $ui.Error.Text = (T 'uiProxyBad')
    return $false
  }
  $ui.Error.Text = ''
  $script:Wiz.Sdk = $sdk
  $script:Wiz.Proxy = [string]$proxy
  $script:Wiz.EnvVars = [bool]$ui.EnvVars.Checked
  $script:Wiz.AddPath = [bool]$ui.AddPath.Checked
  $script:Wiz.Vm = [bool]$ui.Vm.Checked
  return $true
}

function Test-WizTool([string]$name, [string]$minimum) {
  $version = Get-ToolVersion $name
  return [bool]($version -and $version -ge [version]$minimum)
}

function Test-WizMediaTool([string]$id) {
  $tool = @($MediaPrereqs | Where-Object { $_.Id -eq $id }) | Select-Object -First 1
  if (-not $tool) { return $false }
  try { return [bool](& $tool.Test) } catch { return $false }
}

# The components the installer sets up, in the order of the page. Required components
# stop the installation when they are missing; optional ones only add features.
function Get-WizComponents {
  $sdkFolder = $script:Wiz.Sdk
  if (-not $sdkFolder) { $sdkFolder = Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
  return @(
    @{ Name = (T 'compNodeName'); Desc = (T 'compNodeDesc'); Loc = 'C:\Program Files\nodejs\'; Url = 'https://nodejs.org/en/download'; Required = $true; Installed = (Test-WizTool 'node' '22.12.0') },
    @{ Name = (T 'compGitName'); Desc = (T 'compGitDesc'); Loc = 'C:\Program Files\Git\'; Url = 'https://git-scm.com/download/win'; Required = $true; Installed = (Test-WizTool 'git' '2.40.0') },
    @{ Name = (T 'compAdbName'); Desc = (T 'compAdbDesc'); Loc = $sdkFolder; Url = 'https://developer.android.com/studio'; Required = $false; Installed = (Test-WizTool 'adb' '1.0.0') },
    @{ Name = (T 'compPythonName'); Desc = (T 'compPythonDesc'); Loc = '%LOCALAPPDATA%\Programs\Python\'; Url = 'https://www.python.org/downloads/windows/'; Required = $false; Installed = (Test-WizMediaTool 'Python.Python.3.12') },
    @{ Name = (T 'compObsName'); Desc = (T 'compObsDesc'); Loc = 'C:\Program Files\obs-studio\'; Url = 'https://obsproject.com/download'; Required = $false; Installed = (Test-WizMediaTool 'OBSProject.OBSStudio') },
    @{ Name = (T 'compVbName'); Desc = (T 'compVbDesc'); Loc = 'C:\Program Files\VB\CABLE\'; Url = 'https://vb-audio.com/Cable/'; Required = $false; Installed = (Test-WizMediaTool 'VB-Audio.Cable') },
    @{ Name = (T 'compAppName'); Desc = (T 'compAppDesc'); Loc = '%LOCALAPPDATA%\OctoSuite\'; Url = "https://github.com/$OfficialRepo"; Required = $true; Installed = [bool](Test-Ready) }
  )
}

function Show-WizCards {
  $form = $script:Ui.Form
  $cursor = $form.Cursor
  $form.Cursor = [System.Windows.Forms.Cursors]::WaitCursor
  try {
    Update-SessionPath
    Render-WizCards
  } finally {
    $form.Cursor = $cursor
  }
}

function Render-WizCards {
  $ui = $script:Ui
  $c = $ui.Colors
  $boldFont = New-Object System.Drawing.Font('Segoe UI', 9.5, [System.Drawing.FontStyle]::Bold)
  $ui.Cards.SuspendLayout()
  $ui.Cards.Controls.Clear()
  $y = 6
  foreach ($item in (Get-WizComponents)) {
    $card = New-Object System.Windows.Forms.Panel
    $card.SetBounds(6, $y, 684, 84)
    $card.BackColor = $c.Surface
    $card.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
    $card.Controls.Add((New-WizLabel $item.Name 12 8 500 20 $c.Text $boldFont))
    if ($item.Required) { $tagText = (T 'uiRequired'); $tagColor = $c.Accent } else { $tagText = (T 'uiOptional'); $tagColor = $c.Muted }
    $tag = New-WizLabel $tagText 500 8 166 20 $tagColor $null
    $tag.TextAlign = [System.Drawing.ContentAlignment]::MiddleRight
    $card.Controls.Add($tag)
    if ($item.Installed) { $badgeText = (T 'uiStatusInstalled'); $badgeColor = $c.Done } else { $badgeText = (T 'uiStatusMissing'); $badgeColor = $c.Warn }
    $card.Controls.Add((New-WizLabel $badgeText 12 30 300 18 $badgeColor $null))
    $card.Controls.Add((New-WizLabel ('{0}  {1}: {2}' -f $item.Desc, (T 'uiLocation'), $item.Loc) 12 50 660 16 $c.Muted $null))
    $link = New-WizLink $item.Url 12 66 660 16 $c
    $link.Text = [string]$item.Url
    $link.Tag = [string]$item.Url
    $link.Visible = $true
    $link.Add_LinkClicked({ param($sender, $e) Invoke-WizLinkOpen $sender })
    $card.Controls.Add($link)
    $ui.Cards.Controls.Add($card)
    $y += 92
  }
  $ui.Cards.ResumeLayout()
}

function Invoke-WizLinkOpen($link) {
  try { Start-Process -FilePath ([string]$link.Tag) } catch { }
}

function Invoke-WizBrowse {
  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.Description = (T 'uiFolder')
  try { if ($script:Ui.Sdk.Text) { $dialog.SelectedPath = $script:Ui.Sdk.Text } } catch { }
  if ($dialog.ShowDialog($script:Ui.Form) -eq [System.Windows.Forms.DialogResult]::OK) {
    $script:Ui.Sdk.Text = $dialog.SelectedPath
  }
}

# ------------------------------------------------------------- navigation
function Invoke-WizNext {
  $page = [int]$script:Wiz.Page
  if ($page -eq 1) {
    if (Test-WizOptions) {
      Show-WizCards
      Show-WizPage 2
    }
    return
  }
  if ($page -eq 2) {
    $keys = @($script:Wiz.Steps | ForEach-Object { $_.Key })
    foreach ($step in $script:Wiz.Steps) { $step.Status = 'waiting'; $step.Message = '' }
    Start-WizRun $keys
    return
  }
  if ($page -eq 4) {
    if ($script:Wiz.Outcome -eq 'ok' -or $script:Wiz.Outcome -eq 'warn') {
      $script:Wiz.StartApp = [bool]$script:Ui.StartApp.Checked
      $script:Ui.Form.Close()
      return
    }
    # Retry: every step that did not finish successfully runs again; finished ones stay.
    $keys = @($script:Wiz.Steps | Where-Object { $_.Status -ne 'done' } | ForEach-Object { $_.Key })
    foreach ($step in $script:Wiz.Steps) {
      if ($keys -contains $step.Key) { $step.Status = 'waiting'; $step.Message = '' }
    }
    Start-WizRun $keys
  }
}

function Invoke-WizBack {
  $page = [int]$script:Wiz.Page
  if ($page -eq 2) { Show-WizPage 1 }
  if ($page -eq 4 -and -not ($script:Wiz.Outcome -eq 'ok' -or $script:Wiz.Outcome -eq 'warn')) { Show-WizPage 1 }
}

function Invoke-WizCancel {
  $page = [int]$script:Wiz.Page
  if ($page -eq 3) {
    if ($script:Wiz.Runner -and (Confirm-WizStop)) { Stop-WizRun }
    return
  }
  # Before the installation starts, or on the result page, Cancel and Close leave the window.
  if ($page -ne 4) { $script:Wiz.Outcome = 'cancelled' }
  $script:Ui.Form.Close()
}

function Confirm-WizStop {
  $answer = [System.Windows.Forms.MessageBox]::Show($script:Ui.Form, (T 'uiStopAsk'), (T 'uiTitle'),
    [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Question)
  return ($answer -eq [System.Windows.Forms.DialogResult]::Yes)
}

# Closing the window during a run asks first, and then stops the work.
function Confirm-WizClose($closing) {
  if ($null -eq $script:Wiz.Runner) { return }
  if (Confirm-WizStop) {
    Stop-WizRun
    $script:Wiz.Outcome = 'cancelled'
  } else {
    $closing.Cancel = $true
  }
}

function Open-WizLog {
  $path = [string]$script:Wiz.LogPath
  if ($path -and (Test-Path -LiteralPath $path)) { try { Start-Process -FilePath $path } catch { } }
}

# ------------------------------------------------------------- running the steps
function Add-WizLogLine([string]$text) {
  $log = $script:Ui.Log
  $log.AppendText($text + [Environment]::NewLine)
  $log.SelectionStart = $log.TextLength
  $log.ScrollToCaret()
}

# Splits a marker line into its tab-separated fields; $null for an ordinary output line.
function ConvertFrom-WizardMarker([string]$line) {
  if (-not $line.StartsWith("@@OCTO@@`t", [System.StringComparison]::Ordinal)) { return $null }
  return [string[]]($line.Split([char]9))
}

function Get-WizStatusText($step) {
  switch ([string]$step.Status) {
    'running' { return (T 'uiStRun') }
    'done' { return (T 'uiStDone') }
    'warn' { return (T 'uiStWarn') }
    'fail' { return (T 'uiStFail') }
    'skip' { return (T 'uiStSkip') }
    'stopped' { return (T 'uiStStopped') }
    default { return (T 'uiStWait') }
  }
}

function Get-WizStatusColor($step) {
  $c = $script:Ui.Colors
  switch ([string]$step.Status) {
    'running' { return $c.Run }
    'done' { return $c.Done }
    'warn' { return $c.Warn }
    'fail' { return $c.Fail }
    default { return $c.Muted }
  }
}

function Render-WizStepList([System.Windows.Forms.ListView]$list) {
  $list.BeginUpdate()
  $list.Items.Clear()
  foreach ($step in $script:Wiz.Steps) {
    if ($step.Required) { $type = (T 'uiRequired') } else { $type = (T 'uiOptional') }
    $item = New-Object System.Windows.Forms.ListViewItem ([string](T $step.Key))
    [void]$item.SubItems.Add($type)
    [void]$item.SubItems.Add((Get-WizStatusText $step))
    $item.ForeColor = (Get-WizStatusColor $step)
    [void]$list.Items.Add($item)
  }
  $list.EndUpdate()
}

function Update-WizProgress {
  $ui = $script:Ui
  $steps = @($script:Wiz.Steps)
  $total = [Math]::Max(1, $steps.Count)
  $completed = @($steps | Where-Object { $_.Status -eq 'done' -or $_.Status -eq 'warn' }).Count
  $percent = [int][Math]::Floor(100 * $completed / $total)
  $ui.Bar.Value = [Math]::Max(0, [Math]::Min(100, $percent))
  $ui.Pct.Text = ('{0}%' -f $ui.Bar.Value)
  $elapsed = [timespan]::Zero
  if ($script:Wiz.Watch) { $elapsed = $script:Wiz.Watch.Elapsed }
  $eta = Format-Eta $elapsed ([int]$script:Wiz.RunDone) ([int]$script:Wiz.RunTotal)
  if ($eta) { $ui.Eta.Text = (T 'uiEta' $eta) } else { $ui.Eta.Text = (T 'uiElapsed' ([int]$elapsed.TotalSeconds)) }
}

function Start-WizRun([string[]]$keys) {
  $script:Wiz.RunTotal = @($keys).Count
  $script:Wiz.RunDone = 0
  $script:Wiz.ReportedOk = $false
  $script:Wiz.ReportedKey = ''
  $script:Wiz.Cancelling = $false
  $script:Wiz.Outcome = $null
  $script:Wiz.Watch = [System.Diagnostics.Stopwatch]::StartNew()
  Add-WizLogLine ''
  Add-WizLogLine ('---- ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ----')
  Show-WizPage 3
  Render-WizStepList $script:Ui.StepList
  Update-WizProgress

  $exe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  if (-not (Test-Path -LiteralPath $exe)) { $exe = 'powershell.exe' }
  $octoScript = Join-Path $ScriptsDir 'lib\octo.ps1'
  $argLine = '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + $octoScript + '" wizard-run -Yes -NoGui -Lang ' + $Lang
  $settings = @{
    OCTO_SETUP_SDK = [string]$script:Wiz.Sdk
    OCTO_SETUP_PROXY = [string]$script:Wiz.Proxy
    OCTO_SETUP_ENVVARS = $(if ($script:Wiz.EnvVars) { '1' } else { '0' })
    OCTO_SETUP_PATH = $(if ($script:Wiz.AddPath) { '1' } else { '0' })
    OCTO_SETUP_VM = $(if ($script:Wiz.Vm) { '1' } else { '0' })
    OCTO_SETUP_STEPS = ($keys -join ',')
  }
  $runner = New-Object Octo.SetupRunner
  try {
    [void]$runner.Start($exe, $argLine, $InstallRoot, $settings)
  } catch {
    Add-WizLogLine (T 'wizardStartFailed' $_.Exception.Message)
    $script:Wiz.Outcome = 'failed'
    Show-WizCompletion
    return
  }
  $script:Wiz.Runner = $runner
  $script:Ui.Timer.Start()
}

function Stop-WizRun {
  if ($null -eq $script:Wiz.Runner) { return }
  $script:Wiz.Cancelling = $true
  $script:Ui.StepNow.Text = (T 'uiStopping')
  $script:Ui.Cancel.Enabled = $false
  try { $script:Wiz.Runner.KillTree() } catch { Add-WizLogLine $_.Exception.Message }
}

function Invoke-WizTick {
  $runner = $script:Wiz.Runner
  if ($null -eq $runner) {
    $script:Ui.Timer.Stop()
    return
  }
  $line = $null
  while ($runner.TryReadLine([ref]$line)) { Read-WizLine ([string]$line) }
  if ($runner.Finished) { Complete-WizRun }
}

function Read-WizLine([string]$line) {
  $fields = ConvertFrom-WizardMarker $line
  if ($null -eq $fields) {
    Add-WizLogLine $line
    return
  }
  switch ([string]$fields[1]) {
    'step' { Update-WizStepFromMarker $fields }
    'result' {
      $script:Wiz.ReportedOk = ([string]$fields[2] -eq 'ok')
      $script:Wiz.ReportedKey = [string]$fields[3]
    }
    'log' {
      $script:Wiz.LogPath = [string]$fields[2]
      $script:Ui.LogLink.Visible = $true
    }
  }
}

function Update-WizStepFromMarker([string[]]$fields) {
  $kind = [string]$fields[2]
  $key = [string]$fields[3]
  $index = [int]$fields[4]
  $total = [int]$fields[5]
  $message = ''
  if ($fields.Count -gt 6) { $message = [string]$fields[6] }
  $step = @($script:Wiz.Steps | Where-Object { $_.Key -eq $key }) | Select-Object -First 1
  if (-not $step) { return }
  switch ($kind) {
    'start' {
      $step.Status = 'running'
      $script:Ui.StepNow.Text = (T 'stepOf' $index $total (T $key))
    }
    'done' { $step.Status = 'done'; $script:Wiz.RunDone++ }
    'warn' { $step.Status = 'warn'; $script:Wiz.RunDone++ }
    'skip' { $step.Status = 'skip'; $script:Wiz.RunDone++ }
    'fail' {
      $step.Status = 'fail'
      $step.Message = $message
      $script:Wiz.RunDone++
      if ($message) { Add-WizLogLine ('! ' + (T $key) + ': ' + $message) }
    }
  }
  Render-WizStepList $script:Ui.StepList
  Update-WizProgress
}

# The run has ended. Success needs a result 'ok' marker and exit code 0; anything else is
# a failure, and a stop requested by the user is reported as cancelled.
function Complete-WizRun {
  $runner = $script:Wiz.Runner
  $script:Ui.Timer.Stop()
  $exitCode = -1
  if ($runner) { $exitCode = $runner.ExitCode }
  $script:Wiz.Runner = $null
  $outcome = 'failed'
  if ($script:Wiz.Cancelling) {
    $outcome = 'cancelled'
  } elseif ($script:Wiz.ReportedOk -and $exitCode -eq 0) {
    $optional = @($script:Wiz.Steps | Where-Object { $_.Status -eq 'warn' -or $_.Status -eq 'fail' })
    if ($optional.Count -gt 0) { $outcome = 'warn' } else { $outcome = 'ok' }
  }
  $script:Wiz.Outcome = $outcome
  Show-WizCompletion
}

function Show-WizCompletion {
  $ui = $script:Ui
  $outcome = [string]$script:Wiz.Outcome
  $names = @()
  foreach ($step in $script:Wiz.Steps) {
    if ($step.Status -eq 'fail' -or ($outcome -eq 'warn' -and $step.Status -eq 'warn')) { $names += (T $step.Key) }
  }
  $names = @($names)
  if ($outcome -eq 'ok') {
    $title = (T 'uiPageDone')
    $summary = (T 'uiDoneSummary')
  } elseif ($outcome -eq 'warn') {
    $title = (T 'uiPageWarnings')
    $summary = (T 'uiWarnSummary' ($names -join '; '))
  } elseif ($outcome -eq 'cancelled') {
    $title = (T 'uiPageCancelled')
    $summary = (T 'uiCancelledSummary')
  } else {
    $title = (T 'uiPageFailed')
    if ($names.Count -gt 0) { $reason = ($names -join '; ') } else { $reason = (T 'wizardNotReady') }
    $summary = (T 'uiFailedSummary' $reason)
  }
  $ui.HeaderTitle.Text = $title
  $ui.HeaderSub.Text = (T 'uiCompleteSub')
  $ui.Summary.Text = $summary
  Render-WizStepList $ui.Outcome
  $ui.StartApp.Visible = ($outcome -eq 'ok' -or $outcome -eq 'warn')
  $hasLog = [bool]$script:Wiz.LogPath
  $ui.DoneLog.Visible = $hasLog
  if ($hasLog) { $ui.LogPathLabel.Text = (T 'logAt' $script:Wiz.LogPath) } else { $ui.LogPathLabel.Text = '' }
  Show-WizPage 4
}

# ------------------------------------------------------------- the window
function Get-WizVmDefault {
  $stored = Read-InstallDefaults
  if ($stored -and $null -ne $stored.vmCompatibility) { return [bool]$stored.vmCompatibility }
  return [bool](Test-VirtualMachine)
}

# Opens the wizard. Returns the outcome ('ok', 'warn', 'failed' or 'cancelled') when the
# window ran, or $null when no window could be shown, so the console path takes over.
function Show-SetupUi {
  if (-not ('System.Windows.Forms.Form' -as [type])) { return $null }
  try { Add-WizardRunnerType } catch {
    Write-Log 'warn' "installer runner unavailable: $($_.Exception.Message)"
    return $null
  }

  $script:Ui = @{ Colors = (Get-WizColors); Pages = @{} }
  $script:Wiz = @{
    Page = 1; Runner = $null; Watch = $null; Cancelling = $false; Outcome = $null
    ReportedOk = $false; ReportedKey = ''; LogPath = ''; StartApp = $false
    Sdk = ''; Proxy = ''; EnvVars = $true; AddPath = $true; Vm = $false
    RunTotal = 0; RunDone = 0; Steps = @()
  }
  $script:Wiz.Steps = @(Get-SetupSteps | ForEach-Object {
    [pscustomobject]@{ Key = [string]$_.Key; Required = [bool]$_.Required; Status = 'waiting'; Message = '' }
  })

  try {
    $form = New-Object System.Windows.Forms.Form
    $form.Text = (T 'uiTitle')
    $form.ClientSize = New-Object System.Drawing.Size(760, 600)
    $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
    $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
    $form.MaximizeBox = $false
    $form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::None
    $form.BackColor = $script:Ui.Colors.Surface
    $form.Font = New-Object System.Drawing.Font('Segoe UI', 9)
    $icon = Join-Path $InstallRoot 'branding\suite\installer.ico'
    if (Test-Path -LiteralPath $icon) { try { $form.Icon = New-Object System.Drawing.Icon($icon) } catch { } }
    $script:Ui.Form = $form
    Build-WizLayout (Get-SuiteVersion)
    Show-WizPage 1
  } catch {
    Write-Log 'warn' "installer window unavailable: $($_.Exception.Message)"
    return $null
  }

  # From here on the window is open: any failure is reported in it, never by a second run.
  Set-ConsoleVisible $false
  try {
    [void]$script:Ui.Form.ShowDialog()
  } catch {
    Write-Log 'error' "installer window stopped: $($_.Exception.Message)"
    if ($script:Wiz.Runner) { try { $script:Wiz.Runner.KillTree() } catch { } }
    $script:Wiz.Outcome = 'failed'
  } finally {
    $script:Ui.Timer.Stop()
    $script:Ui.Timer.Dispose()
    $script:Ui.Form.Dispose()
    Set-ConsoleVisible $true
  }

  $outcome = [string]$script:Wiz.Outcome
  if (-not $outcome) { $outcome = 'cancelled' }
  if (($outcome -eq 'ok' -or $outcome -eq 'warn') -and $script:Wiz.StartApp) {
    try { Invoke-Open 'octobrowser' } catch { Warn $_.Exception.Message }
  }
  return $outcome
}
