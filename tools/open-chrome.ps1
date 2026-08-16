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

# Define the standard paths to search for chrome
$standardPaths = @(
    "C:\Program Files\Google\Chrome\Application\chrome.exe",
    "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)

$chrome = $null

# Check the standard paths first (fastest method)
foreach ($path in $standardPaths) {
    if (Test-Path $path) {
        $chrome = $path
        break
    }
}

# Check the Registry next if not found in standard location
If ($null -eq $chrome) {
    $regPaths = @(
        "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"
        "HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"
    )
    foreach ($regPath in $regPaths) {
        if (Test-Path $regPath) {
            $chrome = (Get-ItemProperty -Path $regPath).'(default)'
            if ($chrome -and (Test-Path $chrome)) {break}
        }
    }
    # Discard a stale/invalid registry value so the drive-search and
    # not-found checks below still trigger instead of being skipped.
    if ($chrome -and -not (Test-Path $chrome)) {
        $chrome = $null
    }
}

# Search likely install locations if still not found. Bounded to a handful of
# roots with a depth limit (rather than a full drive recurse) so a custom
# install location can still be found without scanning the entire disk.
if ($null -eq $chrome) {
    Write-Host "Chrome not found in standard paths or registry. Searching common install locations..." -ForegroundColor Yellow
    $searchRoots = @(
        $env:ProgramFiles,
        ${env:ProgramFiles(x86)},
        $env:LOCALAPPDATA,
        $env:ProgramData
    ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique

    foreach ($root in $searchRoots) {
        $found = Get-ChildItem -Path $root -Filter "chrome.exe" -Recurse -Depth 5 -ErrorAction SilentlyContinue -Force | Select-Object -First 1
        if ($found) {
            $chrome = $found.FullName
            break
        }
    }
}

# If Chrome cannot be found on the system at all
if ($null -eq $chrome) {
    Write-Error "chrome.exe does not exist on this system."
    exit 1
}

# --new-window forces a regular tabbed browser window on the default profile
# (no --app, so it's never a PWA app window). Default profile keeps Sub signed
# in and the extension installed.
Start-Process $chrome -ArgumentList "--new-window", $Url
Write-Host "Opened a normal Chrome window -> $Url"
