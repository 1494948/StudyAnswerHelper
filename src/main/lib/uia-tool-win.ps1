# uia-tool-win.ps1 -- generic UI Automation helper: enumerate elements, or click one by name.
#
# NOTE: this file is intentionally pure ASCII. Windows PowerShell 5.1 reads .ps1 files as
# ANSI unless a BOM is present, so a non-ASCII literal here would be mangled at parse time.
# (C-style /* */ comments are NOT valid PowerShell either -- they parse as commands and throw.)
#
# Chinese element names (e.g. the formula button on the Chaoxing editor toolbar) are passed in
# through a UTF-8 JSON request file instead of argv: argv encoding goes through the console
# code page and is a known source of mojibake. All human-facing text is produced by the caller.
#
# Modes:
#   dump  -- enumerate the accessibility tree of the window (bounded), for calibration.
#   click -- find an element whose name matches one of the candidate strings, then invoke it.
#
# Two facts reused from option-click-win.ps1 (both were measured on this machine):
#   a. Chromium-based targets build their accessibility tree ON DEMAND: the first query only
#      wakes it up. We post WM_GETOBJECT with UiaRootObjectId, then re-scan with delays.
#   b. The content tree may hang off a CHILD window (Chrome_RenderWidgetHostHWND), so every
#      scan runs against a set of candidate roots, not just the HWND the caller passed in.

param(
  [Parameter(Mandatory = $true)][string]$Req,
  [Parameter(Mandatory = $true)][string]$Out
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Result($obj) {
  $json = $obj | ConvertTo-Json -Depth 6 -Compress
  [System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding($false)))
}

# Any unhandled error must still produce a result file, otherwise the caller only sees
# "no-result", which is unactionable. Record the message AND the line number.
trap {
  $m = ''
  try { $m = [string]$_.Exception.Message } catch { }
  $ln = ''
  try { $ln = [string]$_.InvocationInfo.ScriptLineNumber } catch { }
  try { Write-Result @{ ok = $false; code = 'script-error'; err = $m; line = $ln } } catch { }
  exit 0
}

# PowerShell variable names are CASE-INSENSITIVE: a local $req would silently clobber the
# -Req parameter. Hence the distinct name $cfg below.
$cfg = $null
try {
  $cfg = ([System.IO.File]::ReadAllText($Req, [System.Text.Encoding]::UTF8)) | ConvertFrom-Json
} catch {
  Write-Result @{ ok = $false; code = 'bad-request'; err = [string]$_.Exception.Message }
  exit 0
}

$mode = 'dump'
if ($cfg.mode) { $mode = [string]$cfg.mode }
$Hwnd = 0
if ($cfg.hwnd) { $Hwnd = [int]$cfg.hwnd }
$TimeoutMs = 12000
if ($cfg.timeoutMs) { $TimeoutMs = [int]$cfg.timeoutMs }
$MaxItems = 1200
if ($cfg.max) { $MaxItems = [int]$cfg.max }
$exactOnly = $false
if ($cfg.exact) { $exactOnly = [bool]$cfg.exact }

# Candidate names are normalised on the PowerShell side too (strip whitespace + common
# punctuation, lower-case) so that a bare label also matches a decorated one
# (e.g. the same word followed by " (Ctrl+M)").
$cands = @()
if ($cfg.names) {
  foreach ($n in @($cfg.names)) {
    $s = [string]$n
    if (-not [string]::IsNullOrWhiteSpace($s)) { $cands += $s }
  }
}

if ($mode -ne 'dump' -and $mode -ne 'click' -and $mode -ne 'list') {
  Write-Result @{ ok = $false; code = 'bad-mode'; mode = $mode }
  exit 0
}
if (($mode -eq 'dump' -or $mode -eq 'click') -and $Hwnd -le 0) {
  Write-Result @{ ok = $false; code = 'no-window'; hwnd = $Hwnd }
  exit 0
}
if ($mode -eq 'click' -and $cands.Count -eq 0) {
  Write-Result @{ ok = $false; code = 'no-names' }
  exit 0
}

