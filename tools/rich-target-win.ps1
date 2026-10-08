# rich-target-win.ps1 -- a mock Xuexitong-style rich answer box, used by SP_RICHTEST.
#
# It exists to test the *mechanism* of "drive the editor's own formula/code buttons":
# find a toolbar button by its accessible name -> invoke it -> type into the dialog it opened ->
# find and click the confirm button -> the content lands in the answer box.
#
# The real Chaoxing editor is a web page (Baidu UEditor) inside a browser; its toolbar buttons
# cannot be reproduced faithfully here. What this window DOES prove is the part we control:
# name matching, pattern invocation, focus hand-off, ordering, and the fallback path.
#
# This file is intentionally pure ASCII (PS 5.1 reads .ps1 as ANSI without a BOM), so the
# Chinese labels are built from code points:
#   0x5B66 0x4E60 0x901A = the platform name   (used in the window title so the app matches it)
#   0x516C 0x5F0F       = the formula button
#   0x4EE3 0x7801       = the code button
#   0x786E 0x5B9A       = the confirm button

param(
  [string]$HwndFile = '',
  [string]$ResultFile = '',
  [string]$ResetFile = '',
  [int]$LifetimeMs = 90000
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$PLATFORM = [string]([char]0x5B66) + [char]0x4E60 + [char]0x901A
$LBL_FORMULA = [string]([char]0x516C) + [char]0x5F0F
$LBL_CODE = [string]([char]0x4EE3) + [char]0x7801
$LBL_OK = [string]([char]0x786E) + [char]0x5B9A

$script:events = New-Object System.Collections.ArrayList
$script:pending = ''

function Note([string]$s) {
  [void]$script:events.Add($s)
}

function Save-Result() {
  if ([string]::IsNullOrWhiteSpace($ResultFile)) { return }
  $obj = @{
    text = $tb.Text
    dialog = $dlg.Text
    events = @($script:events)
  }
  $json = $obj | ConvertTo-Json -Depth 5 -Compress
  [System.IO.File]::WriteAllText($ResultFile, $json, (New-Object System.Text.UTF8Encoding($false)))
}

$form = New-Object System.Windows.Forms.Form
$form.Text = $PLATFORM + ' - rich input test'
$form.Width = 760
$form.Height = 520
$form.StartPosition = 'Manual'
$form.Left = 80
$form.Top = 80
# TopMost keeps this test window above the rest of the desktop. It does NOT stop other
# applications from activating themselves, but it does keep the target reachable.
$form.TopMost = $true

# toolbar
$btnF = New-Object System.Windows.Forms.Button
$btnF.Text = $LBL_FORMULA
$btnF.Left = 12
$btnF.Top = 12
$btnF.Width = 90
$btnF.Height = 30

$btnC = New-Object System.Windows.Forms.Button
$btnC.Text = $LBL_CODE
$btnC.Left = 110
$btnC.Top = 12
$btnC.Width = 90
$btnC.Height = 30

$btnOk = New-Object System.Windows.Forms.Button
$btnOk.Text = $LBL_OK
$btnOk.Left = 208
$btnOk.Top = 12
$btnOk.Width = 90
$btnOk.Height = 30

# the "answer box"
$tb = New-Object System.Windows.Forms.TextBox
$tb.Multiline = $true
$tb.ScrollBars = 'Vertical'
$tb.AcceptsReturn = $true
$tb.Left = 12
$tb.Top = 56
$tb.Width = 720
$tb.Height = 280
$tb.Font = New-Object System.Drawing.Font('Consolas', 11)

# the "dialog input" that a formula/code button opens
$dlg = New-Object System.Windows.Forms.TextBox
$dlg.Multiline = $false
$dlg.Left = 12
$dlg.Top = 350
$dlg.Width = 720
$dlg.Height = 28
$dlg.Font = New-Object System.Drawing.Font('Consolas', 11)

$btnF.Add_Click({
    $script:pending = 'formula'
    $dlg.Clear()
    Note 'click:formula'
    $dlg.Focus()
  })

$btnC.Add_Click({
    $script:pending = 'code'
    $dlg.Clear()
    Note 'click:code'
    $dlg.Focus()
  })

$btnOk.Add_Click({
    if ($script:pending -eq 'formula') {
      $tb.AppendText('[FORMULA:' + $dlg.Text + ']')
      Note ('insert:formula:' + $dlg.Text)
    } elseif ($script:pending -eq 'code') {
      $tb.AppendText("[CODE:`n" + $dlg.Text + "`n]")
      Note ('insert:code:' + $dlg.Text)
    } else {
      Note 'insert:none'
    }
    $script:pending = ''
    $dlg.Clear()
    $tb.Focus()
    $tb.SelectionStart = $tb.TextLength
    Save-Result
  })

$form.Controls.Add($btnF)
$form.Controls.Add($btnC)
$form.Controls.Add($btnOk)
$form.Controls.Add($tb)
$form.Controls.Add($dlg)

# Close after the given lifetime so a stuck test cannot leave a window behind forever.
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = [Math]::Max(1000, $LifetimeMs)
$timer.Add_Tick({ Save-Result; $form.Close() })

# Persist the current state every 400 ms, and honour a "reset" request from the test.
# Continuous saving matters: an abrupt kill (the usual teardown) never fires FormClosing,
# so a save-on-close-only design would make the test read a stale or missing file.
$sync = New-Object System.Windows.Forms.Timer
$sync.Interval = 400
$sync.Add_Tick({
    if (-not [string]::IsNullOrWhiteSpace($ResetFile)) {
      if (Test-Path -LiteralPath $ResetFile) {
        try { Remove-Item -LiteralPath $ResetFile -Force } catch { }
        $tb.Clear()
        $dlg.Clear()
        $script:pending = ''
        Note 'reset'
        $tb.Focus()
      }
    }
    Save-Result
  })

$form.Add_Shown({
    if (-not [string]::IsNullOrWhiteSpace($HwndFile)) {
      [System.IO.File]::WriteAllText($HwndFile, [string]$form.Handle, (New-Object System.Text.UTF8Encoding($false)))
    }
    Note 'shown'
    $tb.Focus()
    $timer.Start()
    $sync.Start()
    Save-Result
  })

$form.Add_FormClosing({ Save-Result })

# Show() + Application::Run(), exactly like tools/click-target-win.ps1.
# Measured on this machine: with ShowDialog() the window paints and accepts input normally,
# but a cross-process UI Automation query against it returns ZERO descendants -- the accessibility
# tree is never served. The non-modal pattern from the option-click target does not have that
# problem, so the mock uses it. (That is why the dump returned "scanned 0" and the formula button
# could never be found.)
[void]$form.Show()
[System.Windows.Forms.Application]::Run($form)
Save-Result
