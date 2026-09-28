param (
    [switch]$Force
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$UninstallJs = Join-Path $ScriptDir "uninstall.js"

$argsList = @()
if ($Force) {
    $argsList += "--force"
}

Write-Host "Launching Antigravity Edge Uninstaller..." -ForegroundColor Yellow
node $UninstallJs @argsList