try {
  Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
  Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
} catch {
  Write-Result @{ ok = $false; code = 'uia-unavailable'; err = $_.Exception.Message }
  exit 0
}

# DPI awareness: a virtualised process would see BoundingRectangle in logical units while
# mouse_event works in physical ones, so clicks would land in the wrong place on scaled displays.
try {
  Add-Type -Namespace Sah -Name Win -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, System.IntPtr dwExtraInfo);
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)] public static extern System.IntPtr SendMessageTimeoutW(System.IntPtr hWnd, uint Msg, System.IntPtr wParam, System.IntPtr lParam, uint fuFlags, uint uTimeout, out System.IntPtr lpdwResult);
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)] public static extern System.IntPtr FindWindowExW(System.IntPtr hWndParent, System.IntPtr hWndChildAfter, string lpszClass, string lpszWindow);
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)] public static extern int GetClassNameW(System.IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr hWnd);
'@ -ErrorAction SilentlyContinue
  [void][Sah.Win]::SetProcessDPIAware()
} catch { }

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$TRUE_COND = [System.Windows.Automation.Condition]::TrueCondition
$WM_GETOBJECT = 0x003D
$UIA_ROOT_OBJECT_ID = [IntPtr](-25)

# Toolbar buttons in a browser are usually exposed as Button / Link / MenuItem / ListItem.
# The list is ordered so that the most likely types are ranked first for the click mode.
$CLICK_TYPES = @('Button', 'Link', 'Hyperlink', 'MenuItem', 'SplitButton', 'ListItem', 'Image', 'Text')

function Get-ClassName($h) {
  try {
    $sb = New-Object System.Text.StringBuilder 256
    [void][Sah.Win]::GetClassNameW($h, $sb, 256)
    return $sb.ToString()
  } catch { return '' }
}

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

function Wake-Accessibility($h) {
  $res = [IntPtr]::Zero
  try {
    [void][Sah.Win]::SendMessageTimeoutW($h, $WM_GETOBJECT, [IntPtr]::Zero, $UIA_ROOT_OBJECT_ID, 0x0002, 1500, [ref]$res)
  } catch { }
}

function Norm([string]$s) {
  if ($null -eq $s) { return '' }
  $t = $s.ToLowerInvariant()
  $t = $t -replace '[\s\u3000]+', ''
  $t = $t -replace '[\uFF08\uFF09()\[\]\u3010\u3011{}<>.,:;!?/\|\\~`''"+\-_\u3001\uFF0C\uFF1A\uFF1B\uFF01\uFF1F\u2026\u00B7\u2022]', ''
  return $t
}

$normCands = @()
foreach ($c in $cands) { $normCands += (Norm $c) }

function Match-Score([string]$name) {
  if ([string]::IsNullOrWhiteSpace($name)) { return -1 }
  $n = Norm $name
  if ($n.Length -eq 0) { return -1 }
  $best = -1
  foreach ($c in $script:normCands) {
    if ($c.Length -eq 0) { continue }
    if ($n -eq $c) { return 100 }
    if ($n.StartsWith($c)) { if ($best -lt 80) { $best = 80 } }
    elseif ($n.Contains($c)) { if ($best -lt 60) { $best = 60 } }
    elseif ($c.Contains($n) -and $n.Length -ge 2) { if ($best -lt 40) { $best = 40 } }
  }
  if ($script:exactOnly -and $best -lt 100) { return -1 }
  return $best
}

