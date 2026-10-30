# Zom's HaRM installer for Windows. Run it by double-clicking "Install HaRM.cmd".
# Everything stays inside the HaRM folder (the app in .venv\, your data in data\), plus
# Start Menu and Desktop shortcuts. Nothing needs administrator rights.
param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
function Say($t) { Write-Host "==> $t" -ForegroundColor Cyan }
function Fail($t) { Write-Host "Error: $t" -ForegroundColor Red; Read-Host 'Press Enter to close'; exit 1 }

$StartMenu = Join-Path ([Environment]::GetFolderPath('Programs')) "Zom's HaRM.lnk"
$Desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) "Zom's HaRM.lnk"

if ($Uninstall) {
  Remove-Item $StartMenu, $Desktop -ErrorAction SilentlyContinue
  Remove-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'Zoms HaRM' -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name like 'python%'" | Where-Object { $_.CommandLine -match 'harm.main:app|harm_launcher' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Say 'Removed the shortcuts and stopped HaRM.'
  Write-Host "Your data is still in $Root\data. Delete the whole HaRM folder to remove everything (back up data\ first if you want to keep it)."
  Read-Host 'Press Enter to close'; exit 0
}

if ($Root -like "$env:ProgramFiles*" -or $Root -like "${env:ProgramFiles(x86)}*") {
  Fail "HaRM keeps its data next to the app, which Windows doesn't allow inside Program Files. Move the HaRM folder to e.g. $env:USERPROFILE\ZomsHaRM and run the installer again."
}

# Find Python 3.10+ (the py launcher first, then python on PATH).
$Py = $null
foreach ($c in @(@('py', '-3'), @('python'))) {
  try {
    $exe = & $c[0] $c[1..9] -c "import sys; print(sys.executable if sys.version_info >= (3, 10) else '')" 2>$null
    if ($LASTEXITCODE -eq 0 -and $exe -and (Test-Path $exe) -and $exe -notmatch 'WindowsApps') { $Py = $exe.Trim(); break }
  } catch {}
}
if (-not $Py) {
  Write-Host "HaRM needs Python 3.10 or newer, and it isn't installed." -ForegroundColor Yellow
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    $a = Read-Host 'Install Python 3.12 now with winget? (Y/n)'
    if ($a -eq '' -or $a -match '^[Yy]') {
      winget install -e --id Python.Python.3.12 --scope user --accept-package-agreements --accept-source-agreements
      $Py = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'
      if (-not (Test-Path $Py)) { Fail 'Python was installed, but HaRM could not find it. Close this window and run the installer again.' }
    }
  }
  if (-not $Py) { Fail 'Install Python from https://www.python.org/downloads/ (tick "Add python.exe to PATH"), then run this installer again.' }
}
Say "Using Python at $Py"

if (-not (Test-Path '.venv\Scripts\python.exe')) {
  Say 'Creating the app environment (.venv)...'
  & $Py -m venv .venv
  if ($LASTEXITCODE -ne 0) { Fail 'Could not create the app environment.' }
}
$VPy = Join-Path $Root '.venv\Scripts\python.exe'
$VPyw = Join-Path $Root '.venv\Scripts\pythonw.exe'
Say 'Installing HaRM and its desktop app (about 150 MB, a few minutes the first time)...'
& $VPy -m pip install --quiet --upgrade pip
& $VPy -m pip install --quiet -r requirements.txt -r requirements-desktop.txt
if ($LASTEXITCODE -ne 0) { Fail 'Installing packages failed. Check your internet connection and try again.' }

Say 'Adding Start Menu and Desktop shortcuts...'
$Shell = New-Object -ComObject WScript.Shell
foreach ($path in @($StartMenu, $Desktop)) {
  $s = $Shell.CreateShortcut($path)
  $s.TargetPath = $VPyw
  $s.Arguments = '"' + (Join-Path $Root 'launcher\harm_launcher.py') + '"'
  $s.WorkingDirectory = $Root
  $s.IconLocation = (Join-Path $Root 'branding\harm.ico') + ',0'
  $s.Description = "Zom's HaRM - Hardware & Rack Manager"
  $s.Save()
}

Write-Host ''
Say "Installed! Open Zom's HaRM from the Start Menu or Desktop, press Start, then Open HaRM."
Write-Host '    The first time HaRM starts, Windows asks about network access: tick Private networks and choose Allow (needed for phones).'
Write-Host '    Guide: GUIDE.md in the HaRM folder.'
$a = Read-Host 'Open HaRM now? (Y/n)'
if ($a -eq '' -or $a -match '^[Yy]') { Start-Process $VPyw -ArgumentList ('"' + (Join-Path $Root 'launcher\harm_launcher.py') + '"') -WorkingDirectory $Root }
