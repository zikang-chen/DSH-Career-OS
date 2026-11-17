# Local Windows.Media.Ocr only: no network, no third-party upload.
param([string]$ImagePath, [string]$Language = '', [switch]$Status)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$languages = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag })
if ($Status) { @{ ok = ($languages.Count -gt 0); engine = 'Windows.Media.Ocr'; languages = $languages } | ConvertTo-Json -Compress; exit 0 }
if (!$ImagePath) { throw 'ImagePath required' }
$resolved = (Resolve-Path -LiteralPath $ImagePath).Path
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
function Await-Operation($Operation, $ResultType) {
  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
  $task = $method.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
  $task.Wait()
  return $task.Result
}
$file = Await-Operation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($resolved)) ([Windows.Storage.StorageFile])
$stream = Await-Operation ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
try {
  $decoder = Await-Operation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await-Operation ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $converted = [Windows.Graphics.Imaging.SoftwareBitmap]::Convert($bitmap, [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)
  if ($Language) {
    $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($Language))
  } else { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
  if (!$engine) { throw 'No local OCR recognizer for selected language; install Windows language OCR feature manually' }
  if ($converted.PixelWidth -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension -or $converted.PixelHeight -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension) { throw 'Image exceeds Windows OCR dimension limit; split long image before recognition' }
  $result = Await-Operation ($engine.RecognizeAsync($converted)) ([Windows.Media.Ocr.OcrResult])
  @{ ok = $true; engine = 'Windows.Media.Ocr'; language = $engine.RecognizerLanguage.LanguageTag; text = ($result.Lines | ForEach-Object { $_.Text }) -join "`n"; lines = @($result.Lines | ForEach-Object { @{ text = $_.Text; words = @($_.Words | ForEach-Object { @{ text = $_.Text; x = $_.BoundingRect.X; y = $_.BoundingRect.Y; width = $_.BoundingRect.Width; height = $_.BoundingRect.Height } }) } }); confidence = $null; requiresReview = $true } | ConvertTo-Json -Depth 8 -Compress
  $converted.Dispose()
  $bitmap.Dispose()
} finally { $stream.Dispose() }
