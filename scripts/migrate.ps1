#Requires -Version 5.1
<#
.SYNOPSIS
  Moves Mira into one common folder for VS Code and connects the Unity work you already have.

.DESCRIPTION
  Run it from a fresh clone of this repository; docs/MIGRATION.md has the two commands. The folder that holds the clone is
  the common folder (recommended: %USERPROFILE%\Mira, so the clone is %USERPROFILE%\Mira\ai_assistant). The script:

    1. reports the tools: git, node (22.14 or newer), pnpm, dotnet, Docker, Unity, VS Code;
    2. checks the layout and makes the content folder (<common folder>\content, the models, never in git);
    3. brings over your existing Unity work, from either
         -OldClone      an older clone of this repository where the Unity project was built (the kickoff prompt makes the
                        branch unity-stage-pc and the project unity\MiraStage). Its local branches are fetched, the Unity
                        branch is merged into a new local branch (-WorkBranch, default unity-stage). Nothing is pushed.
         -UnityProject  a Unity project folder somewhere else. It is copied into unity\MiraStage without Library, Temp and
                        the other folders Unity rebuilds, and its Packages\manifest.json is pointed at the package in this
                        repository. Unity layer code it carried (Runtime\Unity, Editor, .meta files) is added to the package.
       Given a folder without saying which, it works out which of the two it is. With neither, it asks (or skips).
    4. installs the JavaScript dependencies and checks the database library (-SkipInstall skips);
    5. opens Mira.code-workspace in VS Code (-NoOpen skips).

  -DryRun reports what it would do and changes nothing. The script never pushes, never deletes or edits your old folders
  (except the one commit -CommitUncommitted asks for), and never reads or writes the stage token.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\migrate.ps1 -OldClone C:\dev\ai_assistant

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\migrate.ps1 -UnityProject "D:\Unity\MiraRoom" -DryRun
#>
[CmdletBinding()]
param(
  [string]$OldClone,
  [string]$UnityProject,
  [string]$UnityBranch,
  [string]$WorkBranch = 'unity-stage',
  [string]$ContentDir,
  [switch]$SetContentEnv,
  [switch]$CommitUncommitted,
  [switch]$CopyLibrary,
  [switch]$SkipInstall,
  [switch]$NoOpen,
  [switch]$DryRun,
  [switch]$NonInteractive
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------------------------------------------- helpers

$onWindows = [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT
$pathComparison = if ($onWindows) { [System.StringComparison]::OrdinalIgnoreCase } else { [System.StringComparison]::Ordinal }

function PathOf {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Parts)
  $p = $Parts[0]
  for ($i = 1; $i -lt $Parts.Count; $i++) { $p = [System.IO.Path]::Combine($p, $Parts[$i]) }
  [System.IO.Path]::GetFullPath($p)
}

function Same-Path([string]$a, [string]$b) {
  if (-not $a -or -not $b) { return $false }
  $x = [System.IO.Path]::GetFullPath($a).TrimEnd('\', '/')
  $y = [System.IO.Path]::GetFullPath($b).TrimEnd('\', '/')
  [string]::Equals($x, $y, $pathComparison)
}

$script:ReportLines = New-Object System.Collections.Generic.List[string]
$script:Todo = New-Object System.Collections.Generic.List[string]

function Say([string]$Kind, [string]$Text) {
  $line = '{0,-7} {1}' -f "[$Kind]", $Text
  $color = switch ($Kind) { 'ok' { 'Green' } 'warn' { 'Yellow' } 'fail' { 'Red' } 'todo' { 'Cyan' } 'would' { 'Magenta' } 'do' { 'White' } default { 'Gray' } }
  Write-Host $line -ForegroundColor $color
  $script:ReportLines.Add($line)
  if ($Kind -eq 'todo') { $script:Todo.Add($Text) }
}

function Section([string]$Title) {
  Write-Host ''
  Write-Host "== $Title"
  $script:ReportLines.Add('')
  $script:ReportLines.Add("== $Title")
}

# Every change goes through Act: in a dry run it is only reported.
function Act([string]$What, [scriptblock]$Do) {
  if ($DryRun) { Say 'would' $What; return }
  Say 'do' $What
  & $Do
}

function Save-Report {
  if ($DryRun) { return }
  try {
    $file = PathOf $Root 'migration-report.txt'
    $head = @("Mira migration report, $(Get-Date -Format 'yyyy-MM-dd HH:mm')", "repository: $RepoDir", '')
    [System.IO.File]::WriteAllLines($file, [string[]]($head + $script:ReportLines), (New-Object System.Text.UTF8Encoding $false))
    Write-Host ''
    Write-Host "Report saved to $file"
  } catch {
    Write-Host "Could not save the report: $($_.Exception.Message)"
  }
}

function Stop-Migration([string]$Why, [int]$Code = 1) {
  Say 'fail' $Why
  Save-Report
  exit $Code
}

# Runs a native program without letting its stderr (git prints progress there) turn into a PowerShell error.
function Invoke-Native([string]$File, [string[]]$Arguments) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = @(& $File @Arguments 2>&1 | ForEach-Object { "$_" })
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prev
  }
  New-Object psobject -Property @{ Code = $code; Lines = $out; Text = ($out -join "`n").Trim() }
}

# Not called Git: PowerShell would resolve 'git' to the function itself instead of git.exe.
function Run-Git([string]$Dir, [string[]]$Arguments) { Invoke-Native 'git' (@('-C', $Dir) + $Arguments) }

function Git-Ok([string]$Dir, [string[]]$Arguments, [string]$What) {
  $r = Run-Git $Dir $Arguments
  if ($r.Code -ne 0) { Stop-Migration "$What failed (git $($Arguments -join ' ')): $($r.Text)" }
  $r
}

function Find-Tool([string]$Name) {
  $c = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return $c.Source }
  $null
}

