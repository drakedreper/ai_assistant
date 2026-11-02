#Requires -Version 5.1
<#
.SYNOPSIS
  End-to-end test of scripts/migrate.ps1 on throwaway copies of this repository.

.DESCRIPTION
  Builds, in a temporary folder: a "new" clone (with the working-tree migrate.ps1 committed into it), an "old" clone with
  Unity work on the branch unity-stage-pc (a Unity project, a Unity layer file, a .meta file and an ignored Library), and a
  standalone Unity project with an embedded, edited copy of com.mira.stage. Runs migrate.ps1 against them in the same
  PowerShell that runs this file (Windows PowerShell 5.1 or PowerShell 7) and checks what it did. Changes nothing outside
  the temporary folder. Prints PASS/FAIL lines and exits non-zero when a check fails.

  powershell -ExecutionPolicy Bypass -File scripts\test-migrate.ps1      (Windows)
  pwsh -File scripts/test-migrate.ps1                                    (anywhere)
#>
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$repo = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$shell = (Get-Process -Id $PID).Path
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('mira-migrate-test-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$script:fails = 0
$script:passes = 0

function P { param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Parts) $p = $Parts[0]; for ($i = 1; $i -lt $Parts.Count; $i++) { $p = [System.IO.Path]::Combine($p, $Parts[$i]) }; $p }

function G([string]$Dir, [string[]]$GitArgs) {
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $out = @(& git -C $Dir @GitArgs 2>&1 | ForEach-Object { "$_" }); $code = $LASTEXITCODE } finally { $ErrorActionPreference = $prev }
  if ($code -ne 0) { throw "git $($GitArgs -join ' ') in $Dir failed: $($out -join ' ')" }
  ($out -join "`n").Trim()
}

function Check([string]$Name, [bool]$Ok, [string]$Detail = '') {
  if ($Ok) { $script:passes++; Write-Host "PASS  $Name" -ForegroundColor Green }
  else { $script:fails++; Write-Host "FAIL  $Name $Detail" -ForegroundColor Red }
}

function Write-Text([string]$File, [string]$Text) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $File) | Out-Null
  [System.IO.File]::WriteAllText($File, $Text, (New-Object System.Text.UTF8Encoding $false))
}

function Clone([string]$To) {
  # core.autocrlf is left as this machine has it (true on a Windows PC with Git for Windows), as on the owner's PC.
  G $repo @('clone', '--quiet', '--no-hardlinks', $repo, $To) | Out-Null
  G $To @('config', 'user.email', 'test@example.invalid') | Out-Null
  G $To @('config', 'user.name', 'Migration Test') | Out-Null
}

# A new clone in <common>/ai_assistant with the CURRENT working-tree script and workspace committed (the run needs a clean tree).
function New-Target([string]$Common) {
  $t = P $Common 'ai_assistant'
  Clone $t
  foreach ($f in 'scripts/migrate.ps1', 'Mira.code-workspace') { Copy-Item -LiteralPath (P $repo $f) -Destination (P $t $f) -Force }
  G $t @('add', '-A') | Out-Null
  $pending = G $t @('status', '--porcelain')
  if ($pending) { G $t @('commit', '--quiet', '-m', 'test: the working-tree migration script') | Out-Null }
  $t
}

function Run-Migrate([string]$Target, [string[]]$MigrateArgs) {
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try {
    $out = @(& $shell -NoProfile -ExecutionPolicy Bypass -File (P $Target 'scripts' 'migrate.ps1') -NonInteractive -NoOpen -SkipInstall @MigrateArgs 2>&1 | ForEach-Object { "$_" })
    $code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $prev }
  New-Object psobject -Property @{ Code = $code; Text = ($out -join "`n") }
}

