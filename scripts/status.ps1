$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$StatusJs = Join-Path $ScriptDir "status.js"

node $StatusJs
