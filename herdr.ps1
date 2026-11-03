# herdr.ps1 - Invoke-Herdr, dot-sourced by rig.ps1, lanes.ps1 and close.ps1 (one copy instead of one per script).
# One herdr call: whether it exited 0, its .result (herdr prints JSON) and a line that says what herdr answered: the command, its exit code,
# its stderr (herdr's error JSON, or a notice) and its stdout, cut at 300 characters because lanes.ps1's lines land in the orchestrator's
# context. Its stderr is kept out of the JSON. The exit code starts at 1, so a herdr that does not run at all counts as a failure.
# shortcut: no timeout, so a herdr that never answers holds the calling script until Ctrl+C (Jas starts rig.ps1 by hand; the orchestrator's
# PowerShell tool times out lanes.ps1 and close.ps1). Upgrade path: Start-Job + Wait-Job -Timeout, about 0.8 s more per call on Windows
# PowerShell 5.1, and a herdr child that can outlive the job (seats review, minor 1).
function Invoke-Herdr {
  $global:LASTEXITCODE = 1
  $all = @(& herdr @args 2>&1)
  $code = $LASTEXITCODE
  $out = @($all | Where-Object { $_ -isnot [Management.Automation.ErrorRecord] }) -join "`n"
  $err = @($all | Where-Object { $_ -is [Management.Automation.ErrorRecord] }) -join ' '
  $result = $null
  if ($code -eq 0) { try { $result = ($out | ConvertFrom-Json -ErrorAction Stop).result } catch { $result = $null } }
  $shown = if ($out.Length -gt 300) { $out.Substring(0, 300) + '...' } else { $out }
  [pscustomobject]@{ Ok = $code -eq 0; Result = $result; Says = "herdr $($args -join ' ') (exit $code) $err $shown".Trim() }
}
