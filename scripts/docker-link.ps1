# Waits for the daemon in the compose project to print its one-time sign-in link, shows it, and opens it in the default
# browser of THIS PC. Used by start-docker.cmd. The link is single use and valid for 15 minutes; it is printed on purpose.
$ErrorActionPreference = 'Stop'
$pattern = 'Sign in\s+(http://127\.0\.0\.1:\d+/\?code=[\w-]+(?:#tp=[\w-]+)?)'
$deadline = (Get-Date).AddSeconds(120)
$link = $null
while (-not $link -and (Get-Date) -lt $deadline) {
  $text = (docker compose logs --no-color --since 3m daemon 2>&1 | Out-String)
  $found = [regex]::Matches($text, $pattern)
  if ($found.Count -gt 0) { $link = $found[$found.Count - 1].Groups[1].Value }
  if (-not $link) { Start-Sleep -Seconds 2 }
}
if (-not $link) {
  Write-Host 'The backend did not print a sign-in link within two minutes. The last log lines:'
  docker compose logs --no-color --tail 40 daemon
  exit 1
}
Write-Host ''
Write-Host "Sign in (one time, 15 minutes): $link"
Start-Process $link
