# export-logs.ps1
# Exporta los logs de los contenedores Docker a archivos .txt con fecha

param(
  [string]$Since = "72h"
)

$date = Get-Date -Format "yyyy-MM-dd_HH-mm"
$logsDir = "$PSScriptRoot\..\logs"

if (-not (Test-Path $logsDir)) {
  New-Item -ItemType Directory -Path $logsDir | Out-Null
}

Write-Host "Exportando logs desde hace $Since..."

docker logs drive-doc-processor-scheduler-1 --since $Since 2>&1 |
  Out-File -FilePath "$logsDir\scheduler_$date.txt" -Encoding UTF8

docker logs drive-doc-processor-worker-1 --since $Since 2>&1 |
  Out-File -FilePath "$logsDir\worker_$date.txt" -Encoding UTF8

docker logs drive-doc-processor-web-1 --since $Since 2>&1 |
  Out-File -FilePath "$logsDir\web_$date.txt" -Encoding UTF8

Write-Host "Logs exportados en $logsDir"
