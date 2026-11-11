# One-time elevated install/start of the fast-compaction ollama service (WinSW wrapper).
# Stops any running ollama first, then installs + starts the service.
$ErrorActionPreference = 'Continue'
taskkill /IM ollama.exe
Start-Sleep 3
taskkill /F /IM ollama.exe
Start-Sleep 10
$exe = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama-service.exe'
& $exe install
& $exe start
