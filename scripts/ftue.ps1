# Start a dev build as a brand-new install would see it, as many times as it
# takes to review the first run. `npm run dev:ftue -- -Scenario detected`.
#
# Everything the app remembers lives under one folder in the temp directory,
# wiped at the start of each run unless -Keep is given: the database and
# scrollback (GITVIEW_DATA_DIR), the webview's localStorage
# (WEBVIEW2_USER_DATA_FOLDER), and a folder of fixture repositories. The
# installed GitView and its database are never touched, and a separate webview
# folder also keeps the debug port from being swallowed by the installed app's
# browser process.
#
#   -Scenario empty     nothing is found, so the welcome screen offers the picker
#   -Scenario detected  the fixture folder is found, so it is offered as a suggestion
#   -Keep               reuse the last run's state, which is what a second launch is
#   -Port               the WebView2 debug port for a CDP driver, 0 for none
param(
    [ValidateSet("empty", "detected")]
    [string]$Scenario = "detected",
    [switch]$Keep,
    [int]$Port = 9222
)
$ErrorActionPreference = "Stop"

$base = Join-Path $env:TEMP "gitview-ftue\$Scenario"
$data = Join-Path $base "data"
$webview = Join-Path $base "webview"
$projects = Join-Path $base "projects"

function Invoke-Git {
    # Fixture commits are unsigned and carry a fixture identity. Set per
    # command, never globally: the signer on this machine cannot run unattended.
    # Stderr is folded into the output and only shown on failure: PowerShell 5.1
    # turns every stderr line into an error record, and clone's "empty
    # repository" warning would stop the script under -ErrorAction Stop.
    $ErrorActionPreference = "Continue"
    $out = & git.exe -c user.name=Fixture -c user.email=fixture@example.invalid -c commit.gpgsign=false -c init.defaultBranch=main @args 2>&1
    if ($LASTEXITCODE -ne 0) { throw "git $args failed:`n$out" }
}

function New-Fixture([string]$name, [string[]]$files) {
    $origin = Join-Path $projects ".origins\$name.git"
    $work = Join-Path $projects $name
    Invoke-Git init -q --bare $origin
    Invoke-Git clone -q $origin $work
    foreach ($file in $files) {
        Set-Content -Path (Join-Path $work $file) -Value "# $name`n" -Encoding utf8
    }
    Invoke-Git -C $work add -A
    Invoke-Git -C $work commit -q -m "Start $name"
    Invoke-Git -C $work push -q origin main
    return $work
}

if (-not $Keep -or -not (Test-Path $base)) {
    if (Test-Path $base) { Remove-Item -Recurse -Force $base }
    New-Item -ItemType Directory -Force $data, $webview, $projects | Out-Null

    # Three shapes, so the tour has something to point at on each chip: one
    # clean, one with work in progress, one behind its origin.
    New-Fixture "atlas" @("README.md") | Out-Null

    $beacon = New-Fixture "beacon" @("README.md", "index.js")
    Add-Content -Path (Join-Path $beacon "index.js") -Value "console.log('hello');"
    Set-Content -Path (Join-Path $beacon "notes.txt") -Value "todo" -Encoding utf8

    $comet = New-Fixture "comet" @("README.md")
    $ahead = Join-Path $base "comet-elsewhere"
    Invoke-Git clone -q (Join-Path $projects ".origins\comet.git") $ahead
    Add-Content -Path (Join-Path $ahead "README.md") -Value "A change pushed from somewhere else."
    Invoke-Git -C $ahead commit -q -am "Change from another machine"
    Invoke-Git -C $ahead push -q origin main
    Remove-Item -Recurse -Force $ahead
    # A clone reads behind 0 until something fetches, see the wiki.
    Invoke-Git -C $comet fetch -q
}

$detect = if ($Scenario -eq "detected") { $projects } else { "" }

Write-Host "Scenario  $Scenario$(if ($Keep) { ' (kept)' })"
Write-Host "State     $base"
Write-Host "Fixtures  $projects"
if ($Port -gt 0) { Write-Host "CDP       http://localhost:$Port" }

# The children inherit these. Assigning "" in PowerShell deletes a variable
# rather than emptying it, so "nothing found" is a lone `;`, which the Rust side
# splits into no paths at all.
$env:GITVIEW_DATA_DIR = $data
$env:WEBVIEW2_USER_DATA_FOLDER = $webview
$env:GITVIEW_DETECT_ROOTS = if ($detect) { $detect } else { ";" }
if ($Port -gt 0) {
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port"
}

$vcvars = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
Set-Location (Join-Path $PSScriptRoot "..")
if (Test-Path $vcvars) {
    cmd /c "`"$vcvars`" >nul && npx tauri dev"
} else {
    cmd /c "npx tauri dev"
}
exit $LASTEXITCODE
