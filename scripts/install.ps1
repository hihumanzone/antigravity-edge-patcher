param (
    [switch]$Force
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$InstallJs = Join-Path $ScriptDir "install.js"

$argsList = @()
if ($Force) {
    $argsList += "--force"
}

Write-Host "Launching Antigravity Edge Installer..." -ForegroundColor Cyan
node $InstallJs @argsList
