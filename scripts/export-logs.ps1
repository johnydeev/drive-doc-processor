# export-logs.ps1 — Exporta logs de Docker a archivos txt con timestamp

param(
    [string]$Since = "72h"
)

$timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm"
$logDir = ".\logs"

if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir | Out-Null
}

Write-Host "Exportando logs (ultimas $Since)..." -ForegroundColor Cyan

$services = @("web", "worker", "scheduler")
foreach ($service in $services) {
    $outFile = "$logDir\${timestamp}_${service}.txt"
    
    # Capturar como bytes crudos y reinterpretar como UTF-8
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "docker"
    $psi.Arguments = "compose logs --no-color --timestamps --since $Since $service"
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    
    $process = [System.Diagnostics.Process]::Start($psi)
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    
    $combined = $stdout + $stderr
    [System.IO.File]::WriteAllText($outFile, $combined, [System.Text.UTF8Encoding]::new($false))
    Write-Host "  OK $service -> $outFile"
}

Write-Host ""
Write-Host "Logs exportados en .\logs\" -ForegroundColor Green