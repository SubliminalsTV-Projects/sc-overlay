# Opens a NORMAL Chrome browser window on Sub's default profile.
#
# Why: the Claude-in-Chrome extension attaches to whatever Chrome window is
# available. When the main browser is closed but the SCFeed PWA (a standalone
# Chrome app window) is still running, the extension binds to the PWA — which
# has no tab groups, so automation fails ("Grouping is not supported by tabs
# in this window"). Launching a real tabbed window fixes that.
#
# Usage:  powershell -ExecutionPolicy Bypass -File tools\open-chrome.ps1 [url]

param([string]$Url = "http://localhost:8778/")

$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) {
    $chrome = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
}
if (-not (Test-Path $chrome)) {
    Write-Error "chrome.exe not found in the standard locations."
    exit 1
}

# --new-window forces a regular tabbed browser window on the default profile
# (no --app, so it's never a PWA app window). Default profile keeps Sub signed
# in and the extension installed.
Start-Process $chrome -ArgumentList "--new-window", $Url
Write-Host "Opened a normal Chrome window -> $Url"