function Element-Info($el) {
  $name = ''; $off = $true; $x = 0; $y = 0; $w = 0; $h = 0; $type = ''
  try { $name = [string]$el.Current.Name } catch { }
  try { $off = [bool]$el.Current.IsOffscreen } catch { }
  try { $type = ([string]$el.Current.ControlType.ProgrammaticName).Replace('ControlType.', '') } catch { }
  try {
    $r = $el.Current.BoundingRectangle
    $x = [int]$r.X; $y = [int]$r.Y; $w = [int]$r.Width; $h = [int]$r.Height
  } catch { }
  return @{ name = $name; off = $off; x = $x; y = $y; w = $w; h = $h; type = $type; el = $el }
}

function Get-Pattern($el, $type) {
  $p = $null
  try { if ($el.TryGetCurrentPattern($type, [ref]$p)) { return $p } } catch { }
  return $null
}

function Pattern-Names($el) {
  # Returns a slash-joined STRING, not an array: in PowerShell 5.1 an empty array nested in a
  # hashtable serialises to `{}` rather than `[]`, which broke the JSON consumer. A string has
  # no such ambiguity.
  $out = @()
  # LegacyIAccessiblePattern is deliberately NOT probed: on this machine the type is not
  # resolvable in PowerShell 5.1 and the lookup throws, which would abort the whole scan.
  foreach ($pair in @(
      @('Invoke', [System.Windows.Automation.InvokePattern]::Pattern),
      @('SelectionItem', [System.Windows.Automation.SelectionItemPattern]::Pattern),
      @('Toggle', [System.Windows.Automation.TogglePattern]::Pattern),
      @('Value', [System.Windows.Automation.ValuePattern]::Pattern),
      @('ExpandCollapse', [System.Windows.Automation.ExpandCollapsePattern]::Pattern))) {
    if (Get-Pattern $el $pair[1]) { $out += $pair[0] }
  }
  return ($out -join '/')
}

function Invoke-Element($el) {
  $p = Get-Pattern $el ([System.Windows.Automation.InvokePattern]::Pattern)
  if ($p) { try { $p.Invoke(); return 'invoke' } catch { } }
  $p = Get-Pattern $el ([System.Windows.Automation.SelectionItemPattern]::Pattern)
  if ($p) { try { $p.Select(); return 'select' } catch { } }
  $p = Get-Pattern $el ([System.Windows.Automation.TogglePattern]::Pattern)
  if ($p) { try { $p.Toggle(); return 'toggle' } catch { } }
  $p = Get-Pattern $el ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
  if ($p) { try { $p.Expand(); return 'expand' } catch { } }
  # Last resort: a real mouse click at the centre of the element.
  try {
    $r = $el.Current.BoundingRectangle
    if ($r.Width -gt 1 -and $r.Height -gt 1) {
      $cx = [int]($r.X + $r.Width / 2)
      $cy = [int]($r.Y + $r.Height / 2)
      [void][Sah.Win]::SetCursorPos($cx, $cy)
      Start-Sleep -Milliseconds 40
      [Sah.Win]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
      Start-Sleep -Milliseconds 30
      [Sah.Win]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
      return 'mouse'
    }
  } catch { }
  return ''
}

# Control types worth walking. Scanning per type (PropertyCondition) is the path proven to work
# on this machine by option-click-win.ps1; a bare Descendants+TrueCondition query returned 0
# elements on a plain WinForms window while the typed queries found everything.
$SCAN_TYPES = @(
  $CT::Button, $CT::Edit, $CT::Text, $CT::Hyperlink, $CT::MenuItem, $CT::ListItem,
  $CT::SplitButton, $CT::Image, $CT::CheckBox, $CT::RadioButton, $CT::ComboBox,
  $CT::TabItem, $CT::TreeItem, $CT::DataItem, $CT::Custom, $CT::Group, $CT::Pane,
  $CT::Document, $CT::ToolBar, $CT::Window, $CT::Header, $CT::HeaderItem, $CT::Table
)

