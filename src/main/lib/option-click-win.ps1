# option-click-win.ps1 -- click one choice option inside a target window via UI Automation.
#
# NOTE: this file is intentionally pure ASCII. Windows PowerShell 5.1 reads .ps1 files as
# ANSI unless a BOM is present, so any non-ASCII literal here would be mangled at parse time
# (and C-style /* */ comments are NOT valid PowerShell -- they parse as commands and throw).
# All human-facing messages are produced by the JS side (option-click.js) from the short
# ASCII codes returned here.
#
# Matching strategies, in order:
#   1. name match  -- element whose Name starts with the option letter ("A", "A.", "A)", "A:")
#   2. index match -- the n-th selectable control (n = letter - 'A'), only when the number of
#                     selectable controls EQUALS the number of options (else we refuse to click)
#
# Two hard-won facts about Chromium-based targets (browsers, the Chaoxing desktop client):
#
#   a. Their accessibility tree is built ON DEMAND. The very first query just wakes it up and
#      can legitimately return zero elements. So we explicitly post WM_GETOBJECT with
#      UiaRootObjectId to the window (the documented activation trigger), then re-scan with
#      delays. Measured: without this, 17 attempts over 12s still returned 0 controls.
#
#   b. The content tree may hang off a CHILD window (Chrome_RenderWidgetHostHWND) rather than
#      the top-level frame, so every scan is run against a set of candidate roots, not just
#      the HWND the caller passed in.

param(
  [Parameter(Mandatory = $true)][int]$Hwnd,
  [Parameter(Mandatory = $true)][string]$Letter,
  [int]$OptionCount = 0,
  [int]$TimeoutMs = 15000,
  [Parameter(Mandatory = $true)][string]$Out
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Result($obj) {
  $json = $obj | ConvertTo-Json -Depth 5 -Compress
  [System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding($false)))
}

# Any unhandled error must still produce a result file: otherwise the caller only sees
# "no-result", which is unactionable. Record the message AND the line number.
trap {
  $m = ''
  try { $m = [string]$_.Exception.Message } catch { }
  $ln = ''
  try { $ln = [string]$_.InvocationInfo.ScriptLineNumber } catch { }
  try { Write-Result @{ ok = $false; code = 'script-error'; err = $m; line = $ln } } catch { }
  exit 0
}

$letterUp = $Letter.Trim().ToUpperInvariant()
if ($letterUp -notmatch '^[A-H]$') {
  Write-Result @{ ok = $false; code = 'bad-letter'; letter = $Letter }
  exit 0
}
$letterIndex = ([int][char]$letterUp) - ([int][char]'A')

try {
  Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
  Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
} catch {
  Write-Result @{ ok = $false; code = 'uia-unavailable'; err = $_.Exception.Message }
  exit 0
}

# DPI awareness: UIA BoundingRectangle is in physical pixels. Without this the process is
# DPI-virtualised and mouse coordinates would land in the wrong place on scaled displays.
try {
  Add-Type -Namespace Sah -Name Win -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, System.IntPtr dwExtraInfo);
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)] public static extern System.IntPtr SendMessageTimeoutW(System.IntPtr hWnd, uint Msg, System.IntPtr wParam, System.IntPtr lParam, uint fuFlags, uint uTimeout, out System.IntPtr lpdwResult);
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)] public static extern System.IntPtr FindWindowExW(System.IntPtr hWndParent, System.IntPtr hWndChildAfter, string lpszClass, string lpszWindow);
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)] public static extern int GetClassNameW(System.IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint lpdwProcessId);
'@ -ErrorAction SilentlyContinue
  [void][Sah.Win]::SetProcessDPIAware()
} catch { }

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]
$TRUE_COND = [System.Windows.Automation.Condition]::TrueCondition
$WM_GETOBJECT = 0x003D
$UIA_ROOT_OBJECT_ID = [IntPtr](-25)

$rootHandle = [IntPtr]$Hwnd

