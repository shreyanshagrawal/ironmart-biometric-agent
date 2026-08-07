# Self-update check for the biometric agent - Windows equivalent of
# update.sh. Meant to run on a schedule (Task Scheduler), not as the
# long-running agent process itself. See update.sh's header comment for
# why this is a "pull on a timer" design rather than a push/webhook one.
#
# Runs unattended as SYSTEM via the IronMartBiometricAgentUpdater Scheduled
# Task, which captures no stdout/stderr of its own -- a failure was
# genuinely invisible before this, showing only as LastTaskResult=1 with no
# way to know why. Everything below is now also written to logs\update.log
# (Start-Transcript), and the whole body runs inside try/catch/finally so a
# real error is captured with its full message and stack, not silently lost.

$ErrorActionPreference = "Stop"

$repoDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$logDir = Join-Path $repoDir "logs"
if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir | Out-Null
}
$logFile = Join-Path $logDir "update.log"

Start-Transcript -Path $logFile -Append | Out-Null

try {
    Set-Location $repoDir
    Write-Host "[update.ps1] $(Get-Date -Format o) Checking for updates in $repoDir..."

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
        Write-Host "[update.ps1] ERROR: Local working tree has uncommitted changes - refusing to pull. Dirty files:"
        Write-Host $dirty
        Write-Host "[update.ps1] Resolve manually (git status), then re-run."
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
            Write-Host "[update.ps1] WARNING: No service or scheduled task named '$serviceName' found - restart the agent manually. (If you followed README.md's Windows setup, this branch shouldn't run - check the name matches.)"
        }
    }
} catch {
    # $_ is the real ErrorRecord -- .Exception.Message alone often hides the
    # actually useful part (which external command failed, native exit code,
    # etc.), so log the full record plus a stack trace where one exists.
    Write-Host "[update.ps1] FAILED: $($_.Exception.Message)"
    Write-Host "[update.ps1] Full error record: $($_ | Out-String)"
    if ($_.ScriptStackTrace) {
        Write-Host "[update.ps1] Stack trace: $($_.ScriptStackTrace)"
    }
    exit 1
} finally {
    Stop-Transcript | Out-Null
}