function Scan-Root($rootHandle, $collectAll) {
  $out = @{ ok = $false; elements = @(); scanned = 0; err = '' }
  $rt = $null
  try { $rt = $AE::FromHandle($rootHandle) } catch { $out.err = 'FromHandle: ' + $_.Exception.Message; return $out }
  if ($null -eq $rt) { $out.err = 'FromHandle returned null'; return $out }
  $out.ok = $true

  $keep = @()
  foreach ($ct in $SCAN_TYPES) {
    $found = $null
    try {
      $cond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $ct)
      $found = $rt.FindAll($TS::Descendants, $cond)
    } catch { $found = $null }
    if ($null -eq $found) { continue }
    $n = $found.Count
    $out.scanned += $n
    for ($i = 0; $i -lt $n; $i++) {
      $el = $found.Item($i)
      $info = Element-Info $el
      if ($info.off) { continue }
      if (-not $collectAll) {
        if (-not ($info.name -and -not [string]::IsNullOrWhiteSpace($info.name))) { continue }
      }
      $keep += $info
      if ($keep.Count -ge $MaxItems) { break }
    }
    if ($keep.Count -ge $MaxItems) { break }
  }

  # Last resort: a full walk. Kept because the typed scan is a fast path, not a guarantee.
  if ($keep.Count -eq 0) {
    try {
      $all = $rt.FindAll($TS::Descendants, $TRUE_COND)
      if ($null -ne $all -and $all.Count -gt 0) {
        $out.scanned += $all.Count
        $cap = [Math]::Min($all.Count, 6000)
        for ($i = 0; $i -lt $cap; $i++) {
          $info = Element-Info ($all.Item($i))
          if ($info.off) { continue }
          if (-not $collectAll) {
            if (-not ($info.name -and -not [string]::IsNullOrWhiteSpace($info.name))) { continue }
          }
          $keep += $info
          if ($keep.Count -ge $MaxItems) { break }
        }
      }
    } catch { $out.err = 'TrueCondition: ' + $_.Exception.Message }
  }

  $out.elements = $keep
  return $out
}

# ---- run -------------------------------------------------------------------

# list mode: enumerate visible top-level windows so the caller can pick the Chaoxing one.
if ($mode -eq 'list') {
  $wins = @()
  try {
    $cond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
    $tops = $AE::RootElement.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)
    $cap = [Math]::Min($tops.Count, 400)
    for ($i = 0; $i -lt $cap; $i++) {
      $el = $tops.Item($i)
      $nm = ''; $off = $true; $x = 0; $y = 0; $w = 0; $h = 0; $nh = 0; $procId = 0
      try { $nm = [string]$el.Current.Name } catch { }
      try { $off = [bool]$el.Current.IsOffscreen } catch { }
      try { $nh = [int]$el.Current.NativeWindowHandle } catch { }
      try { $procId = [int]$el.Current.ProcessId } catch { }
      try { $r = $el.Current.BoundingRectangle; $x = [int]$r.X; $y = [int]$r.Y; $w = [int]$r.Width; $h = [int]$r.Height } catch { }
      if ($off) { continue }
      if ([string]::IsNullOrWhiteSpace($nm)) { continue }
      if ($w -le 1 -or $h -le 1) { continue }
      $wins += @{ hwnd = $nh; pid = $procId; name = $nm; x = $x; y = $y; w = $w; h = $h; cls = (Get-ClassName ([IntPtr]$nh)) }
    }
  } catch { }
  Write-Result @{ ok = $true; mode = 'list'; count = $wins.Count; windows = $wins }
  exit 0
}

$roots = Get-Roots ([IntPtr]$Hwnd)
foreach ($r in $roots) { Wake-Accessibility $r.h }

$rootInfo = @()
foreach ($r in $roots) { $rootInfo += ($r.cls + '@' + $r.h.ToString()) }

$deadline = (Get-Date).AddMilliseconds($TimeoutMs)
$attempts = 0
$maxAttempts = [Math]::Max(2, [int]($TimeoutMs / 1100))
$elements = @()
$scanned = 0
$errs = @()

