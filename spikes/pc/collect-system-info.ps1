<#
  Read-only inventory of the machine for planning the 3D assistant stage (Unreal or Unity) and the voice stack.
  Changes nothing, installs nothing, sends nothing. Run in PowerShell 5.1 or 7:
      powershell -ExecutionPolicy Bypass -File .\collect-system-info.ps1
  Writes system-info.json next to the script and prints a short summary.
  NOT YET RUN: written on a Linux machine without PowerShell, so a typo is possible; fix and re-run if it errors.
#>
$ErrorActionPreference = 'SilentlyContinue'

function Get-Ver($cmd, $args) {
  $p = Get-Command $cmd -ErrorAction SilentlyContinue
  if (-not $p) { return $null }
  try { return (& $cmd @args 2>&1 | Select-Object -First 1).ToString().Trim() } catch { return 'present (version unreadable)' }
}

$os   = Get-CimInstance Win32_OperatingSystem
$cpu  = Get-CimInstance Win32_Processor | Select-Object -First 1
$ram  = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
$gpus = Get-CimInstance Win32_VideoController | ForEach-Object {
  [pscustomobject]@{ name = $_.Name; driver = $_.DriverVersion; adapterRamMB = [math]::Round($_.AdapterRAM / 1MB) }
}

# nvidia-smi gives the real VRAM, driver and CUDA runtime (Win32_VideoController caps AdapterRAM at 4 GB).
$smi = $null
$smiCmd = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if ($smiCmd) {
  $smi = (& nvidia-smi --query-gpu=name,driver_version,memory.total,memory.used,pcie.link.gen.current,power.limit --format=csv,noheader 2>&1) -join "`n"
  $smiFull = (& nvidia-smi 2>&1 | Select-String 'CUDA Version') -join ''
}

# Unreal Engine installs (launcher and source builds register here)
$ue = @()
Get-ChildItem 'HKLM:\SOFTWARE\EpicGames\Unreal Engine' -ErrorAction SilentlyContinue | ForEach-Object {
  $ue += [pscustomobject]@{ version = $_.PSChildName; dir = (Get-ItemProperty $_.PSPath).InstalledDirectory }
}
$epicLauncher = Test-Path "${env:ProgramFiles(x86)}\Epic Games\Launcher"

# Unity Hub and editors
$hubPaths = @("$env:ProgramFiles\Unity Hub\Unity Hub.exe", "${env:ProgramFiles(x86)}\Unity Hub\Unity Hub.exe")
$unityEditors = @()
Get-ChildItem "$env:ProgramFiles\Unity\Hub\Editor" -ErrorAction SilentlyContinue | ForEach-Object { $unityEditors += $_.Name }

# Visual Studio Build Tools (needed for Unreal C++ and native Node addons)
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vs = $null
if (Test-Path $vswhere) { $vs = (& $vswhere -latest -products * -property displayName, installationVersion) -join ' ' }

$drive = Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Free -ne $null } | ForEach-Object {
  [pscustomobject]@{ drive = $_.Name; freeGB = [math]::Round($_.Free / 1GB); usedGB = [math]::Round($_.Used / 1GB) }
}

$info = [ordered]@{
  collectedAt = (Get-Date).ToString('s')
  os          = "$($os.Caption) $($os.Version) build $($os.BuildNumber)"
  cpu         = "$($cpu.Name) ($($cpu.NumberOfCores) cores, $($cpu.NumberOfLogicalProcessors) threads)"
  ramGB       = $ram
  gpus        = $gpus
  nvidiaSmi   = $smi
  cudaRuntime = $smiFull
  unreal      = $ue
  epicLauncherInstalled = $epicLauncher
  unityHubInstalled     = [bool]($hubPaths | Where-Object { Test-Path $_ })
  unityEditors          = $unityEditors
  visualStudio          = $vs
  disks       = $drive
  tools       = [ordered]@{
    git     = Get-Ver 'git' @('--version')
    node    = Get-Ver 'node' @('--version')
    pnpm    = Get-Ver 'pnpm' @('--version')
    python  = Get-Ver 'python' @('--version')
    claude  = Get-Ver 'claude' @('--version')
    ffmpeg  = Get-Ver 'ffmpeg' @('-version')
    cmake   = Get-Ver 'cmake' @('--version')
    nvcc    = Get-Ver 'nvcc' @('--version')
  }
  # Audio devices matter for the voice loop (echo, latency).
  audio = (Get-CimInstance Win32_SoundDevice | ForEach-Object { $_.Name })
}

$out = Join-Path $PSScriptRoot 'system-info.json'
$info | ConvertTo-Json -Depth 6 | Set-Content -Path $out -Encoding UTF8
Write-Host "Wrote $out"
Write-Host ("OS:   " + $info.os)
Write-Host ("CPU:  " + $info.cpu + ", RAM " + $info.ramGB + " GB")
Write-Host ("GPU:  " + ($gpus | ForEach-Object { $_.name }) -join ', ')
if ($smi) { Write-Host ("SMI:  " + $smi) }
Write-Host ("UE:   " + $(if ($ue.Count) { ($ue | ForEach-Object { $_.version }) -join ', ' } else { 'none found' }))
Write-Host ("Unity editors: " + $(if ($unityEditors.Count) { $unityEditors -join ', ' } else { 'none found' }))
