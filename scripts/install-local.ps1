# Build the installer from this checkout, replace the installed GitView with
# it, and start the new one. `npm run install:local` types this into the
# repository's shell; it is not called `install` because npm runs a script of
# that name on every `npm install` and `npm ci`, and CI would build an installer
# and try to launch it on the runner.
$ErrorActionPreference = "Stop"

# rustc cannot find link.exe on a machine where vswhere does not report the
# C++ tools, so the build runs under vcvars64.bat when there is one. CI and a
# machine with a working Visual Studio install skip this branch.
$vcvars = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if (Test-Path $vcvars) {
    cmd /c "`"$vcvars`" >nul && npm run build"
} else {
    cmd /c "npm run build"
}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# The bundle folder keeps every installer ever built, so take the newest rather
# than a filename that stops matching at the next version bump.
$bundle = Join-Path $PSScriptRoot "..\src-tauri\target\release\bundle\nsis"
$setup = Get-ChildItem (Join-Path $bundle "*-setup.exe") | Sort-Object LastWriteTime | Select-Object -Last 1
if (-not $setup) {
    Write-Error "The build finished but left no *-setup.exe in $bundle"
    exit 1
}

# `installMode` is `currentUser` in tauri.conf.json, which is this folder.
$app = Join-Path $env:LOCALAPPDATA "GitView\gitview.exe"

# The installer is Tauri's NSIS build. `/P` is passive mode: a progress bar,
# no pages, and the running GitView is closed without a prompt. Closing it
# also closes the terminal this script is typed into, so the wait and the
# relaunch happen in a PowerShell of their own, started with a console of its
# own so it outlives the one that dies. The installer's `/R` flag is supposed
# to do the relaunch itself and does nothing on this machine, see the wiki.
Write-Host "Installing $($setup.Name), then starting GitView"
$then = "Start-Process '$($setup.FullName)' -ArgumentList '/P' -Wait; Start-Process '$app'"
Start-Process powershell -WindowStyle Hidden -ArgumentList "-NoProfile", "-Command", $then
