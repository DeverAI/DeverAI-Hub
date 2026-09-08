# DeverAI Hub + Model Router deployer: sync packages -> profile web,
# wire junctions + patch rows. Idempotent; takes a timestamped profile
# backup before touching anything.
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File deploy.ps1
$ErrorActionPreference = 'Stop'

$work = Split-Path -Parent $MyInvocation.MyCommand.Path
$dshHome = $env:DSH_HOME; if (-not $dshHome) { $dshHome = Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome 'profiles\web'
$nmDir = Join-Path $profileDir 'node_modules'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

# name -> source directory under $work
$packages = [ordered]@{
    'deverai-hub'         = 'plugin'
    'deverai-model-router' = 'packages\model-router'
}

Write-Host "[1] backup profile -> backups\profiles-web-$stamp.zip"
# Filter out non-existent paths and broken junctions (e.g. user deleted a plugin
# directory before re-deploying, leaving a dangling junction in node_modules).
# Also exclude node_modules itself — it can be regenerated and may contain
# broken junctions that Compress-Archive cannot handle.
$existingPaths = @(Get-ChildItem -Path $profileDir -Force -ErrorAction SilentlyContinue | Where-Object {
    if ($_.Name -eq 'node_modules') { return $false }
    if ($_.PSIsContainer -and $_.Target) { return (Test-Path $_.Target) }
    return $true
} | ForEach-Object { $_.FullName })
if ($existingPaths.Count -gt 0) {
    Compress-Archive -Path $existingPaths -DestinationPath (Join-Path $work "backups\profiles-web-$stamp.zip") -Force
} else {
    Write-Host "    (profile dir empty — no backup taken)"
}

# BOM-less UTF-8 writer: Node JSON.parse rejects BOM, so never use Set-Content here.
function Write-NoBom([string]$Path, [string]$Text) {
    [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

foreach ($name in $packages.Keys) {
    $src = Join-Path $work $packages[$name]
    $dst = Join-Path $profileDir $name
    $junctionPath = Join-Path $nmDir "@deverai\$($name -replace '^deverai-', '')"

    Write-Host "[copy] $name"
    New-Item -ItemType Directory -Force -Path $dst | Out-Null
    Copy-Item -Path (Join-Path $src '*') -Destination $dst -Recurse -Force

    Write-Host "[junction] @deverai/$($name -replace '^deverai-', '')"
    if (-not (Test-Path $junctionPath)) {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $junctionPath) | Out-Null
        New-Item -ItemType Junction -Path $junctionPath -Target $dst | Out-Null
        Write-Host "    created junction -> $dst"
    } else {
        $currentTarget = (Get-Item $junctionPath).Target
        if ($currentTarget -and ($currentTarget[0] -ne $dst)) {
            Remove-Item $junctionPath -Force
            New-Item -ItemType Junction -Path $junctionPath -Target $dst | Out-Null
            Write-Host "    re-pointed junction -> $dst"
        } else {
            Write-Host '    junction already correct'
        }
    }

    Write-Host "[deps] package.json += @deverai/$($name -replace '^deverai-', '')"
    $pkgPath = Join-Path $profileDir 'package.json'
    $pkgRaw = [System.IO.File]::ReadAllText($pkgPath)
    $pkg = ($pkgRaw.TrimStart([char]0xFEFF) | ConvertFrom-Json)
    if (-not $pkg.dependencies) { $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) }
    $depName = "@deverai/$($name -replace '^deverai-', '')"
    if (-not $pkg.dependencies.$depName) {
        $pkg.dependencies | Add-Member -NotePropertyName $depName -NotePropertyValue 'workspace:*' -Force
    } else {
        $pkg.dependencies.$depName = 'workspace:*'
    }
    Write-NoBom $pkgPath (($pkg | ConvertTo-Json -Depth 10) + "`n")

    Write-Host "[workspace] pnpm-workspace.yaml += $name"
    $wsPath = Join-Path $profileDir 'pnpm-workspace.yaml'
    $ws = [System.IO.File]::ReadAllText($wsPath).TrimStart([char]0xFEFF)
    if ($ws -notmatch [regex]::Escape($name)) {
        $ws = $ws -replace '(?m)^packages:\s*$', "packages:`n  - $name"
        if ($ws -notmatch [regex]::Escape($name)) { throw "failed to patch pnpm-workspace.yaml for $name" }
        Write-NoBom $wsPath $ws
        Write-Host "    added - $name"
    } else {
        Write-Host '    already present'
    }
}

Write-Host '[patch] cordis.patch.yml insert row (SINGLE row per package)'
# SINGLE row per package: the loader runs apply for EVERY row of a package, so
# a second `client: true` row would double-register routes and fail the boot.
# The web graph discovers client halves automatically via dsh.client.
$patchPath = Join-Path $profileDir 'cordis.patch.yml'
$rowsBlocks = foreach ($name in $packages.Keys) {
    @(
        '- insert:',
        "    - id: $name",
          "      name: '@deverai/$($name -replace '^deverai-', '')'"
    ) -join "`n"
}
$allRows = $rowsBlocks -join "`n"
$patch = [System.IO.File]::ReadAllText($patchPath).TrimStart([char]0xFEFF)
$needsInsert = @($packages.Keys | Where-Object { $patch -notmatch [regex]::Escape($_) })
if ($needsInsert.Count -gt 0) {
    $trimmed = $patch.TrimEnd()
    if ($trimmed -in @('', '[]')) {
        Write-NoBom $patchPath ($allRows + "`n")
    } elseif ($trimmed.EndsWith(']') -and $trimmed.StartsWith('[')) {
        $inner = $trimmed.Substring(1, $trimmed.Length - 2).Trim()
        Write-NoBom $patchPath ($inner + "`n" + $allRows + "`n")
    } else {
        # Append only the missing blocks, keeping the file block-style.
        $append = ($needsInsert | ForEach-Object {
            @('- insert:', "    - id: $_", "      name: '@deverai/$($_ -replace '^deverai-', '')'") -join "`n"
        }) -join "`n"
        Write-NoBom $patchPath ($trimmed + "`n" + $append + "`n")
    }
    Write-Host "    inserted rows for: $($needsInsert -join ', ')"
} else {
    Write-Host '    all rows already present'
}

Write-Host '[sanity] node resolves every @deverai/* package from profile dir'
Push-Location $profileDir
try {
    foreach ($name in $packages.Keys) {
        $short = "@deverai/$($name -replace '^deverai-', '')"
        node --input-type=module -e "import('$short').then(m => { if (!m.apply || !m.inject) throw new Error('bad module'); console.log('resolved:', m.name); }).catch(e => { console.error('RESOLVE FAILED:', e.message); process.exit(1); })"
        if ($LASTEXITCODE -ne 0) { throw "module resolution failed for $short" }
    }
} finally {
    Pop-Location
}

Write-Host 'DEPLOY OK. Official launcher keeps stock behavior (router env-gated);'
Write-Host 'start-deverai.cmd launches the fork with DEVERAI_ROUTER=1.'