# Controls a choice option can plausibly be rendered as, most specific first.
$types = @(
  @{ name = 'RadioButton'; ct = $CT::RadioButton; selectable = $true },
  @{ name = 'CheckBox';    ct = $CT::CheckBox;    selectable = $true },
  @{ name = 'ListItem';    ct = $CT::ListItem;    selectable = $true },
  @{ name = 'Button';      ct = $CT::Button;      selectable = $false },
  @{ name = 'Text';        ct = $CT::Text;        selectable = $false }
)

# Matches names like "A", "A.", "A)", "A:", "A <text>"; a leading bracket or full-width form is
# allowed (all encoded as \uXXXX below so this source file stays pure ASCII).
function Test-LetterName([string]$name) {
  if ([string]::IsNullOrWhiteSpace($name)) { return $false }
  $n = $name.Trim()
  if ($n -match ('^(?:[\uFF08(\u3010\[]?\s*' + $script:letterUp + '\s*[\uFF09)\u3011\]]?\s*$)')) { return $true }
  if ($n -match ('^\s*[\uFF08(\u3010\[]?\s*' + $script:letterUp + '\s*[.\u3001\uFF0E,:\uFF1A)\uFF09\]]')) { return $true }
  if ($n -match ('^\s*[\uFF08(\u3010\[]?\s*' + $script:letterUp + '\s+\S')) { return $true }
  return $false
}

function Get-Pattern($el, $type) {
  $p = $null
  try {
    if ($el.TryGetCurrentPattern($type, [ref]$p)) { return $p }
  } catch { }
  return $null
}

function Element-Info($el, [string]$typeName) {
  $name = ''
  $off = $false
  $w = 0; $h = 0
  try { $name = [string]$el.Current.Name } catch { }
  try { $off = [bool]$el.Current.IsOffscreen } catch { }
  try { $r = $el.Current.BoundingRectangle; $w = [int]$r.Width; $h = [int]$r.Height } catch { }
  return @{ name = $name; off = $off; w = $w; h = $h; el = $el; type = $typeName }
}

function Get-Selected($el) {
  try {
    $p = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) {
      return [bool]$p.Current.IsSelected
    }
  } catch { }
  try {
    $p = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) {
      return ([string]$p.Current.ToggleState -eq 'On')
    }
  } catch { }
  return $null
}

function Invoke-Element($el) {
  # 1) SelectionItemPattern (radio / list item)
  $p = Get-Pattern $el ([System.Windows.Automation.SelectionItemPattern]::Pattern)
  if ($p) { try { $p.Select(); return 'select' } catch { } }
  # 2) InvokePattern (button / link)
  $p = Get-Pattern $el ([System.Windows.Automation.InvokePattern]::Pattern)
  if ($p) { try { $p.Invoke(); return 'invoke' } catch { } }
  # 3) TogglePattern (checkbox)
  $p = Get-Pattern $el ([System.Windows.Automation.TogglePattern]::Pattern)
  if ($p) { try { $p.Toggle(); return 'toggle' } catch { } }
  # 4) real mouse click at the centre of the element
  try {
    $r = $el.Current.BoundingRectangle
    if ($r.Width -gt 1 -and $r.Height -gt 1) {
      $x = [int]($r.X + $r.Width / 2)
      $y = [int]($r.Y + $r.Height / 2)
      [void][Sah.Win]::SetCursorPos($x, $y)
      Start-Sleep -Milliseconds 40
      [Sah.Win]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)   # LEFTDOWN
      Start-Sleep -Milliseconds 30
      [Sah.Win]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)   # LEFTUP
      return 'mouse'
    }
  } catch { }
  return ''
}

function Get-ClassName($h) {
  try {
    $sb = New-Object System.Text.StringBuilder 256
    [void][Sah.Win]::GetClassNameW($h, $sb, 256)
    return $sb.ToString()
  } catch { return '' }
}

# Collect candidate roots: the window we were given, plus descendants (bounded depth/count).
# Chromium may host the content tree on a child HWND, so scanning only the top-level frame
# can legitimately find nothing.
function Get-Roots($h) {
  $list = New-Object System.Collections.ArrayList
  [void]$list.Add(@{ h = $h; cls = (Get-ClassName $h); depth = 0 })
  $i = 0
  while ($i -lt $list.Count -and $list.Count -lt 24) {
    $cur = $list[$i]
    $i++
    if ($cur.depth -ge 2) { continue }
    $child = [IntPtr]::Zero
    while ($true) {
      try { $child = [Sah.Win]::FindWindowExW($cur.h, $child, $null, $null) } catch { break }
      if ($child -eq [IntPtr]::Zero) { break }
      [void]$list.Add(@{ h = $child; cls = (Get-ClassName $child); depth = ($cur.depth + 1) })
      if ($list.Count -ge 24) { break }
    }
  }
  return $list
}