function Unity-Project([string]$Dir, [string]$PackageRef) {
  Write-Text (P $Dir 'ProjectSettings' 'ProjectVersion.txt') "m_EditorVersion: 6000.0.58f2`nm_EditorVersionWithRevision: 6000.0.58f2 (0000)`n"
  Write-Text (P $Dir 'Assets' 'Scenes' 'CerebralVoid.unity') "%YAML 1.1`n--- !u!29 &1`nOcclusionCullingSettings: {}`n"
  Write-Text (P $Dir 'Assets' 'Scenes' 'CerebralVoid.unity.meta') "fileFormatVersion: 2`nguid: 0123456789abcdef0123456789abcdef`n"
  Write-Text (P $Dir 'Packages' 'manifest.json') ("{`n  `"dependencies`": {`n    `"com.mira.stage`": `"$PackageRef`",`n    `"com.unity.render-pipelines.universal`": `"17.0.4`"`n  }`n}`n")
  Write-Text (P $Dir 'Library' 'ArtifactDB') 'cache that Unity rebuilds'
  Write-Text (P $Dir 'Temp' 'junk.txt') 'temp'
}

try {
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  Write-Host "test folder: $tmp ($($PSVersionTable.PSEdition) $($PSVersionTable.PSVersion))"

  # ------------------------------------------------------------------ the old clone, with Unity work on unity-stage-pc
  $old = P $tmp 'dev' 'ai_assistant'
  Clone $old
  G $old @('switch', '--quiet', '-c', 'unity-stage-pc') | Out-Null
  Unity-Project (P $old 'unity' 'MiraStage') 'file:../../Packages/com.mira.stage'
  Write-Text (P $old 'unity' 'Packages' 'com.mira.stage' 'Runtime' 'Unity' 'StageBehaviour.cs') "namespace Mira.Stage.Unity { public sealed class StageBehaviour { } }`n"
  Write-Text (P $old 'unity' 'Packages' 'com.mira.stage' 'Runtime' 'Unity' 'StageBehaviour.cs.meta') "fileFormatVersion: 2`nguid: fedcba9876543210fedcba9876543210`n"
  G $old @('add', '-A') | Out-Null
  G $old @('commit', '--quiet', '-m', 'Unity stage: project, Unity layer') | Out-Null
  $oldHead = G $old @('rev-parse', 'HEAD')
  Check 'fixture: the old clone ignores Library (unity/.gitignore)' (-not ((G $old @('ls-files')) -match 'Library/'))

  # ------------------------------------------------------------------ A. dry run changes nothing
  $common = P $tmp 'A' 'Mira'
  $t = New-Target $common
  $before = G $t @('rev-parse', 'HEAD')
  $startBranch = G $t @('rev-parse', '--abbrev-ref', 'HEAD')
  $r = Run-Migrate $t @('-OldClone', $old, '-DryRun')
  Check 'A dry run exits 0' ($r.Code -eq 0) $r.Text
  Check 'A dry run names the branch with new commits' ($r.Text -match 'unity-stage-pc has 1 commit') $r.Text
  Check 'A dry run says it would merge' ($r.Text -match '\[would\]\s+merge pc/unity-stage-pc')
  Check 'A dry run: HEAD and branch unchanged' (((G $t @('rev-parse', 'HEAD')) -eq $before) -and ((G $t @('rev-parse', '--abbrev-ref', 'HEAD')) -ne 'unity-stage'))
  Check 'A dry run: nothing fetched' (-not (G $t @('for-each-ref', 'refs/remotes/pc')))
  Check 'A dry run: no content folder, no report' ((-not (Test-Path (P $common 'content'))) -and (-not (Test-Path (P $common 'migration-report.txt'))))

  # ------------------------------------------------------------------ B. the old clone route
  $r = Run-Migrate $t @('-OldClone', ($old + [System.IO.Path]::DirectorySeparatorChar))
  Check 'B old clone: exits 0 (folder given with a trailing separator)' ($r.Code -eq 0) $r.Text
  Check 'B old clone: on the new branch unity-stage' ((G $t @('rev-parse', '--abbrev-ref', 'HEAD')) -eq 'unity-stage')
  Check 'B old clone: merge commit with two parents' (((G $t @('log', '-1', '--format=%P')) -split ' ').Count -eq 2)
  Check 'B old clone: the Unity project came over' (Test-Path (P $t 'unity' 'MiraStage' 'ProjectSettings' 'ProjectVersion.txt'))
  Check 'B old clone: the Unity layer and its .meta came over' ((Test-Path (P $t 'unity' 'Packages' 'com.mira.stage' 'Runtime' 'Unity' 'StageBehaviour.cs')) -and (Test-Path (P $t 'unity' 'Packages' 'com.mira.stage' 'Runtime' 'Unity' 'StageBehaviour.cs.meta')))
  Check 'B old clone: Library was not copied (not asked)' (-not (Test-Path (P $t 'unity' 'MiraStage' 'Library')))
  Check 'B old clone: content folder and README made' (Test-Path (P $common 'content' 'README.txt'))
  Check 'B old clone: report saved beside the repository' (Test-Path (P $common 'migration-report.txt'))
  Check 'B old clone: the old clone is untouched' (((G $old @('rev-parse', 'HEAD')) -eq $oldHead) -and -not (G $old @('status', '--porcelain')))
  Check 'B old clone: the branch the clone started on is unchanged' ((G $t @('rev-parse', $startBranch)) -eq $before)
  $r2 = Run-Migrate $t @('-OldClone', $old)
  Check 'B rerun: says nothing to merge and exits 0' (($r2.Code -eq 0) -and ($r2.Text -match 'nothing to merge')) $r2.Text

  # ------------------------------------------------------------------ C. uncommitted work in the old clone
  $old2 = P $tmp 'dev2' 'ai_assistant'
  Clone $old2
  Unity-Project (P $old2 'unity' 'MiraStage') 'file:../../Packages/com.mira.stage'
  $common = P $tmp 'C' 'Mira'
  $t = New-Target $common
  $r = Run-Migrate $t @('-OldClone', $old2)
  Check 'C uncommitted: stops with exit 1 and says how to commit' (($r.Code -eq 1) -and ($r.Text -match 'CommitUncommitted')) $r.Text
  Check 'C uncommitted: the old clone is still uncommitted' ([bool](G $old2 @('status', '--porcelain')))
  $r = Run-Migrate $t @('-OldClone', $old2, '-CommitUncommitted')
  Check 'C -CommitUncommitted: exits 0 and merges the project' (($r.Code -eq 0) -and (Test-Path (P $t 'unity' 'MiraStage' 'Assets' 'Scenes' 'CerebralVoid.unity'))) $r.Text
  Check 'C -CommitUncommitted: Library stayed out of the commit' (-not ((G $old2 @('show', '--name-only', '--format=', 'HEAD')) -match 'Library'))

  # ------------------------------------------------------------------ D. a standalone Unity project with an embedded package
  $proj = P $tmp 'Projects' 'MyMira'
  Unity-Project $proj 'file:com.mira.stage'
  Copy-Item -Recurse -LiteralPath (P $repo 'unity' 'Packages' 'com.mira.stage') -Destination (P $proj 'Packages' 'com.mira.stage')
  Get-ChildItem -LiteralPath (P $proj 'Packages' 'com.mira.stage') -Recurse -Directory -Force | Where-Object { $_.Name -in 'bin', 'obj' } | Remove-Item -Recurse -Force
  Write-Text (P $proj 'Packages' 'com.mira.stage' 'Runtime' 'Unity' 'Extra.cs') "namespace Mira.Stage.Unity { public static class Extra { } }`n"
  Write-Text (P $proj 'Packages' 'com.mira.stage' 'Runtime' 'StageClient.cs.meta') "fileFormatVersion: 2`nguid: 11111111111111111111111111111111`n"
  $client = P $proj 'Packages' 'com.mira.stage' 'Runtime' 'StageClient.cs'
  Write-Text $client ([System.IO.File]::ReadAllText($client) + "`n// edited in the Unity project`n")
  Write-Text (P $proj 'MyMira.sln') 'generated'
  Write-Text (P $proj 'Assets' 'Textures' 'void.png') 'not really a png'
  Write-Text (P $proj 'Assets' 'Scripts' 'Build' 'Keep.cs') "// a SOURCE folder called Build deeper in must be copied`n"
  $common = P $tmp 'D' 'Mira'
  $t = New-Target $common
  $r = Run-Migrate $t @('-UnityProject', $proj)
  $dest = P $t 'unity' 'MiraStage'
  Check 'D project: exits 0' ($r.Code -eq 0) $r.Text
  Check 'D project: copied into unity/MiraStage' ((Test-Path (P $dest 'Assets' 'Scenes' 'CerebralVoid.unity')) -and (Test-Path (P $dest 'ProjectSettings' 'ProjectVersion.txt')))
  Check 'D project: Library, Temp and the .sln left out' ((-not (Test-Path (P $dest 'Library'))) -and (-not (Test-Path (P $dest 'Temp'))) -and (-not (Test-Path (P $dest 'MyMira.sln'))))
  Check 'D project: a deeper source folder named Build is kept' (Test-Path (P $dest 'Assets' 'Scripts' 'Build' 'Keep.cs'))
  Check 'D project: the embedded package copy is not duplicated' (-not (Test-Path (P $dest 'Packages' 'com.mira.stage')))
  $manifest = [System.IO.File]::ReadAllText((P $dest 'Packages' 'manifest.json'))
  $json = $manifest | ConvertFrom-Json
  Check 'D project: manifest points at the repository package and is valid JSON' ($json.dependencies.'com.mira.stage' -eq 'file:../../Packages/com.mira.stage') $manifest
  Check 'D project: other dependencies kept' ($json.dependencies.'com.unity.render-pipelines.universal' -eq '17.0.4')
  Check 'D project: the Unity layer file and the .meta were added to the package' ((Test-Path (P $t 'unity' 'Packages' 'com.mira.stage' 'Runtime' 'Unity' 'Extra.cs')) -and (Test-Path (P $t 'unity' 'Packages' 'com.mira.stage' 'Runtime' 'StageClient.cs.meta')))
  Check 'D project: the edited core file was NOT overwritten' (-not ((G $t @('status', '--porcelain', '--', 'unity/Packages/com.mira.stage/Runtime/StageClient.cs'))))
  Check 'D project: the edited core file is reported and backed up' (($r.Text -match 'Runtime/StageClient\.cs') -and (@(Get-ChildItem -Recurse -LiteralPath (P $common 'migration-backup') -Filter 'StageClient.cs').Count -eq 1)) $r.Text
  Check 'D project: the texture is reported as a binary to decide on' ($r.Text -match 'void\.png')
  Check 'D project: the original project is untouched' ((Test-Path (P $proj 'Library' 'ArtifactDB')) -and (Test-Path (P $proj 'Packages' 'com.mira.stage' 'Runtime' 'Unity' 'Extra.cs')))
  Check 'D project: on the branch unity-stage, nothing committed for you' (((G $t @('rev-parse', '--abbrev-ref', 'HEAD')) -eq 'unity-stage') -and [bool](G $t @('status', '--porcelain')))

  # ------------------------------------------------------------------ E. a merge conflict is undone and explained
  $old3 = P $tmp 'dev3' 'ai_assistant'
  Clone $old3
  G $old3 @('switch', '--quiet', '-c', 'unity-stage-pc') | Out-Null
  Write-Text (P $old3 'unity' 'README.md') "# unity/ (edited on the PC)`n"
  G $old3 @('commit', '--quiet', '-am', 'PC edit of unity/README.md') | Out-Null
  $common = P $tmp 'E' 'Mira'
  $t = New-Target $common
  Write-Text (P $t 'unity' 'README.md') "# unity/ (edited in the cloud)`n"
  G $t @('commit', '--quiet', '-am', 'cloud edit of unity/README.md') | Out-Null
  $r = Run-Migrate $t @('-OldClone', $old3)
  Check 'E conflict: exit 2 and the conflicting file is named' (($r.Code -eq 2) -and ($r.Text -match 'unity/README\.md')) $r.Text
  Check 'E conflict: the merge was undone (clean tree)' (-not (G $t @('status', '--porcelain')))
  Check 'E conflict: the old branch is kept as pc/unity-stage-pc for a manual merge' ([bool](G $t @('for-each-ref', 'refs/remotes/pc/unity-stage-pc')))
} finally {
  if (Test-Path $tmp) { Remove-Item -Recurse -Force -LiteralPath $tmp -ErrorAction SilentlyContinue }
}

Write-Host ''
Write-Host "migrate.ps1: $($script:passes) passed, $($script:fails) failed"
if ($script:fails -gt 0) { exit 1 }
exit 0
