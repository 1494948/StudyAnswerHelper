# click-target-win.ps1 -- a throwaway WinForms window holding four real radio buttons.
#
# Purpose: give SP_CLICKTEST a target that exposes a GENUINE UI Automation tree, so the
# option-clicking logic (find by letter / find by index / invoke / read back) can be verified
# end to end instead of only its failure paths.
#
# Why not use the app's own Electron window as the target: measured on this machine, a
# sandboxed Electron window (--no-sandbox --disable-gpu) exposes only a "Chrome Legacy Window"
# stub pane to UIA -- 18 elements, none of them controls -- even with
# --force-renderer-accessibility. A real browser (Edge) exposes 1138 elements including the
# page content, and a native WinForms window exposes real RadioButtons. So a WinForms window
# is the honest way to test the matcher, and the Edge measurement is the evidence that the
# strategy works against real Chromium targets.
#
# Kept pure ASCII (PowerShell 5.1 reads .ps1 as ANSI without a BOM).

param(
  [Parameter(Mandatory = $true)][string]$HwndFile,
  [Parameter(Mandatory = $true)][string]$ResultFile,
  [ValidateSet('name', 'plain')][string]$Style = 'name',
  [int]$LifetimeMs = 60000
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$letters = @('A', 'B', 'C', 'D')
$values = @('3', '4', '5', '6')

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Choice Click Target'
$form.Size = New-Object System.Drawing.Size(420, 300)
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(80, 80)
$form.TopMost = $true

$y = 14
for ($i = 0; $i -lt 4; $i++) {
  $rb = New-Object System.Windows.Forms.RadioButton
  $rb.AutoSize = $true
  $rb.Location = New-Object System.Drawing.Point(20, $y)
  # WinForms derives the UIA Name from the control text, which is exactly what the matcher reads.
  if ($Style -eq 'name') { $rb.Text = $letters[$i] + '. ' + $values[$i] } else { $rb.Text = $values[$i] }
  $rb.Name = 'opt' + $letters[$i]
  $rb.Tag = $letters[$i]
  $rb.Add_Click({
    param($sender, $e)
    [System.IO.File]::WriteAllText($ResultFile, [string]$sender.Tag, (New-Object System.Text.UTF8Encoding($false)))
  })
  $form.Controls.Add($rb)
  $y += 34
}

$lbl = New-Object System.Windows.Forms.Label
# Parentheses are required: without them PowerShell reads "20, $y + 6" as three arguments
# (20, $y, +6) and New-Object fails with "no overload for Point taking 3 arguments".
$lbl.Location = New-Object System.Drawing.Point(20, ($y + 6))
$lbl.AutoSize = $true
$lbl.Text = 'style=' + $Style
$form.Controls.Add($lbl)

$form.Add_Shown({
  [System.IO.File]::WriteAllText($HwndFile, $form.Handle.ToString(), (New-Object System.Text.UTF8Encoding($false)))
  [System.IO.File]::WriteAllText($ResultFile, '', (New-Object System.Text.UTF8Encoding($false)))
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = [Math]::Max(1000, $LifetimeMs)
$timer.Add_Tick({ $timer.Stop(); $form.Close() })
$timer.Start()

[void]$form.Show()
[System.Windows.Forms.Application]::Run($form)
