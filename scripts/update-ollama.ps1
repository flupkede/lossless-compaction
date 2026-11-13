# One-shot ollama update for the fast-compaction judge.
# Stops the fast-compaction-ollama service, replaces ollama.exe from the official
# GitHub release zip, restarts the service, then refreshes the shim via the repo's
# idempotent start-shim.ps1. Self-elevates: service control needs admin.
# Source of truth: C:\WorkArea\AI\fast-compaction\scripts\update-ollama.ps1
# Deployed copy:    C:\Users\<user>\.local\bin\update-ollama.ps1
$ErrorActionPreference = 'Stop'
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  Start-Process powershell -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-NoExit','-File',$PSCommandPath)
  exit
}
$dir = Join-Path $env:LOCALAPPDATA 'Programs\Ollama'
$exe = Join-Path $dir 'ollama.exe'
$repo = 'C:\WorkArea\AI\fast-compaction'

$current = (& $exe --version) -join ' '
if ($current -match '(\d+(\.\d+)+)') { $current = $Matches[1] }
$latest = (Invoke-RestMethod 'https://api.github.com/repos/ollama/ollama/releases/latest').tag_name -replace '^v',''
Write-Host "installed: $current | latest: $latest"

if ($current -ne $latest) {
  Write-Host 'stopping service...'
  sc.exe stop fast-compaction-ollama | Out-Null
  Start-Sleep 5
  taskkill /F /IM ollama.exe 2>$null
  Start-Sleep 2
  $zip = Join-Path $env:TEMP 'ollama-windows-amd64.zip'
  Write-Host "downloading $latest..."
  Invoke-WebRequest -UseBasicParsing 'https://github.com/ollama/ollama/releases/latest/download/ollama-windows-amd64.zip' -OutFile $zip
  Write-Host "extracting over $dir..."
  Expand-Archive -Path $zip -DestinationPath $dir -Force
  Remove-Item $zip -Force
  Write-Host 'starting service...'
  sc.exe start fast-compaction-ollama | Out-Null
} else {
  Write-Host 'already up to date - refreshing the shim only'
}

$up = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep 2
  if (Get-NetTCPConnection -LocalPort 11434 -State Listen -ErrorAction SilentlyContinue) { $up = $true; break }
}
if (-not $up) { Write-Host 'ERROR: ollama not listening on 11434 after 40s - check services.msc'; exit 1 }
Write-Host "ollama up: $((& $exe --version) -join ' ')"

# shim: restart its service when present, else the manual script
$shimService = Get-Service -Name 'fast-compaction-shim' -ErrorAction SilentlyContinue
if ($shimService) {
  sc.exe stop fast-compaction-shim | Out-Null
  Start-Sleep 3
  sc.exe start fast-compaction-shim | Out-Null
} else {
  & (Join-Path $repo 'scripts\start-shim.ps1')
}
$shimUp = $false
for ($i = 0; $i -lt 15; $i++) {
  Start-Sleep 2
  if (Get-NetTCPConnection -LocalPort 11435 -State Listen -ErrorAction SilentlyContinue) { $shimUp = $true; break }
}
if (-not $shimUp) { Write-Host 'ERROR: shim not listening on 11435 - check services.msc'; exit 1 }
Write-Host 'done: service + shim verified'