if ($mode -eq 'dump') {
  # For a dump, one good pass is enough; but the tree may still be building, so retry while empty.
  while ($attempts -lt $maxAttempts -and (Get-Date) -lt $deadline) {
    $attempts++
    foreach ($r in $roots) {
      $s = Scan-Root $r.h $true
      $scanned += $s.scanned
      if ($s.err -and $errs.Count -lt 8) { $errs += ($r.cls + ': ' + $s.err) }
      if ($s.elements.Count -gt 0) { $elements = $s.elements; break }
    }
    if ($elements.Count -gt 0) { break }
    foreach ($r in $roots) { Wake-Accessibility $r.h }
    Start-Sleep -Milliseconds 550
  }
  $items = @()
  foreach ($e in $elements) {
    $items += @{
      type = $e.type; name = $e.name; x = $e.x; y = $e.y; w = $e.w; h = $e.h
      patterns = (Pattern-Names $e.el)
    }
  }
  Write-Result @{
    ok = $true; mode = 'dump'; hwnd = $Hwnd; scanned = $scanned; count = $items.Count
    attempts = $attempts; roots = $rootInfo; elements = $items; errs = $errs
  }
  exit 0
}

# click mode
$best = $null
$bestScore = -1
$bestTypeRank = 99
$usedRoot = 0
$candidatesSeen = 0

while ($attempts -lt $maxAttempts -and $null -eq $best -and (Get-Date) -lt $deadline) {
  $attempts++
  foreach ($r in $roots) {
    if ($null -ne $best -or (Get-Date) -gt $deadline) { break }
    $s = Scan-Root $r.h $false
    $scanned += $s.scanned
    if ($s.err -and $errs.Count -lt 8) { $errs += ($r.cls + ': ' + $s.err) }
    foreach ($e in $s.elements) {
      if ([string]::IsNullOrWhiteSpace($e.name)) { continue }
      $sc = Match-Score $e.name
      if ($sc -lt 0) { continue }
      if ($e.w -le 1 -or $e.h -le 1) { continue }
      $candidatesSeen++
      $rank = $CLICK_TYPES.IndexOf($e.type)
      if ($rank -lt 0) { $rank = 50 }
      # Prefer a better name match; break ties by control type, then by smaller area
      # (a toolbar icon is small; a whole editor pane that happens to contain the word is not).
      $better = $false
      if ($sc -gt $bestScore) { $better = $true }
      elseif ($sc -eq $bestScore -and $rank -lt $bestTypeRank) { $better = $true }
      elseif ($sc -eq $bestScore -and $rank -eq $bestTypeRank -and $best -ne $null -and ($e.w * $e.h) -lt ($best.w * $best.h)) { $better = $true }
      if ($better) {
        $best = $e; $bestScore = $sc; $bestTypeRank = $rank; $usedRoot = $r.h.ToInt64()
      }
    }
  }
  if ($null -eq $best) {
    foreach ($r in $roots) { Wake-Accessibility $r.h }
    Start-Sleep -Milliseconds 550
  }
}

if ($null -eq $best) {
  Write-Result @{
    ok = $false; code = 'not-found'; hwnd = $Hwnd; scanned = $scanned
    attempts = $attempts; roots = $rootInfo; candidates = $cands; errs = $errs
  }
  exit 0
}

$used = Invoke-Element $best.el
if (-not $used) {
  Write-Result @{
    ok = $false; code = 'no-pattern'; hwnd = $Hwnd; name = $best.name
    type = $best.type; score = $bestScore
  }
  exit 0
}

Write-Result @{
  ok = $true; code = 'ok'; mode = 'click'; hwnd = $Hwnd
  used = $used; name = $best.name; type = $best.type; score = $bestScore
  x = $best.x; y = $best.y; w = $best.w; h = $best.h
  scanned = $scanned; attempts = $attempts; rootHwnd = $usedRoot; candidatesSeen = $candidatesSeen
}
exit 0