# Post WM_GETOBJECT with UiaRootObjectId: this is what tells a Chromium window to build its
# accessibility tree. SMTO_ABORTIFHUNG (0x0002) + a short timeout so a hung target cannot
# block us. Errors are deliberately swallowed: if the window does not use UIA, nothing happens.
function Wake-Accessibility($h) {
  $res = [IntPtr]::Zero
  try {
    [void][Sah.Win]::SendMessageTimeoutW($h, $WM_GETOBJECT, [IntPtr]::Zero, $UIA_ROOT_OBJECT_ID, 0x0002, 1500, [ref]$res)
  } catch { }
}

function Scan-Root($h) {
  $out = @{ scanned = 0; byName = @(); selectable = @(); ok = $false; samples = @(); tried = @() }
  $rt = $null
  try { $rt = $AE::FromHandle($h) } catch { return $out }
  if ($null -eq $rt) { return $out }
  $out.ok = $true

  foreach ($t in $types) {
    $found = $null
    try {
      $cond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $t.ct)
      $found = $rt.FindAll($TS::Descendants, $cond)
    } catch { $found = $null }
    if ($null -eq $found) { continue }
    $n = $found.Count
    $out.scanned += $n
    for ($i = 0; $i -lt $n; $i++) {
      $el = $found.Item($i)
      $info = Element-Info $el $t.name
      if ($info.off) { continue }
      if ($t.selectable -and $info.w -gt 0 -and $info.h -gt 0) { $out.selectable += $info }
      if ($info.name -and (Test-LetterName $info.name)) {
        $out.byName += $info
        if ($t.selectable) { break }
      }
    }
    if ($out.byName.Count -gt 0 -and $t.selectable) { break }
  }

  if ($out.byName.Count -eq 0 -and $out.selectable.Count -eq 0) {
    # Nothing at all from this root: do a full walk. The per-ControlType property condition is
    # a fast path, not a guarantee -- some providers do not implement it.
    try {
      $all = $rt.FindAll($TS::Descendants, $TRUE_COND)
      if ($null -ne $all) {
        $out.scanned += $all.Count
        $cap = [Math]::Min($all.Count, 4000)
        for ($i = 0; $i -lt $cap; $i++) {
          $el = $all.Item($i)
          $cn = ''
          try { $cn = [string]$el.Current.ControlType.ProgrammaticName } catch { }
          $isSel = ($cn -like '*RadioButton*' -or $cn -like '*CheckBox*' -or $cn -like '*ListItem*')
          $info = Element-Info $el 'scan'
          if ($info.off) { continue }
          if ($isSel -and $info.w -gt 0 -and $info.h -gt 0) { $out.selectable += $info }
          if ($out.tried.Count -lt 10) {
            $r = 'ERR'
            try { $r = [string](Test-LetterName $info.name) } catch { $r = 'THREW:' + $_.Exception.Message }
            $out.tried += (('[' + $info.name + ']') + '=' + $r)
          }
          if ($info.name -and (Test-LetterName $info.name)) { $out.byName += $info }
          # Keep a short sample of what IS in the tree: when nothing matches, this is the only
          # way to tell "the tree is empty" apart from "the tree is there but shaped differently".
          if ($out.samples.Count -lt 14) {
            $short = ''
            try { $short = ([string]$el.Current.ControlType.ProgrammaticName).Replace('ControlType.', '') } catch { }
            $nm = ($info.name -replace '\s+', ' ')
            if ($nm.Length -gt 28) { $nm = $nm.Substring(0, 28) }
            $out.samples += ($short + '|' + $nm)
          }
        }
      }
    } catch { }
  }
  return $out
}

# ---- locate ----------------------------------------------------------------

