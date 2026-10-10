# Delete the build output nobody needs again. `npm run clean:builds` types this
# into the repository's shell.
#
# Removes:
#   - every installer in target\release\bundle\nsis except the newest, which is
#     the one `install:local` picks and the one the installed app came from
#   - target\debug, the largest folder by far (several GB), which `npm run dev`
#     rebuilds from cold on the next launch
#
# Keeps target\release, so the next `install:local` is still an incremental build.
# Pass -All to drop that too, for a cold release build.
param([switch]$All)
$ErrorActionPreference = "Stop"

$target = Join-Path $PSScriptRoot "..\src-tauri\target"
if (-not (Test-Path $target)) { Write-Host "No target folder, nothing to clean."; exit 0 }
$target = (Resolve-Path $target).Path

# A running dev build holds target\debug\gitview.exe open and Windows refuses
# to delete it, which would leave the folder half removed.
$running = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($target) }
if ($running) {
    Write-Error "Stop these first, they run from target: $(($running | ForEach-Object { "$($_.Name) ($($_.Id))" }) -join ', ')"
    exit 1
}

function Get-Size($path) {
    if (-not (Test-Path $path)) { return 0 }
    (Get-ChildItem $path -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
}

$freed = 0

$nsis = Join-Path $target "release\bundle\nsis"
if (Test-Path $nsis) {
    $setups = Get-ChildItem (Join-Path $nsis "*-setup.exe") | Sort-Object LastWriteTime
    $keep = $setups | Select-Object -Last 1
    foreach ($old in ($setups | Where-Object { $_.FullName -ne $keep.FullName })) {
        Write-Host "Removing installer $($old.Name)"
        $freed += $old.Length
        Remove-Item $old.FullName -Force
    }
    if ($keep) { Write-Host "Keeping installer $($keep.Name)" }
}

$folders = @("debug")
if ($All) { $folders += "release" }
foreach ($name in $folders) {
    $path = Join-Path $target $name
    if (Test-Path $path) {
        $size = Get-Size $path
        Write-Host ("Removing target\{0} ({1:N2} GB)" -f $name, ($size / 1GB))
        $freed += $size
        Remove-Item $path -Recurse -Force
    }
}

Write-Host ("Freed {0:N2} GB" -f ($freed / 1GB))
