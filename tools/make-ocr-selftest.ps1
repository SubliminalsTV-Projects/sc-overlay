# Regenerates overlay/ocr-selftest.png, the image the OCR self-test reads.
#
# The self-test hands this file to the OCR engine and checks that text comes back. That is the
# whole point: a screenshot of the game can legitimately contain no text, so an empty result is
# ambiguous and cannot be alerted on. An image we ship, whose contents we already know, makes
# "the engine returned nothing" mean exactly one thing.
#
# Deliberately easy to read - big, black on white, no thin strokes. This is testing whether the
# engine RUNS, not how good it is, so anything that makes a marginal read is working against it.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/make-ocr-selftest.ps1

Add-Type -AssemblyName System.Drawing

$repo = Split-Path -Parent $PSScriptRoot
$out  = Join-Path $repo "overlay\ocr-selftest.png"

$w = 900
$h = 150

$bmp = New-Object System.Drawing.Bitmap $w, $h
$g   = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

$font  = New-Object System.Drawing.Font("Arial", 44, [System.Drawing.FontStyle]::Bold)
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::Black)

# Keep these words in sync with OCR_SELFTEST_WORDS in src/screen-read.ts.
$g.DrawString("SC OVERLAY OCR", $font, $brush, 30, 15)
$g.DrawString("SELF TEST 12345", $font, $brush, 30, 78)

$g.Dispose()
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

Write-Output "wrote $out"
