param(
  [Parameter(Mandatory=$true)]
  [ValidatePattern('^[a-p]{32}$')]
  [string]$ExtensionId
)
$ErrorActionPreference = 'Stop'
$hostName = 'com.streamscout.personal'
$launch = (Resolve-Path (Join-Path $PSScriptRoot 'launch.cmd')).Path
$manifestPath = Join-Path $PSScriptRoot "$hostName.json"
$manifest = @{
  name = $hostName
  description = 'Brook - yt-dlp integration'
  path = $launch
  type = 'stdio'
  allowed_origins = @("chrome-extension://$ExtensionId/")
}
$json = ConvertTo-Json -InputObject $manifest -Depth 4
[System.IO.File]::WriteAllText($manifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))
$regPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
New-Item -Path $regPath -Force | Out-Null
Set-Item -Path $regPath -Value $manifestPath
Write-Host "Motore locale registrato per l'estensione: $ExtensionId" -ForegroundColor Green
Write-Host "Manifest: $manifestPath"
Write-Host 'Verifica yt-dlp: py -3 -m yt_dlp --version'
Write-Host 'Per installare yt-dlp: py -3 -m pip install -U yt-dlp'
Write-Host 'FFmpeg deve essere installato e presente nel PATH per unire audio/video.'
Write-Host 'Chiudi e riapri Chrome, poi premi Analizza questa pagina.'
