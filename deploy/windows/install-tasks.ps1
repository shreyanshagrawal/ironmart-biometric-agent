# Registers the biometric agent (and its updater) as Windows Scheduled Tasks
# that start automatically on boot - no third-party service wrapper needed.
# Run this once, from an elevated ("Run as Administrator") PowerShell prompt,
# from inside the cloned repo.
#
#   cd C:\ironmart-biometric-agent
#   powershell -ExecutionPolicy Bypass -File deploy\windows\install-tasks.ps1
#
# See README.md's "Windows setup" section for the NSSM alternative if you
# want true Windows-Service semantics (runs before any user logs in, auto-
# restarts the instant it crashes rather than waiting for the next trigger).

$ErrorActionPreference = "Stop"

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "This script must be run as Administrator (right-click PowerShell -> Run as Administrator)."
    exit 1
}

$repoDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$nodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodePath) {
    Write-Error "node.exe not found on PATH. Install Node.js first (https://nodejs.org), then re-run this script."
    exit 1
}

Write-Host "Repo directory: $repoDir"
Write-Host "Node.js: $nodePath"

# --- Main agent task: starts at boot, restarts automatically if it exits ---
$agentTaskName = "IronMartBiometricAgent"
# --env-file=.env is required here: Scheduled Tasks don't load .env on
# their own any more than a plain `node src/index.js` does - see the same
# note in README.md's Quick Start section.
$agentAction = New-ScheduledTaskAction -Execute $nodePath -Argument "--env-file=.env src\index.js" -WorkingDirectory $repoDir
$agentTrigger = New-ScheduledTaskTrigger -AtStartup
$agentSettings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0) # no time limit - this runs forever
$agentPrincipal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask -TaskName $agentTaskName `
    -Action $agentAction -Trigger $agentTrigger -Settings $agentSettings -Principal $agentPrincipal `
    -Description "IronMart biometric agent - polls the ESSL K30 device and syncs punches/user enrollment to the HRMS backend." `
    -Force | Out-Null
Write-Host "Registered scheduled task '$agentTaskName' (starts at boot, runs as SYSTEM)."

# --- Updater task: checks for a new git commit every 15 minutes ---
$updaterTaskName = "IronMartBiometricAgentUpdater"
$psPath = (Get-Command powershell).Source
$updaterAction = New-ScheduledTaskAction -Execute $psPath `
    -Argument "-ExecutionPolicy Bypass -File `"$repoDir\scripts\update.ps1`"" `
    -WorkingDirectory $repoDir
# [TimeSpan]::MaxValue looks like the obvious way to say "repeat forever",
# but it's a real, reproduced bug: it serializes to a Duration of
# P99999999DT23H59M59S in the task's XML, which exceeds what Windows Task
# Scheduler's own schema actually accepts -- Register-ScheduledTask fails
# with "The task XML contains a value which is incorrectly formatted or out
# of range." There's no native "forever" repetition in Task Scheduler; the
# standard, working substitute is a large-but-valid bounded duration. 10
# years is effectively permanent for this use case (re-running
# install-tasks.ps1 at any point resets it anyway).
$updaterTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 3650)
$updaterPrincipal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask -TaskName $updaterTaskName `
    -Action $updaterAction -Trigger $updaterTrigger -Settings $agentSettings -Principal $updaterPrincipal `
    -Description "Checks GitHub for a new IronMart biometric agent commit every 15 min and restarts the agent task if found." `
    -Force | Out-Null
Write-Host "Registered scheduled task '$updaterTaskName' (runs every 15 min)."

Write-Host ""
Write-Host "Starting the agent task now (it will also auto-start on every future boot)..."
Start-ScheduledTask -TaskName $agentTaskName

Write-Host ""
Write-Host "Done. Useful commands:"
Write-Host "  Get-ScheduledTask -TaskName $agentTaskName | Get-ScheduledTaskInfo   # check last run result"
Write-Host "  Stop-ScheduledTask -TaskName $agentTaskName                          # stop the agent"
Write-Host "  Start-ScheduledTask -TaskName $agentTaskName                         # start it again"
Write-Host "  Unregister-ScheduledTask -TaskName $agentTaskName -Confirm:`$false   # remove it entirely"
Write-Host "Logs: $repoDir\logs\agent.log"
