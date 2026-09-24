# =====================================================================
# Windows built-in OCR (Windows.Media.Ocr) via WinRT projection in PS 5.1.
#
# PURE ASCII ONLY -- do not add non-ASCII comments here.
# PowerShell 5.1 reads a BOM-less UTF-8 script using the local ANSI code
# page (GBK on zh-CN Windows), so non-ASCII bytes get mis-decoded and can
# silently corrupt line structure.
#
# Result JSON: { ok, text, lang, width, height, lines, err, detail, raw, step }
#
# Three findings that cost real debugging time:
#  1) .GetAwaiter() does NOT work on a WinRT IAsyncOperation in PowerShell
#     (extension methods are not resolved on projected WinRT objects, it
#     reports "cannot call on System.__ComObject"). Use the AsTask
#     reflection helper below.
#  2) In double-quoted PowerShell strings the backtick is the ESCAPE char,
#     so "IAsyncOperation`1" silently becomes "IAsyncOperation1" and the
#     filter never matches. Use single quotes for that literal.
#  3) WinRT path APIs reject forward slashes outright, and
#     TryCreateFromUserProfileLanguages() returns $null on machines where
#     the OCR pack is installed but not in the user profile language list.
# =====================================================================
param(
  [string]$Image,
  [string]$Out,
  [string]$Lang
)
$ErrorActionPreference = 'Stop'
$step = 'init'

function Write-Fail([string]$code, [string]$detail) {
  $sb = New-Object System.Text.StringBuilder
  if ($detail) {
    foreach ($ch in $detail.ToCharArray()) {
      if ([int][char]$ch -lt 128) { [void]$sb.Append($ch) } else { [void]$sb.Append('?') }
    }
  }
  $obj = @{ ok = $false; err = $code; detail = $sb.ToString(); raw = $detail; step = $script:step }
  $json = $obj | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding($false)))
  exit 1
}

try {
  $step = 'add-type'
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

  $step = 'project-types'
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapTransform, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapPixelFormat, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapAlphaMode, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.ExifOrientationMode, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.ColorManagementMode, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Storage.FileAccessMode, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Foundation, ContentType=WindowsRuntime]

  $step = 'await-helper'
  # single-quoted on purpose: the backtick inside IAsyncOperation`1 must survive
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
  if (-not $asTaskGeneric) { Write-Fail 'NO_AWAIT_HELPER' 'AsTask(IAsyncOperation`1) not found'; return }

  function AwaitOp([object]$op, [type]$resultType) {
    $g = $asTaskGeneric.MakeGenericMethod($resultType)
    $net = $g.Invoke($null, @($op))
    $net.Wait(-1) | Out-Null
    return $net.Result
  }

  $step = 'create-engine'
  $engine = $null
  $usedTag = ''
  try { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() } catch { }
  if ($engine) { $usedTag = 'user-profile' }
  $tried = @()
  if ($Lang) { $tried += $Lang }
  $tried += 'zh-Hans-CN'
  $tried += 'zh-Hans'
  $tried += 'en-US'
  foreach ($tag in $tried) {
    if ($engine) { break }
    try {
      $lo = New-Object Windows.Globalization.Language($tag)
      if ($lo) {
        $e = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lo)
        if ($e) { $engine = $e; $usedTag = $tag }
      }
    } catch { }
  }
  if (-not $engine) {
    Write-Fail 'NO_OCR_ENGINE' ('tried=' + ($tried -join ','))
    return
  }

  $step = 'normalize-path'
  # WinRT path APIs reject forward slashes; normalise before use
  $Image = $Image.Replace('/', '\')

  $step = 'test-path'
  if (-not (Test-Path -LiteralPath $Image)) { Write-Fail 'IMAGE_NOT_FOUND' $Image; return }

  $step = 'get-file'
  $file = AwaitOp ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Image)) ([Windows.Storage.StorageFile])

  $step = 'open-stream'
  $stream = AwaitOp ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])

  $step = 'create-decoder'
  $decoder = AwaitOp ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $srcW = [int]$decoder.PixelWidth
  $srcH = [int]$decoder.PixelHeight

  $step = 'scale'
  $maxDim = 2600
  try { $md = [int]$engine.MaxImageDimension; if ($md -gt 0) { $maxDim = $md } } catch { }
  $target = 1600
  $w = $srcW
  $h = $srcH
  if ($srcW -lt $target -and $srcH -lt $target) {
    # too small -> upscale, small images recognise much worse
    $f = [Math]::Min($target / [double]$srcW, $target / [double]$srcH)
    if ($f -gt 4) { $f = 4.0 }
    $w = [int][Math]::Ceiling($srcW * $f)
    $h = [int][Math]::Ceiling($srcH * $f)
  } elseif ($srcW -gt $maxDim -or $srcH -gt $maxDim) {
    $f = [Math]::Min($maxDim / [double]$srcW, $maxDim / [double]$srcH)
    $w = [int][Math]::Floor($srcW * $f)
    $h = [int][Math]::Floor($srcH * $f)
  }

  $step = 'get-bitmap'
  $bmp = $null
  if ($w -ne $srcW -or $h -ne $srcH) {
    $tr = New-Object Windows.Graphics.Imaging.BitmapTransform
    $tr.ScaledWidth = [int]$w
    $tr.ScaledHeight = [int]$h
    $bmp = AwaitOp ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied, $tr, [Windows.Graphics.Imaging.ExifOrientationMode]::IgnoreExifOrientation, [Windows.Graphics.Imaging.ColorManagementMode]::ColorManageToSRgb)) ([Windows.Graphics.Imaging.SoftwareBitmap])
  } else {
    $bmp = AwaitOp ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  }

  $step = 'recognize'
  $res = AwaitOp ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
  $text = ''
  try { $text = [string]$res.Text } catch { $text = '' }
  # WinRT IVector surfaces as a projected object; .Size is not always readable
  # from PowerShell 5.1, so count via the pipeline instead.
  $lineCount = 0
  try { $lineCount = @($res.Lines).Count } catch { $lineCount = 0 }
  # RecognizedLanguage can come back empty on some builds; fall back to the tag
  # we actually created the engine with.
  $langTag = ''
  try { $langTag = [string]$engine.RecognizedLanguage.LanguageTag } catch { }
  if (-not $langTag) { $langTag = $usedTag }

  $step = 'write-result'
  $obj = @{
    ok = $true
    text = $text
    lang = $langTag
    width = $w
    height = $h
    lines = $lineCount
  }
  $json = $obj | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding($false)))
  exit 0
} catch {
  # unwrap "Exception calling Wait ..." so the real cause surfaces
  $m = 'unknown'
  try {
    $m = $_.Exception.Message
    $be = $_.Exception.GetBaseException()
    if ($be -and $be.Message) { $m = $be.Message }
  } catch { }
  if (-not $m) { $m = 'unknown' }
  Write-Fail 'PSEXCEPTION' $m
}