function Ask([string]$Question, [string]$Default) {
  if (-not $script:Interactive) { return $Default }
  $answer = Read-Host $Question
  if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
  $answer.Trim().Trim('"')
}

function Is-Clone([string]$Dir) {
  (Test-Path -LiteralPath (PathOf $Dir '.git')) -and (Test-Path -LiteralPath (PathOf $Dir 'unity' 'Packages' 'com.mira.stage'))
}

function Is-UnityProject([string]$Dir) {
  Test-Path -LiteralPath (PathOf $Dir 'ProjectSettings' 'ProjectVersion.txt')
}

function Unity-Version([string]$ProjectDir) {
  $file = PathOf $ProjectDir 'ProjectSettings' 'ProjectVersion.txt'
  $m = Select-String -LiteralPath $file -Pattern '^m_EditorVersion:\s*(\S+)' | Select-Object -First 1
  if ($m) { return $m.Matches[0].Groups[1].Value }
  'unknown'
}

function Relative([string]$Base, [string]$Full) {
  $b = [System.IO.Path]::GetFullPath($Base).TrimEnd('\', '/')
  $Full.Substring($b.Length).TrimStart('\', '/')
}

# Files under a folder, as relative paths with forward slashes, skipping build output.
function List-Files([string]$Dir) {
  if (-not (Test-Path -LiteralPath $Dir)) { return @() }
  @(Get-ChildItem -LiteralPath $Dir -Recurse -File -Force | Where-Object {
      $_.FullName -notmatch '[\\/](bin|obj|TestResults|\.vs)[\\/]'
    } | ForEach-Object { (Relative $Dir $_.FullName) -replace '\\', '/' })
}

# Copies a folder tree. Robocopy on Windows (fast, keeps going on long trees), Copy-Item elsewhere.
# $ExcludeDirs are FULL paths of folders to leave out (only those folders, not every folder of the same name).
function Copy-Tree([string]$From, [string]$To, [string[]]$ExcludeDirs = @()) {
  $robocopy = if ($onWindows) { Find-Tool 'robocopy' } else { $null }
  if ($robocopy) {
    $argv = @($From, $To, '/E', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
    if ($ExcludeDirs.Count -gt 0) { $argv += '/XD'; $argv += $ExcludeDirs }
    $r = Invoke-Native $robocopy $argv
    if ($r.Code -ge 8) { Stop-Migration "copying $From failed (robocopy exit $($r.Code)): $($r.Text)" }
    return
  }
  New-Item -ItemType Directory -Force -Path $To | Out-Null
  foreach ($item in Get-ChildItem -LiteralPath $From -Force) {
    $skip = $false
    foreach ($x in $ExcludeDirs) { if (Same-Path $item.FullName $x) { $skip = $true } }
    if ($skip) { continue }
    if ($item.PSIsContainer) {
      Copy-Tree $item.FullName (PathOf $To $item.Name) $ExcludeDirs
    } else {
      Copy-Item -LiteralPath $item.FullName -Destination (PathOf $To $item.Name) -Force
    }
  }
}

# The git blob id this repository would store for a file at a path inside it (our .gitattributes and autocrlf applied).
function Blob-Id([string]$RepoRelPath, [string]$File) {
  $r = Run-Git $RepoDir @('hash-object', "--path=$RepoRelPath", '--', $File)
  if ($r.Code -ne 0) { return $null }
  $r.Lines[-1].Trim()
}

function Blob-Known([string]$Id) {
  if (-not $Id) { return $false }
  (Run-Git $RepoDir @('cat-file', '-e', $Id)).Code -eq 0
}

$BinaryPattern = '\.(png|jpe?g|tga|tiff?|psd|exr|hdr|bmp|gif|wav|mp3|ogg|aiff?|fbx|obj|blend|glb|gltf|vrm|unitypackage|mp4|mov)$'

# --------------------------------------------------------------------------------------------------------------- the paths

$RepoDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$Root = Split-Path -Parent $RepoDir
$UserHome = if ($onWindows) { $env:USERPROFILE } else { $env:HOME }
$RecommendedRoot = PathOf $UserHome 'Mira'
if (-not $ContentDir) { $ContentDir = PathOf $Root 'content' } else { $ContentDir = [System.IO.Path]::GetFullPath($ContentDir) }
$PackageRel = 'unity/Packages/com.mira.stage'
$PackageDir = PathOf $RepoDir 'unity' 'Packages' 'com.mira.stage'
$ProjectDir = PathOf $RepoDir 'unity' 'MiraStage'
$ManifestDependency = 'file:../../Packages/com.mira.stage'
$script:Interactive = (-not $NonInteractive) -and (-not $DryRun) -and [Environment]::UserInteractive -and (-not [Console]::IsInputRedirected)
$script:ExitCode = 0

Write-Host 'Mira: move to one common folder and connect the Unity work'
if ($DryRun) { Write-Host 'DRY RUN: nothing is changed; [would] lines are what a real run does.' -ForegroundColor Magenta }

# ------------------------------------------------------------------------------------------------------------ 1. the tools

Section '1. Tools on this PC'
$gitVersion = Invoke-Native 'git' @('--version')
if ($gitVersion.Code -ne 0) { Stop-Migration 'git is not installed: https://git-scm.com/download/win' }
Say 'ok' $gitVersion.Text

$nodeOk = $false
if (Find-Tool 'node') {
  $v = (Invoke-Native 'node' @('-p', 'process.versions.node')).Text
  $parts = $v.Split('.')
  $nodeOk = ([int]$parts[0] -gt 22) -or ([int]$parts[0] -eq 22 -and [int]$parts[1] -ge 14)
  if ($nodeOk) { Say 'ok' "node $v" } else { Say 'warn' "node $v is too old: 22.14 or newer is needed (https://nodejs.org/)" }
} else {
  Say 'warn' 'node is not installed: Node.js 22.14 or newer is needed for the backend (https://nodejs.org/)'
}
if (Find-Tool 'pnpm') { Say 'ok' "pnpm $((Invoke-Native 'pnpm' @('--version')).Text)" } else { Say 'info' 'pnpm is not on PATH yet (the install step enables it through corepack)' }
if (Find-Tool 'dotnet') { Say 'ok' "dotnet $((Invoke-Native 'dotnet' @('--version')).Text) (C# stage client tests)" } else { Say 'info' 'dotnet not found (optional: the .NET 8 SDK runs the C# stage client tests)' }
if (Find-Tool 'docker') { Say 'ok' ((Invoke-Native 'docker' @('--version')).Text) } else { Say 'info' 'docker not found (optional: start-docker.cmd runs the backend in a container)' }

$editors = @()
if ($onWindows -and $env:ProgramFiles) {
  $hub = PathOf $env:ProgramFiles 'Unity' 'Hub' 'Editor'
  if (Test-Path -LiteralPath $hub) { $editors = @(Get-ChildItem -LiteralPath $hub -Directory | ForEach-Object { $_.Name }) }
}
if ($editors.Count -gt 0) { Say 'ok' "Unity editors: $($editors -join ', ')" } else { Say 'info' 'no Unity editor found in the default Unity Hub folder' }
if (Find-Tool 'unity') { Say 'ok' 'Unity CLI (unity) is on PATH' }

$codeCmd = Find-Tool 'code'
if (-not $codeCmd -and $onWindows -and $env:LOCALAPPDATA) {
  $candidate = PathOf $env:LOCALAPPDATA 'Programs' 'Microsoft VS Code' 'bin' 'code.cmd'
  if (Test-Path -LiteralPath $candidate) { $codeCmd = $candidate }
}
if ($codeCmd) { Say 'ok' "VS Code: $codeCmd" } else { Say 'info' 'VS Code command line (code) not found' }

# ----------------------------------------------------------------------------------------------------------- 2. the layout

Section '2. The common folder'
if (-not (Is-Clone $RepoDir)) { Stop-Migration "$RepoDir does not look like a clone of this repository (no unity\Packages\com.mira.stage)" }
$branch = (Git-Ok $RepoDir @('rev-parse', '--abbrev-ref', 'HEAD') 'reading the branch').Text
$commit = (Git-Ok $RepoDir @('log', '-1', '--format=%h %cs %s') 'reading the last commit').Text
Say 'ok' "common folder: $Root"
Say 'ok' "repository:    $RepoDir (branch $branch, $commit)"
if (-not (Same-Path $Root $RecommendedRoot)) {
  Say 'info' "the recommended common folder is $RecommendedRoot (then Unity finds the models without any setting); this one works too"
}
if ($RepoDir -match '[\\/]OneDrive') {
  Say 'warn' 'this folder is inside OneDrive: syncing node_modules and a Unity project is slow and locks files. Move the clone out of OneDrive.'
}
if ($RepoDir.Length -gt 100) { Say 'warn' "the path is long ($($RepoDir.Length) characters): Unity and node_modules can hit the 260-character limit of Windows" }

if (Test-Path -LiteralPath $ContentDir) {
  Say 'ok' "content folder: $ContentDir"
} else {
  Act "create the content folder $ContentDir (models live here, never in git)" {
    New-Item -ItemType Directory -Force -Path (PathOf $ContentDir 'bases' 'vrm1') | Out-Null
  }
}
$readme = PathOf $ContentDir 'README.txt'
if (-not (Test-Path -LiteralPath $readme)) {
  Act 'write content\README.txt (what goes where)' {
    $text = @(
      'Mira content folder: the binary files of the stage (models, outfits, props). Never put these in git.',
      'The daemon names files by locator; the Unity stage resolves a locator to a file inside this folder.',
      '',
      'bases/vrm1/composed.vrm        the first seeded character (role assistant), a VRM 1.0 file',
      'bases/vrm1/presence-form.vrm   the second seeded character (role user), a VRM 1.0 file',
      'wardrobe/, hair/vrm1/, props/  optional; a missing one only fails its own command',
      '',
      'Adult characters only, with a licence that allows this use. Unity finds this folder through MIRA_CONTENT_DIR,',
      'or by default at %USERPROFILE%\Mira\content. See docs/UNITY.md in the repository.'
    )
    [System.IO.File]::WriteAllLines($readme, [string[]]$text, (New-Object System.Text.UTF8Encoding $false))
  }
}

# Where Unity will look: MIRA_CONTENT_DIR, else <home>\Mira\content (StageContent.DefaultContentRoot).
$envContent = [Environment]::GetEnvironmentVariable('MIRA_CONTENT_DIR')
if ($onWindows -and -not $envContent) { $envContent = [Environment]::GetEnvironmentVariable('MIRA_CONTENT_DIR', 'User') }
$defaultContent = PathOf $UserHome 'Mira' 'content'
$unityContent = if ($envContent) { $envContent } else { $defaultContent }
if (Same-Path $unityContent $ContentDir) {
  Say 'ok' 'Unity finds this content folder without any setting'
} elseif ($SetContentEnv -and $onWindows) {
  Act "set MIRA_CONTENT_DIR=$ContentDir for your Windows account (restart Unity Hub and VS Code afterwards)" {
    [Environment]::SetEnvironmentVariable('MIRA_CONTENT_DIR', $ContentDir, 'User')
  }
} else {
  Say 'todo' "Unity looks for models in $unityContent. Set MIRA_CONTENT_DIR=$ContentDir (run again with -SetContentEnv), or use the recommended common folder"
}
if ((-not (Same-Path $defaultContent $ContentDir)) -and (Test-Path -LiteralPath $defaultContent)) {
  $old = @(Get-ChildItem -LiteralPath $defaultContent -Recurse -File -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne 'README.txt' })
  if ($old.Count -gt 0) { Say 'todo' "$($old.Count) file(s) in the old content folder ${defaultContent}: copy them with  robocopy `"$defaultContent`" `"$ContentDir`" /E" }
}
foreach ($model in 'composed.vrm', 'presence-form.vrm') {
  $f = PathOf $ContentDir 'bases' 'vrm1' $model
  if (Test-Path -LiteralPath $f) { Say 'ok' "model bases/vrm1/$model is in place" } else { Say 'todo' "put a VRM 1.0 model at content\bases\vrm1\$model (the seed catalog asks for it)" }
}

# ----------------------------------------------------------------------------------------------------- 3. the Unity work

Section '3. Your existing Unity work'

# What a folder is: a clone of this repository (or a folder inside one), a Unity project, or a folder with one project in it.
function Resolve-Source([string]$Given) {
  # No trailing separator: Windows PowerShell 5.1 quotes "C:\a b\" so that the backslash escapes the closing quote.
  $full = [System.IO.Path]::GetFullPath($Given)
  if ($full.Length -gt 3) { $full = $full.TrimEnd('\', '/') }
  if (-not (Test-Path -LiteralPath $full)) { Stop-Migration "folder not found: $full" }
  $d = $full
  while ($d) {
    if (Is-Clone $d) { return @{ Kind = 'clone'; Path = $d } }
    $parent = Split-Path -Parent $d
    if (-not $parent -or (Same-Path $parent $d)) { break }
    $d = $parent
  }
  if (Is-UnityProject $full) { return @{ Kind = 'project'; Path = $full } }
  $found = @(Get-ChildItem -LiteralPath $full -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object {
      if (Is-UnityProject $_.FullName) { $_.FullName }
      Get-ChildItem -LiteralPath $_.FullName -Directory -Force -ErrorAction SilentlyContinue | Where-Object { Is-UnityProject $_.FullName } | ForEach-Object { $_.FullName }
    })
  if ($found.Count -eq 1) { return @{ Kind = 'project'; Path = $found[0] } }
  if ($found.Count -gt 1) { Stop-Migration "$full holds several Unity projects; pass the one to move with -UnityProject: $($found -join '; ')" }
  Stop-Migration "$full is neither a clone of this repository nor a Unity project (no ProjectSettings\ProjectVersion.txt)"
}

$sources = @()
if ($OldClone) { $sources += Resolve-Source $OldClone }
if ($UnityProject) { $sources += Resolve-Source $UnityProject }

if ($sources.Count -eq 0) {
  # Older clones in the usual places (the kickoff prompt cloned to C:\dev\ai_assistant).
  $candidates = @()
  foreach ($c in @('C:\dev\ai_assistant', (PathOf $UserHome 'ai_assistant'), (PathOf $UserHome 'source' 'repos' 'ai_assistant'),
                   (PathOf $UserHome 'Documents' 'GitHub' 'ai_assistant'), (PathOf $UserHome 'Desktop' 'ai_assistant'))) {
    if ((Test-Path -LiteralPath $c) -and (Is-Clone $c) -and -not (Same-Path $c $RepoDir)) { $candidates += $c }
  }
  if ($candidates.Count -gt 0) { Say 'info' "older clone(s) found: $($candidates -join '; ')" }
  $default = if ($candidates.Count -gt 0) { $candidates[0] } else { '' }
  $prompt = 'Folder of your existing Unity work (an older clone of ai_assistant, or a Unity project folder)'
  if ($default) { $prompt += " [Enter = $default, '-' = none]" } else { $prompt += ' [Enter = none]' }
  $answer = if ($script:Interactive) { Ask $prompt $default } else { '' }
  if ($answer -and $answer -ne '-') { $sources += Resolve-Source $answer }
}

if (Test-Path -LiteralPath (PathOf $ProjectDir 'ProjectSettings' 'ProjectVersion.txt')) {
  Say 'ok' "this clone already has the Unity project unity\MiraStage (Unity $(Unity-Version $ProjectDir))"
}
if ($sources.Count -eq 0) {
  Say 'info' 'no Unity work given (pass -OldClone or -UnityProject to bring it over)'
}

function Ensure-WorkBranch {
  $exists = (Run-Git $RepoDir @('rev-parse', '--verify', '--quiet', "refs/heads/$WorkBranch")).Code -eq 0
  $current = (Run-Git $RepoDir @('rev-parse', '--abbrev-ref', 'HEAD')).Text
  if ($current -eq $WorkBranch) { return }
  if ($exists) { Stop-Migration "a branch called $WorkBranch already exists here; switch to it (git switch $WorkBranch) or pass -WorkBranch <other name>" }
  Act "create the local branch $WorkBranch from $current (your Unity work lands there; $current stays as it is)" {
    Git-Ok $RepoDir @('switch', '-c', $WorkBranch) 'creating the branch' | Out-Null
  }
}

function Require-CleanRepo {
  $dirty = (Run-Git $RepoDir @('status', '--porcelain', '--untracked-files=no')).Lines | Where-Object { $_ }
  if (@($dirty).Count -gt 0) { Stop-Migration "this clone has uncommitted changes; commit or stash them first: $(@($dirty) -join '; ')" }
}

function Require-Identity {
  $email = (Run-Git $RepoDir @('config', 'user.email')).Text
  if (-not $email) { Stop-Migration 'git does not know who you are (needed for the merge commit): git config --global user.name "Your Name"; git config --global user.email you@example.com' }
}

# Reconciles a copy of com.mira.stage that lived in (or was referenced by) the old Unity project with the package here:
# files only that copy has (the Unity layer, Editor, .meta files) are added; files that differ from every version this
# repository ever had are YOUR edits: they are listed and kept in a backup beside the repository, never overwritten here.
function Merge-PackageCopy([string]$Copy, [string]$Label) {
  $added = 0; $older = 0; $edited = @()
  foreach ($rel in List-Files $Copy) {
    $src = PathOf $Copy $rel
    $dst = PathOf $PackageDir $rel
    if (-not (Test-Path -LiteralPath $dst)) {
      $added++
      if (-not $DryRun) {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
        Copy-Item -LiteralPath $src -Destination $dst
      }
      continue
    }
    $mine = Blob-Id "$PackageRel/$rel" $src
    $here = Blob-Id "$PackageRel/$rel" $dst
    if ($mine -eq $here) { continue }
    if (Blob-Known $mine) { $older++; continue }
    $edited += $rel
  }
  if ($added -gt 0) { if ($DryRun) { Say 'would' "add $added file(s) from $Label to the package (Unity layer, Editor, .meta)" } else { Say 'ok' "added $added file(s) from $Label to the package" } }
  if ($older -gt 0) { Say 'info' "$older file(s) in $Label are older versions of the package files; the newer ones here are kept" }
  if ($edited.Count -gt 0) {
    $backup = PathOf $Root 'migration-backup' ('com.mira.stage-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    Act "back up $Label to $backup" { Copy-Tree $Copy $backup }
    Say 'todo' "$($edited.Count) package file(s) were edited in $Label and differ from this repository; compare them with the backup and bring your changes in by hand: $($edited -join ', ')"
  }
}

function Set-ManifestDependency([string]$Manifest) {
  $text = [System.IO.File]::ReadAllText($Manifest)
  $entry = '"com.mira.stage": "' + $ManifestDependency + '"'
  if ($text -match '"com\.mira\.stage"\s*:\s*"([^"]*)"') {
    if ($Matches[1] -eq $ManifestDependency) { Say 'ok' 'Packages\manifest.json already points at the package in this repository'; return }
    $new = [regex]::Replace($text, '"com\.mira\.stage"\s*:\s*"[^"]*"', $entry.Replace('$', '$$'))
  } elseif ($text -match '"dependencies"\s*:\s*\{') {
    $new = ([regex]'("dependencies"\s*:\s*\{)').Replace($text, ('$1' + "`n    " + $entry + ','), 1)
    $new = [regex]::Replace($new, ',(\s*\})', '$1')
  } else {
    Stop-Migration "$Manifest has no dependencies block; add $entry to it by hand"
  }
  try { $null = $new | ConvertFrom-Json } catch { Stop-Migration "editing $Manifest would break its JSON; add $entry by hand" }
  Act "point Packages\manifest.json at the package in this repository ($ManifestDependency)" {
    [System.IO.File]::WriteAllText($Manifest, $new, (New-Object System.Text.UTF8Encoding $false))
  }
}

function Report-Binaries([string[]]$Paths, [string]$Where) {
  $bin = @($Paths | Where-Object { $_ -match $BinaryPattern })
  if ($bin.Count -eq 0) { return }
  $tracked = @($bin | Where-Object { $_ -notmatch '\.(vrm|glb|gltf|fbx|blend|unitypackage|psd|exr|hdr|wav|mp3|ogg)$' })
  Say 'info' "$($bin.Count) binary file(s) $Where; models, audio and the like are git-ignored by unity\.gitignore"
  if ($tracked.Count -gt 0) {
    Say 'todo' "$($tracked.Count) binary file(s) (textures and the like) are not git-ignored; the project keeps binaries out of git: move them to the content folder or decide before committing: $(($tracked | Select-Object -First 8) -join ', ')"
  }
}

function Import-OldClone([string]$Old) {
  if (Same-Path $Old $RepoDir) { Stop-Migration 'the old clone is this clone; give the folder of the OTHER, older clone' }
  Say 'info' "older clone: $Old"
  $dirty = @((Run-Git $Old @('status', '--porcelain')).Lines | Where-Object { $_ })
  if ($dirty.Count -gt 0) {
    if (-not $CommitUncommitted) {
      Say 'warn' "it has $($dirty.Count) uncommitted change(s): $(($dirty | Select-Object -First 10) -join '; ')"
      Stop-Migration "commit them in the old clone first (git -C `"$Old`" add -A, then git -C `"$Old`" commit -m `"Unity work`"), or run again with -CommitUncommitted"
    }
    Act "commit the $($dirty.Count) uncommitted change(s) in the old clone, on its current branch (git-ignored files such as Library and models stay out)" {
      Git-Ok $Old @('add', '-A') 'staging in the old clone' | Out-Null
      Git-Ok $Old @('commit', '-m', 'Unity work, committed before moving to the common folder') 'committing in the old clone' | Out-Null
    }
  }
  $current = (Git-Ok $Old @('rev-parse', '--abbrev-ref', 'HEAD') 'reading the old branch').Text

  # Branches of the old clone with commits this clone does not have (checked without fetching, so a dry run changes nothing).
  $fresh = @()
  foreach ($line in (Git-Ok $Old @('for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads') 'listing the old branches').Lines) {
    if (-not $line.Trim()) { continue }
    $name, $sha = $line.Trim().Split(' ')
    $known = (Run-Git $RepoDir @('cat-file', '-e', "$sha^{commit}")).Code -eq 0
    $merged = $known -and ((Run-Git $RepoDir @('merge-base', '--is-ancestor', $sha, 'HEAD')).Code -eq 0)
    if (-not $merged) {
      $count = if ($known) { (Run-Git $RepoDir @('rev-list', '--count', "HEAD..$sha")).Text } else { (Run-Git $Old @('rev-list', '--count', $sha, '--not', '--remotes')).Text }
      $fresh += New-Object psobject -Property @{ Name = $name; Sha = $sha; Count = $count }
    }
  }
  if ($fresh.Count -eq 0) {
    Say 'ok' 'every branch of the old clone is already in this clone: nothing to merge'
  } else {
    foreach ($f in $fresh) { Say 'info' ("branch {0} has {1} commit(s) that are not here" -f $f.Name, $f.Count) }
  }

  $pick = $null
  if ($UnityBranch) {
    $pick = $fresh | Where-Object { $_.Name -eq $UnityBranch } | Select-Object -First 1
    if (-not $pick) { Stop-Migration "branch $UnityBranch is not in the old clone or has nothing new" }
  } elseif ($fresh.Count -gt 0) {
    $pick = $fresh | Where-Object { $_.Name -eq 'unity-stage-pc' } | Select-Object -First 1
    if (-not $pick) { $pick = $fresh | Where-Object { $_.Name -eq $current } | Select-Object -First 1 }
    if (-not $pick -and $fresh.Count -eq 1) { $pick = $fresh[0] }
    if (-not $pick) {
      $names = ($fresh | ForEach-Object { $_.Name }) -join ', '
      $answer = Ask "Which branch holds the Unity work? ($names)" ''
      $pick = $fresh | Where-Object { $_.Name -eq $answer } | Select-Object -First 1
      if (-not $pick) { Stop-Migration "several branches have new commits ($names); pass the Unity one with -UnityBranch" }
    }
  }

  if ($pick) {
    Require-CleanRepo
    Require-Identity
    Act 'fetch the old clone''s branches into this clone as pc/<branch> (read only for the old clone)' {
      Git-Ok $RepoDir @('fetch', '--no-tags', $Old, '+refs/heads/*:refs/remotes/pc/*') 'fetching from the old clone' | Out-Null
    }
    Ensure-WorkBranch
    $ref = "refs/remotes/pc/$($pick.Name)"
    if ($DryRun) {
      Say 'would' "merge pc/$($pick.Name) ($($pick.Count) commit(s)) into $WorkBranch"
    } else {
      Say 'do' "merge pc/$($pick.Name) into $WorkBranch"
      $m = Run-Git $RepoDir @('merge', '--no-ff', '--no-edit', '-m', "Merge the Unity work from the old clone (branch $($pick.Name)) into the latest build", $ref)
      if ($m.Code -ne 0) {
        $conflicts = @((Run-Git $RepoDir @('diff', '--name-only', '--diff-filter=U')).Lines | Where-Object { $_ })
        Run-Git $RepoDir @('merge', '--abort') | Out-Null
        Say 'warn' "the merge has conflicts in: $($conflicts -join ', ')"
        Say 'todo' "merge by hand (nothing was lost; the merge was undone):  git switch $WorkBranch  then  git merge pc/$($pick.Name)  and resolve the files above"
        $script:ExitCode = 2
        return
      }
      Say 'ok' "merged: $((Run-Git $RepoDir @('log', '-1', '--format=%h %s')).Text)"
      $added = @((Run-Git $RepoDir @('diff', '--name-only', '--diff-filter=A', 'HEAD^1', 'HEAD')).Lines | Where-Object { $_ })
      Report-Binaries $added 'came in with the merge'
    }
  }

  # Unity projects in the old clone: say where they are, and copy the Library cache only when asked (Unity rebuilds it).
  $oldUnity = PathOf $Old 'unity'
  $projects = @(Get-ChildItem -LiteralPath $oldUnity -Directory -Force -ErrorAction SilentlyContinue | Where-Object { Is-UnityProject $_.FullName })
  foreach ($p in $projects) {
    Say 'info' "Unity project in the old clone: unity\$($p.Name) (Unity $(Unity-Version $p.FullName))"
    if ($p.Name -ne 'MiraStage') { Say 'todo' "it is not called MiraStage: the VS Code workspace and the docs expect unity\MiraStage (rename it with git mv)" }
    $lib = PathOf $p.FullName 'Library'
    $target = PathOf $RepoDir 'unity' $p.Name
    if ($CopyLibrary -and (Test-Path -LiteralPath $lib)) {
      if (Test-Path -LiteralPath (PathOf $target 'Library')) { Say 'info' "unity\$($p.Name)\Library already exists here: not copied" }
      else { Act "copy the Library cache of unity\$($p.Name) (saves the first import)" { Copy-Tree $lib (PathOf $target 'Library') } }
    }
  }
}

function Import-UnityProject([string]$Src) {
  Say 'info' "Unity project: $Src (Unity $(Unity-Version $Src))"
  $v = Unity-Version $Src
  if ($v -notmatch '^6000\.') { Say 'warn' "it was made with Unity $v; the package targets Unity 6 (6000.x)" }
  if (Test-Path -LiteralPath $ProjectDir) {
    Stop-Migration 'unity\MiraStage already exists in this clone; nothing copied (move it away first, or bring the project in by hand)'
  }
  if (Test-Path -LiteralPath (PathOf $Src '.git')) { Say 'info' 'that project has its own git history; it stays there. The copy here is tracked by this repository' }
  Require-CleanRepo
  Ensure-WorkBranch

  # Root folders Unity or the IDEs rebuild, the project's own git folder, and (handled below) any embedded copy of the package.
  $skipRoot = @('Library', 'Temp', 'Logs', 'obj', 'Build', 'Builds', 'UserSettings', 'MemoryCaptures', 'Recordings', '.vs', '.idea', '.vscode', '.utmp', '.git')
  if ($CopyLibrary) { $skipRoot = @($skipRoot | Where-Object { $_ -ne 'Library' }) }
  $embedded = PathOf $Src 'Packages' 'com.mira.stage'
  Act "copy the project to unity\MiraStage (without $($skipRoot -join ', '), the generated .csproj/.sln files and any embedded copy of com.mira.stage)" {
    New-Item -ItemType Directory -Force -Path $ProjectDir | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath $Src -Force) {
      if ($item.PSIsContainer) {
        if ($skipRoot -contains $item.Name) { continue }
        Copy-Tree $item.FullName (PathOf $ProjectDir $item.Name) @($embedded)
      } elseif ($item.Name -notmatch '\.(csproj|sln|slnx|user)$') {
        Copy-Item -LiteralPath $item.FullName -Destination (PathOf $ProjectDir $item.Name)
      }
    }
  }

  # The package: an embedded copy, or a file: reference to a copy elsewhere (say, an older clone).
  if (Test-Path -LiteralPath $embedded) { Merge-PackageCopy $embedded "the project's embedded Packages\com.mira.stage" }
  $manifest = PathOf $Src 'Packages' 'manifest.json'
  if (Test-Path -LiteralPath $manifest) {
    $text = [System.IO.File]::ReadAllText($manifest)
    if ($text -match '"com\.mira\.stage"\s*:\s*"file:([^"]+)"') {
      $target = $Matches[1]
      $resolved = if ([System.IO.Path]::IsPathRooted($target)) { $target } else { PathOf (PathOf $Src 'Packages') $target }
      if ((Test-Path -LiteralPath $resolved) -and -not (Same-Path $resolved $PackageDir) -and -not (Same-Path $resolved $embedded)) {
        Merge-PackageCopy $resolved "the package the project referenced ($resolved)"
      }
    }
    $newManifest = PathOf $ProjectDir 'Packages' 'manifest.json'
    if ($DryRun) { $newManifest = $manifest }
    Set-ManifestDependency $newManifest
  } else {
    Say 'warn' 'the project has no Packages\manifest.json'
  }
  $all = @(List-Files $Src | Where-Object { $_ -notmatch '^(Library|Temp|Logs|obj|Build|Builds|UserSettings)/' })
  Report-Binaries $all 'are in the project'
  if (-not $DryRun) { Say 'todo' "review and commit the copied project: git -C `"$RepoDir`" status, then git add unity and git commit (on $WorkBranch)" }
}

foreach ($s in $sources) {
  if ($s.Kind -eq 'clone') { Import-OldClone $s.Path } else { Import-UnityProject $s.Path }
}

# ------------------------------------------------------------------------------------------------------- 4. dependencies

Section '4. Dependencies'
if ($SkipInstall) {
  Say 'info' 'skipped (-SkipInstall); start.cmd installs them on its first run'
} elseif (-not $nodeOk) {
  Say 'todo' 'install Node.js 22.14 or newer, then run start.cmd (it installs the rest)'
} else {
  Act 'install the JavaScript dependencies (pnpm install --frozen-lockfile) and check the database library' {
    if (-not (Find-Tool 'pnpm')) {
      Invoke-Native 'corepack' @('enable') | Out-Null
      if (-not (Find-Tool 'pnpm')) { Invoke-Native 'npm' @('install', '-g', 'pnpm@10.28.0') | Out-Null }
    }
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    Push-Location $RepoDir
    try {
      & pnpm install --frozen-lockfile
      $installCode = $LASTEXITCODE
      if ($installCode -eq 0) { & pnpm --filter '@ai-assistant/daemon' check-native; $nativeCode = $LASTEXITCODE } else { $nativeCode = -1 }
    } finally {
      Pop-Location
      $ErrorActionPreference = $prev
    }
    if ($installCode -ne 0) { Say 'fail' "pnpm install failed (exit $installCode); the error text above is what is needed" ; $script:ExitCode = 1 }
    elseif ($nativeCode -ne 0) { Say 'fail' 'the database library check failed; see the message above'; $script:ExitCode = 1 }
    else { Say 'ok' 'dependencies installed and the database library opens' }
  }
}

# ---------------------------------------------------------------------------------------------------------- 5. VS Code

Section '5. VS Code'
$workspace = PathOf $RepoDir 'Mira.code-workspace'
if ($NoOpen) {
  Say 'info' "open it yourself: $workspace"
} elseif (-not $codeCmd) {
  Say 'todo' "install VS Code (https://code.visualstudio.com/), then File, Open Workspace from File: $workspace"
} else {
  Act "open $workspace in VS Code" { Invoke-Native $codeCmd @($workspace) | Out-Null }
}

# ------------------------------------------------------------------------------------------------------------- summary

Section 'Next steps'
$hasProject = Test-Path -LiteralPath (PathOf $ProjectDir 'ProjectSettings' 'ProjectVersion.txt')
foreach ($t in $script:Todo) { Write-Host " - $t" }
Write-Host " - VS Code: accept the recommended extensions (Unity, C# Dev Kit); the Run and Debug list has 'Attach to Unity'."
if ($hasProject -or ($DryRun -and $sources.Count -gt 0)) {
  Write-Host " - Unity Hub: Add, Add project from disk: $ProjectDir (the first open rebuilds Library; it takes a while)."
  Write-Host ' - In Unity: Edit, Preferences, External Tools: External Script Editor = Visual Studio Code, then Regenerate project files.'
} else {
  Write-Host ' - No Unity project here yet: build it with spikes\unity\KICKOFF-PROMPT.md (a Claude Code session in this folder).'
}
Write-Host ' - Backend: start.cmd (native) or start-docker.cmd (Docker), then Settings, Stage in the browser shows the stage.'
Write-Host ' - Nothing was pushed. Your work is on local branches; push only when you want it on GitHub.'
Save-Report
exit $script:ExitCode
