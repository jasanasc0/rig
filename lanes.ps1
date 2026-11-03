# lanes.ps1 - start a project's missing lanes in herdr (the rig README, Daily use). The orchestrator runs it from the PowerShell
# tool at startup and whenever a lane is missing:
#   & '<rig>\lanes.ps1' <project>
# Tab 1: coder right of the orchestrator's pane, angela below coder, oscar right of angela, each in the project's root; tab 2: pam in the
# one pane of this space's seats tab (rig.ps1 opens it; this script never opens a tab). A lane already running in this space is left alone
# and its pane anchors the next split. Everything that can stop it is checked before anything starts: the project, the guard's verdict on
# its profile, the caller context herdr sets in every pane it manages (HERDR_ENV, HERDR_PANE_ID, HERDR_TAB_ID, HERDR_WORKSPACE_ID), and
# herdr's answers about the lanes, the tabs and the panes. A lane it can't start is said and the others still start. One line per lane;
# exit 1 when a lane is not running at the end. The guard lets only the orchestrator run it, with exactly its own project's name, and
# refuses the orchestrator's own `herdr agent start` and `pane split`: the lanes' flags live only here.
param([Parameter(Mandatory = $true)][string]$Project)
$rig = $PSScriptRoot
$profileFile = Join-Path $rig "$Project\profile.json"
if ($Project -cnotmatch '^[a-z0-9][a-z0-9-]*$' -or -not (Test-Path -LiteralPath $profileFile -PathType Leaf)) {
  throw "No project '$Project': there is no $profileFile. A project is a rig folder with a profile.json. Nothing was started."
}
# The guard refuses every call of a project whose profile is wrong (the check rig.ps1 makes); its reason prints here.
'{"tool_name":"Read","tool_input":{"file_path":"README.md"}}' | node "$rig\guard.cjs" --project $Project --seat orchestrator
if ($LASTEXITCODE -ne 0) { throw "The guard refuses $profileFile (its reason is above); nothing was started." }
if ($env:HERDR_ENV -ne '1') { throw 'Not inside a herdr pane ($env:HERDR_ENV is not 1); nothing was started.' }
$own = $env:HERDR_PANE_ID
$ownTab = $env:HERDR_TAB_ID
$space = $env:HERDR_WORKSPACE_ID
if (-not $own -or -not $ownTab -or -not $space) { throw "herdr did not name this pane (HERDR_PANE_ID '$own', HERDR_TAB_ID '$ownTab', HERDR_WORKSPACE_ID '$space'); nothing was started." }
# profile.json reader: guard.cjs (loadProfile) is the one validator (asked above); this script reads the lane names, the root and projectSettings.
$p = Get-Content -LiteralPath $profileFile -Raw | ConvertFrom-Json
# The root without a trailing backslash: Windows PowerShell 5.1 would pass 'C:\x\my root\' to herdr as `C:\x\my root" --no-focus` (one word).
$root = ($p.root -replace '/', '\').TrimEnd('\')
$rules = ($rig -replace '\\', '/') + "/$Project/rules"
# From here on everything runs in a try whose finally removes the helpers this script defines, so a dot-sourced or imported run leaves
# no way to herdr in the caller's shell. A throw still ends the script with its message, and exit with its code.
try {
  # Invoke-Herdr: one herdr call, its result and what herdr answered (herdr.ps1, shared with rig.ps1 and close.ps1).
  . (Join-Path $rig 'herdr.ps1')

  # The flags each worker lane starts with (the rig README, The seats), the same in every project.
  $flags = @{
    coder = '--model', 'opus', '--effort', 'max', '--permission-mode', 'auto', '--disallowedTools', 'Agent'
    angela = '--model', 'fable', '--effort', 'max', '--permission-mode', 'auto', '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', 'Agent'
    oscar = '--model', 'sonnet', '--effort', 'medium', '--permission-mode', 'auto', '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', 'Agent'
    pam = '--model', 'sonnet', '--effort', 'medium', '--permission-mode', 'auto', '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', 'Agent' # oscar's (pam build)
  }
  # A lane's claude arguments: its herdr name as the session name (the prompt bar and the status line show it), --setting-sources user,local
  # where projectSettings is false (the repo's own settings and hooks stay out), its flags, then its project's settings
  # file (and so its guard), seat file and MCP config.
  function ClaudeArgs($seat) {
    $a = @('-n', $p.lanes.$seat)
    if ($p.projectSettings -ne $true) { $a += '--setting-sources', 'user,local' }
    $a + $flags[$seat] + @('--settings', "$rules/$seat.settings.json", '--append-system-prompt-file', "$rules/seats/$seat.md", '--strict-mcp-config', '--mcp-config', "$rules/mcp.json")
  }
  # One lane into an empty pane: its line, and whether it now runs. agent_not_ready means it started and a dialog waits in its pane. A pane
  # this script just split may not have its shell at the prompt yet: herdr answers agent_pane_unavailable until it does, so that answer is
  # asked again for up to 15 s (the old role started 2.4-6 s after its split, this script within a second). A
  # start that fails for good closes a pane this script split for it (-Split), so a rerun leaves no empty pane behind; pam's pane is the seats
  # tab's own and stays. The '--' is quoted: PowerShell drops a bare -- in a function call.
  $problems = 0
  function Start-Lane($seat, $pane, [switch]$Split) {
    $lane = $p.lanes.$seat
    $clock = [Diagnostics.Stopwatch]::StartNew()
    while ($true) {
      $r = Invoke-Herdr agent start $lane --kind claude --pane $pane '--' @(ClaudeArgs $seat)
      if ($r.Ok -or $r.Says -notmatch 'agent_pane_unavailable' -or $clock.Elapsed.TotalSeconds -ge 15) { break }
      Start-Sleep -Milliseconds 500
    }
    if ($r.Ok) { return [pscustomobject]@{ Ok = $true; Line = "${lane}: started in $pane" } }
    if ($r.Says -match 'agent_not_ready') { return [pscustomobject]@{ Ok = $true; Line = "${lane}: started in $pane; herdr says agent_not_ready: tell Jas to answer the dialog in that pane" } }
    $line = "${lane}: not started: herdr agent start failed in $pane ($($r.Says))"
    if ($Split) {
      $c = Invoke-Herdr pane close $pane
      $line += $(if ($c.Ok) { '; the pane split for it is closed again' } else { "; the pane split for it stays empty ($($c.Says))" })
    }
    [pscustomobject]@{ Ok = $false; Line = "$line; tell Jas" }
  }

  # Where each lane runs now, by its herdr agent name. A lane herdr answers agent_not_found for is not running; any other failed answer
  # stops the run before anything starts.
  $where = @{}
  foreach ($seat in 'coder', 'angela', 'oscar', 'pam') {
    $r = Invoke-Herdr agent get $p.lanes.$seat
    if (-not $r.Ok -and $r.Says -match 'agent_not_found') { continue }
    if (-not $r.Ok -or -not $r.Result.agent.pane_id -or -not $r.Result.agent.workspace_id) { throw "herdr could not say where $($p.lanes.$seat) runs: $($r.Says). Nothing was started." }
    $where[$seat] = $r.Result.agent
  }
  # This space's seats tab: tab list lists every space, so only a tab of this space labelled seats counts. Started from a pane inside it (a
  # seats tab left over from a close), the tab-1 lanes would split into the seats tab, so nothing starts.
  $r = Invoke-Herdr tab list
  if ($null -eq $r.Result.tabs) { throw "herdr tab list gave no tabs: $($r.Says). Nothing was started." }
  $seatsTabs = @($r.Result.tabs | Where-Object { $_.workspace_id -ceq $space -and $_.label -ceq 'seats' })
  if (@($seatsTabs | Where-Object { $_.tab_id -ceq $ownTab }).Count) {
    throw "This pane ($own) is in the seats tab ($ownTab), where the tab-1 lanes would split. Start the rig from a pane in another tab of this space; nothing was started."
  }
  # pam's pane, when pam has to start: the one pane of the seats tab, with no agent in it. Anything else is said on pam's line.
  $pamPane = $null
  $pamProblem = $null
  if (-not $where.pam) {
    $r = Invoke-Herdr pane list
    if ($null -eq $r.Result.panes) { throw "herdr pane list gave no panes: $($r.Says). Nothing was started." }
    if ($seatsTabs.Count -eq 0) {
      $pamProblem = "this space ($space) has no seats tab. Ask Jas to run, in a pane that is not a lane: herdr tab create --workspace $space --cwd '$root' --label seats --no-focus; then run lanes.ps1 again"
    } elseif ($seatsTabs.Count -gt 1) {
      $pamProblem = "this space ($space) has $($seatsTabs.Count) seats tabs ($(@($seatsTabs | ForEach-Object { $_.tab_id }) -join ', ')); tell Jas"
    } else {
      $tab = $seatsTabs[0].tab_id
      $in = @($r.Result.panes | Where-Object { $_.tab_id -ceq $tab })
      if ($in.Count -ne 1) { $pamProblem = "the seats tab ($tab) holds $($in.Count) panes; tell Jas" }
      elseif ($in[0].agent) { $pamProblem = "the seats tab ($tab) holds an agent (in $($in[0].pane_id)); tell Jas" }
      else { $pamPane = $in[0].pane_id }
    }
  }

  # Tab 1, in order; each pane whose lane runs anchors the next split, so the layout is the same whichever lanes were missing.
  $anchor = $own
  foreach ($seat in 'coder', 'angela', 'oscar') {
    $lane = $p.lanes.$seat
    $at = $where[$seat]
    if ($at -and $at.workspace_id -ceq $space) { "${lane}: running in $($at.pane_id)"; $anchor = $at.pane_id; continue }
    if ($at) { "${lane}: runs in another herdr space ($($at.workspace_id)): not started here; tell Jas"; $problems++; continue }
    $direction = if ($seat -eq 'angela') { 'down' } else { 'right' }
    $r = Invoke-Herdr pane split $anchor --direction $direction --cwd $root --no-focus
    $pane = $r.Result.pane.pane_id
    if (-not $pane) { "${lane}: not started: herdr pane split gave no pane ($($r.Says)); tell Jas"; $problems++; continue }
    $s = Start-Lane $seat $pane -Split
    $s.Line
    if ($s.Ok) { $anchor = $pane } else { $problems++ }
  }
  # Tab 2: pam.
  $lane = $p.lanes.pam
  if ($where.pam -and $where.pam.workspace_id -ceq $space) { "${lane}: running in $($where.pam.pane_id)" }
  elseif ($where.pam) { "${lane}: runs in another herdr space ($($where.pam.workspace_id)): not started here; tell Jas"; $problems++ }
  elseif ($pamProblem) { "${lane}: not started: $pamProblem"; $problems++ }
  else {
    $s = Start-Lane 'pam' $pamPane
    $s.Line
    if (-not $s.Ok) { $problems++ }
  }

  if ($problems) { "$problems lane(s) of $Project not running: tell Jas the lines above."; exit 1 }
  "every lane of $Project runs."
} finally {
  Remove-Item -Path Function:\Invoke-Herdr, Function:\Start-Lane, Function:\ClaudeArgs -ErrorAction SilentlyContinue
}
