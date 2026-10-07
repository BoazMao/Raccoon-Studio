param([string]$Python = "python", [ValidateSet("cpu", "cuda")][string]$Profile = "cpu")
$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$environmentPath = Join-Path $projectRoot ".tools\whisperx"
& $Python -c "import sys; assert sys.version_info[:2] == (3,12), 'The locked runtime requires Python 3.12. Use Settings for automatic private Python installation.'"
if ($LASTEXITCODE -ne 0) { throw "Python 3.12 is required for this manual setup. The Settings installer installs it automatically." }
& $Python -m venv $environmentPath
if ($LASTEXITCODE -ne 0) { throw "Could not create the WhisperX environment." }
$environmentPython = Join-Path $environmentPath "Scripts\python.exe"
& $environmentPython -m pip install --only-binary :all: --require-hashes --find-links (Join-Path $PSScriptRoot "speech-runtime\wheels") -r (Join-Path $PSScriptRoot "speech-runtime\$Profile.txt")
if ($LASTEXITCODE -ne 0) { throw "WhisperX installation failed. Check the pip output above." }
Write-Output "WhisperX Python executable: $environmentPython"
Write-Output "Choose Use a custom Python environment in Settings, select this executable, then use Check WhisperX setup. Models download on first use. Profile: $Profile."
