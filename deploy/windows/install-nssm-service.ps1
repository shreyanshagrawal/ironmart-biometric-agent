# Alternative to install-tasks.ps1: installs the agent as a real Windows
# Service via NSSM (https://nssm.cc), which starts before any user logs in
# and restarts the instant the process exits, rather than Task Scheduler's
# boot-trigger-only semantics. Requires nssm.exe to already be on PATH or in
# this repo's root (download the "win64" build from nssm.cc/download and
# drop nssm.exe next to package.json).
#
# Run as Administrator:
#   cd C:\ironmart-biometric-agent
#   powershell -ExecutionPolicy Bypass -File deploy\windows\install-nssm-service.ps1

$ErrorActionPreference = "Stop"

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "This script must be run as Administrator."
    exit 1
}

$repoDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$nssm = Get-Command nssm -ErrorAction SilentlyContinue
if (-not $nssm) {
    $localNssm = Join-Path $repoDir "nssm.exe"
    if (Test-Path $localNssm) {
        $nssm = $localNssm
    } else {
        Write-Error "nssm.exe not found on PATH or in $repoDir. Download it from https://nssm.cc/download and place nssm.exe in the repo root, then re-run."
        exit 1
    }
} else {
    $nssm = $nssm.Source
}

$nodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodePath) {
    Write-Error "node.exe not found on PATH. Install Node.js first."
    exit 1
}

$serviceName = "IronMartBiometricAgent"

Write-Host "Installing '$serviceName' as a Windows Service via NSSM..."
& $nssm install $serviceName $nodePath "src\index.js"
& $nssm set $serviceName AppDirectory $repoDir
& $nssm set $serviceName AppEnvironmentExtra "NODE_ENV=production"
& $nssm set $serviceName AppStdout (Join-Path $repoDir "logs\service-stdout.log")
& $nssm set $serviceName AppStderr (Join-Path $repoDir "logs\service-stderr.log")
& $nssm set $serviceName AppRotateFiles 1
& $nssm set $serviceName AppRotateBytes 5242880
& $nssm set $serviceName Start SERVICE_AUTO_START
& $nssm set $serviceName AppRestartDelay 10000

New-Item -ItemType Directory -Force -Path (Join-Path $repoDir "logs") | Out-Null

Write-Host "Starting service..."
Start-Service -Name $serviceName

Write-Host ""
Write-Host "Done. The agent now runs as a real Windows Service ('$serviceName') that starts on boot"
Write-Host "and restarts automatically on crash. Useful commands:"
Write-Host "  Get-Service $serviceName"
Write-Host "  Restart-Service $serviceName"
Write-Host "  Stop-Service $serviceName"
Write-Host "  nssm remove $serviceName confirm   # uninstall"
Write-Host ""
Write-Host "For the auto-update task (checks GitHub every 15 min), still run install-tasks.ps1"
Write-Host "separately — it detects and restarts this NSSM service automatically (see update.ps1)."
