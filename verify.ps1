# Post-restart verification for DeverAI Hub static plugin.
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File verify.ps1
$ErrorActionPreference = 'Continue'
$base = 'http://127.0.0.1:3080'
$failed = $false

function Probe([string]$Label, [string]$Url, [scriptblock]$Expect) {
    try {
        $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 8
        $ok = & $Expect $response
        if ($ok) { Write-Host "ok  : $Label -> $($response.StatusCode)" }
        else { Write-Host "FAIL: $Label -> unexpected body/status $($response.StatusCode)"; $script:failed = $true }
    } catch {
        Write-Host "FAIL: $Label -> $($_.Exception.Message)"
        $script:failed = $true
    }
}

Probe 'host route /hub/info' "$base/hub/info" {
    param($r) $r.StatusCode -eq 200 -and $r.Content -match '"deverai-hub"'
}
Probe 'workspace endpoint' "$base/hub/workspace" {
    param($r) $r.StatusCode -eq 200 -and $r.Content -match '"root"'
}
Probe 'fs list root' "$base/hub/fs/list?path=." {
    param($r) $r.StatusCode -eq 200
}
Probe 'client bundle served' "$base/plugins/@deverai/hub/client.js" {
    param($r) $r.StatusCode -eq 200 -and ($r.Headers['Content-Type'] -match 'javascript' -or $r.Content -match '__ModuleLoader__')
}
Probe 'index injects client script' "$base/" {
    param($r) $r.StatusCode -eq 200 -and $r.Content -match '@deverai/hub'
}
Probe 'snapshot list' "$base/hub/snapshots" {
    param($r) $r.StatusCode -eq 200 -and $r.Content -match '"items"'
}
Probe 'file checkpoints' "$base/hub/checkpoints" {
    param($r) $r.StatusCode -eq 200 -and $r.Content -match '"items"'
}
Probe 'router state (inert on official launcher)' "$base/router/state" {
    param($r) $r.StatusCode -eq 200 -and $r.Content -match '"gateActive":false'
}

if ($failed) { Write-Host "`nVERIFY FAILED" } else { Write-Host "`nVERIFY OK — open the GUI, look for the Hub button at the sidebar foot." }