$deadline = (Get-Date).AddMilliseconds($TimeoutMs)
$roots = Get-Roots $rootHandle
foreach ($r in $roots) { Wake-Accessibility $r.h }

$scanned = 0
$attempts = 0
$byName = @()
$allSelectable = @()
$pick = $null
$how = ''
$usedRoot = 0
$samplesAll = @()
$triedAll = @()
$rootInfo = @()
foreach ($r in $roots) { $rootInfo += ($r.cls + '@' + $r.h.ToString()) }

$maxAttempts = [Math]::Max(2, [int]($TimeoutMs / 1100))
while ($attempts -lt $maxAttempts -and $null -eq $pick -and (Get-Date) -lt $deadline) {
  $attempts++
  foreach ($r in $roots) {
    if ($null -ne $pick -or (Get-Date) -gt $deadline) { break }
    $s = Scan-Root $r.h
    $scanned += $s.scanned
    foreach ($sm in $s.samples) { if ($samplesAll.Count -lt 16) { $samplesAll += ($r.cls + " >> " + $sm) } }
    foreach ($tr in $s.tried) { if ($triedAll.Count -lt 10) { $triedAll += $tr } }
    if ($s.byName.Count -gt 0) {
      $byName = $s.byName
      $allSelectable = $s.selectable
      # @(...) is REQUIRED: Sort-Object returns a bare Hashtable when there is exactly one hit,
      # and indexing a Hashtable with [0] does a KEY lookup (there is no key 0), yielding $null.
      # Without @() the single-option case silently found nothing at all.
      $sortedByName = @($byName | Sort-Object { $_['w'] * $_['h'] })
      $pick = $sortedByName[0]
      $how = 'name'
      $usedRoot = $r.h.ToInt64()
      break
    }
    if ($s.selectable.Count -gt 0) {
      $allSelectable = $s.selectable
      $usedRoot = $r.h.ToInt64()
      break
    }
  }
  if ($null -eq $pick -and $allSelectable.Count -eq 0) {
    # Keep the accessibility tree warm and try again: it may still be building.
    foreach ($r in $roots) { Wake-Accessibility $r.h }
    Start-Sleep -Milliseconds 550
  } elseif ($null -eq $pick) {
    break
  }
}

if ($null -eq $pick -and $OptionCount -gt 0 -and $letterIndex -lt $OptionCount -and
    $allSelectable.Count -eq $OptionCount) {
  # Index match, deliberately strict: the number of selectable controls must EQUAL the number of
  # detected options. If the page has extra radios (other questions, a poll, a settings dialog),
  # the count will not match and we refuse to click rather than risk clicking the wrong option.
  $sortedBySize = @($allSelectable | Sort-Object { $_['w'] * $_['h'] })
  if ($sortedBySize.Count -gt $letterIndex) {
    $pick = $sortedBySize[$letterIndex]
    $how = 'index'
  }
}

if ($null -eq $pick) {
  Write-Result @{
    ok = $false; code = 'not-found'; hwnd = $Hwnd; letter = $letterUp;
    scanned = $scanned; nameHits = 0; selectables = $allSelectable.Count;
    optionCount = $OptionCount; attempts = $attempts; roots = $rootInfo; sample = $samplesAll;
    tried = $triedAll
  }
  exit 0
}

$wasSelected = Get-Selected $pick.el
$used = Invoke-Element $pick.el
if (-not $used) {
  Write-Result @{
    ok = $false; code = 'no-pattern'; hwnd = $Hwnd; letter = $letterUp;
    how = $how; name = $pick['name']; type = $pick['type']
  }
  exit 0
}

# Give the page a moment to commit the selection, then read it back. This is the difference
# between "we called Select()" and "the option is actually selected now".
Start-Sleep -Milliseconds 150
$nowSelected = Get-Selected $pick.el

Write-Result @{
  ok = $true; code = 'ok'; hwnd = $Hwnd; letter = $letterUp;
  how = $how; used = $used; name = $pick['name']; type = $pick['type'];
  w = $pick['w']; h = $pick['h']; scanned = $scanned;
  attempts = $attempts; roots = $roots.Count; rootHwnd = $usedRoot;
  wasSelected = $wasSelected; selected = $nowSelected
}
exit 0
