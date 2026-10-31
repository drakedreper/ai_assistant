<#
.SYNOPSIS
  Spike (b): capture `claude agents --json --all` output to files, and list which fields each entry has.

.DESCRIPTION
  The research claimed every roster entry carries `id` and a five-value `state`. The critic refuted that:
  `id` and `state` should exist for background sessions only, `pid` and `status` (busy/waiting/idle) only
  while a process is alive. This script records the real output so the daemon's roster parser and the
  state machine are built on facts. Run it while you have, at the same time:
    - one interactive `claude` session that is idle,
    - one interactive session that is busy (a long prompt) or waiting on a permission prompt,
    - one background session if you use Agent View (`claude agents`), and one finished background session.

  Nothing here changes any Claude setting. Output goes to .\results\ (git-ignored). It may contain
  working-directory paths and session names, so do not share it without looking.

.PARAMETER Samples
  How many captures to take. Default 1.

.PARAMETER IntervalSeconds
  Seconds between captures. Default 5. Use Samples 12 with a 5 s interval to watch states change.

.PARAMETER OutDir
  Output folder. Default .\results next to this script.

.EXAMPLE
  .\capture-agents.ps1
  .\capture-agents.ps1 -Samples 12 -IntervalSeconds 5

.NOTES
  One-liner equivalent for a single snapshot:
    claude agents --json --all | Out-File -Encoding utf8 .\results\agents-snapshot.json
#>
param(
  [int]$Samples = 1,
  [int]$IntervalSeconds = 5,
  [string]$OutDir = (Join-Path $PSScriptRoot 'results')
)

# 'Continue' on purpose: with 'Stop', Windows PowerShell 5.1 turns any stderr line from a native command
# captured with 2>&1 into a terminating error.
$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  throw 'The `claude` command was not found on PATH. Install Claude Code and open a new shell.'
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$jsonl = Join-Path $OutDir ("agents-{0}.jsonl" -f $stamp)

for ($i = 1; $i -le $Samples; $i++) {
  $capturedAt = Get-Date -Format 'o'
  $raw = (& claude agents --json --all 2>&1 | Out-String)
  $exit = $LASTEXITCODE

  $single = Join-Path $OutDir ("agents-{0}-{1:D3}.json" -f $stamp, $i)
  Set-Content -Path $single -Value $raw -Encoding utf8

  # One JSON-lines record per capture: timestamp, exit code and the raw text.
  $entry = [pscustomobject]@{ capturedAt = $capturedAt; sample = $i; exitCode = $exit; raw = $raw.Trim() }
  ($entry | ConvertTo-Json -Compress -Depth 4) | Add-Content -Path $jsonl -Encoding utf8

  Write-Host ("[{0}] sample {1}/{2} exit={3} -> {4}" -f $capturedAt, $i, $Samples, $exit, $single)

  # Show which properties each entry actually has, grouped by kind.
  try {
    $parsed = $raw | ConvertFrom-Json
    foreach ($s in @($parsed)) {
      $props = ($s.PSObject.Properties.Name | Sort-Object) -join ','
      Write-Host ("    kind={0,-12} status={1,-8} state={2,-8} props={3}" -f $s.kind, $s.status, $s.state, $props)
    }
    if (@($parsed).Count -eq 0) { Write-Host '    (no sessions listed)' }
  } catch {
    Write-Host '    (output was not JSON; see the saved file)'
  }

  if ($i -lt $Samples) { Start-Sleep -Seconds $IntervalSeconds }
}

Write-Host ''
Write-Host "Done. Combined log: $jsonl"
Write-Host 'Record in your results: which fields appear for interactive versus background sessions,'
Write-Host 'and whether `status` changes between busy, waiting and idle as you use the sessions.'
