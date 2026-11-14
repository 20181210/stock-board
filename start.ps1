$ErrorActionPreference = 'Stop'
$projectDirectory = $PSScriptRoot
$address = 'http://127.0.0.1:8765'
function Open-ChartApp {
    $browserCandidates = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
    )
    foreach ($browserExecutable in $browserCandidates) {
        if (Test-Path -LiteralPath $browserExecutable) {
            Start-Process -FilePath $browserExecutable -ArgumentList @("--app=$address", '--window-size=1440,960')
            return
        }
    }
    Start-Process $address
}
try {
    $health = Invoke-RestMethod "$address/api/health" -TimeoutSec 2
    if ($health.app -eq 'free-chart') { Open-ChartApp; exit 0 }
} catch { }
$pythonExecutable = (Get-Command python -ErrorAction Stop).Source
$serverPath = Join-Path $projectDirectory 'server.py'
Start-Process -FilePath $pythonExecutable -ArgumentList @('"' + $serverPath + '"') -WorkingDirectory $projectDirectory -WindowStyle Hidden -RedirectStandardOutput (Join-Path $projectDirectory 'server.log') -RedirectStandardError (Join-Path $projectDirectory 'server-error.log') | Out-Null
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 250
    try {
        $health = Invoke-RestMethod "$address/api/health" -TimeoutSec 1
        if ($health.app -eq 'free-chart') { Open-ChartApp; exit 0 }
    } catch { }
}
throw 'Server failed to start. See server-error.log, or try python server.py --port 8766.'
