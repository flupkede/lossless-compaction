# One-time elevated install/start of the fast-compaction shim service (WinSW wrapper).
# Clears any stale listener on 11435 first, then installs + starts the service.
$ErrorActionPreference = 'Continue'
Get-NetTCPConnection -LocalPort 11435 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Start-Sleep 3
$dir = Join-Path $env:USERPROFILE '.fast-compaction'
& (Join-Path $dir 'shim-service.exe') install
& (Join-Path $dir 'shim-service.exe') start
