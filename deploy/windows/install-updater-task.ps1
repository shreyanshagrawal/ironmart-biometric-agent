# Registers ONLY the updater Scheduled Task (checks GitHub every 15 min and
# restarts the agent if a new commit was pulled). Use this if you installed
# the main agent via NSSM (install-nssm-service.ps1) instead of
# install-tasks.ps1's all-Task-Scheduler path - update.ps1 already knows how
# to detect and restart either an NSSM service or a Scheduled Task by name,
# so this same updater task works with both setups.
#
# Run as Administrator:
#   powershell -ExecutionPolicy Bypass -File deploy\windows\install-updater-task.ps1

$ErrorActionPreference = "Stop"

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "This script must be run as Administrator."
    exit 1
}

$repoDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$psPath = (Get-Command powershell).Source
$updaterTaskName = "IronMartBiometricAgentUpdater"

$action = New-ScheduledTaskAction -Execute $psPath `
    -Argument "-ExecutionPolicy Bypass -File `"$repoDir\scripts\update.ps1`"" `
    -WorkingDirectory $repoDir
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration ([TimeSpan]::MaxValue)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask -TaskName $updaterTaskName `
    -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description "Checks GitHub for a new IronMart biometric agent commit every 15 min and restarts the agent if found." `
    -Force | Out-Null

Write-Host "Registered scheduled task '$updaterTaskName' (runs every 15 min, starting now)."
Start-ScheduledTask -TaskName $updaterTaskName
