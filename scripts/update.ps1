# Self-update check for the biometric agent - Windows equivalent of
# update.sh. Meant to run on a schedule (Task Scheduler), not as the
# long-running agent process itself. See update.sh's header comment for
# why this is a "pull on a timer" design rather than a push/webhook one.
$ErrorActionPreference = "Stop"

Set-Location (Join-Path $PSScriptRoot "..")
$repoDir = Get-Location
Write-Host "[update.ps1] Checking for updates in $repoDir..."

git fetch origin main --quiet

$localHead = (git rev-parse HEAD).Trim()
$remoteHead = (git rev-parse origin/main).Trim()

if ($localHead -eq $remoteHead) {
    Write-Host "[update.ps1] Already up to date ($localHead)."
    exit 0
}

Write-Host "[update.ps1] New commit(s) found: $localHead -> $remoteHead"

$dirty = git status --porcelain
if ($dirty) {
    Write-Error "[update.ps1] Local working tree has uncommitted changes - refusing to pull. Resolve manually (git status), then re-run."
    exit 1
}

$depsChanged = $false
$diff = git diff --name-only $localHead $remoteHead -- package.json package-lock.json
if ($diff) {
    $depsChanged = $true
}

git pull --ff-only origin main

if ($depsChanged) {
    Write-Host "[update.ps1] package.json/package-lock.json changed - running npm install..."
    npm install
}

Write-Host "[update.ps1] Update applied ($remoteHead). Restarting agent..."

$serviceName = "IronMartBiometricAgent"
$svc = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($svc) {
    Restart-Service -Name $serviceName -Force
    Write-Host "[update.ps1] Restarted Windows service '$serviceName'."
} else {
    $task = Get-ScheduledTask -TaskName $serviceName -ErrorAction SilentlyContinue
    if ($task) {
        Stop-ScheduledTask -TaskName $serviceName -ErrorAction SilentlyContinue
        Start-ScheduledTask -TaskName $serviceName
        Write-Host "[update.ps1] Restarted via Scheduled Task '$serviceName'."
    } else {
        Write-Warning "[update.ps1] No service or scheduled task named '$serviceName' found - restart the agent manually. (If you followed README.md's Windows setup, this branch shouldn't run - check the name matches.)"
    }
}
