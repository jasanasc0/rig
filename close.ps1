# close.ps1 - end a project's shift in herdr (the rig README, Daily use): each lane exits through /exit and its pane closes,
# then the seats tab (when only its lanes were in it), then the orchestrator's own pane, last. The orchestrator runs it as its final tool
# call, from the PowerShell tool:
#   & '<rig>\close.ps1' <project>          (with -Force only after Jas said "close anyway")
# Everything that can stop it is checked before anything closes. The panes come from the project's profile (its lanes, never an argument),
# found by their herdr agent names, and only in the orchestrator's own herdr space; it never runs herdr server stop or workspace close and
# never touches a pane or tab of another space. The guard lets only the orchestrator run it, and only with its own project's name.
param(
  [Parameter(Mandatory = $true)][string]$Project,
  # Jas said "close anyway": a working, blocked or unknown lane is closed too (a working lane's /exit waits behind its turn, so its pane
  # closes after the 30 s poll; herdr refuses a blocked lane's /exit, so its pane closes at once).
  [switch]$Force
)
$rig = $PSScriptRoot
$profileFile = Join-Path $rig "$Project\profile.json"
if ($Project -cnotmatch '^[a-z0-9][a-z0-9-]*$' -or -not (Test-Path -LiteralPath $profileFile -PathType Leaf)) {
  throw "No project '$Project': there is no $profileFile. A project is a rig folder with a profile.json. Nothing was closed."
}
# The guard refuses every call of a project whose profile is wrong (the check rig.ps1 makes); its reason prints here.
'{"tool_name":"Read","tool_input":{"file_path":"README.md"}}' | node "$rig\guard.cjs" --project $Project --seat orchestrator
if ($LASTEXITCODE -ne 0) { throw "The guard refuses $profileFile (its reason is above); nothing was closed." }
# profile.json reader: guard.cjs (loadProfile) is the one validator (asked above); this script reads only the lane names.
$lanes = @((Get-Content -LiteralPath $profileFile -Raw | ConvertFrom-Json).lanes.PSObject.Properties | Where-Object { $_.Name -ne 'orchestrator' } | ForEach-Object { $_.Value })
if ($env:HERDR_ENV -ne '1') { throw 'Not inside a herdr pane ($env:HERDR_ENV is not 1); nothing was closed.' }

# From here on everything runs in a try whose finally removes the helpers this script defines, so a dot-sourced or imported run leaves
# no way to herdr in the caller's shell (lean review, Important 1). A throw still ends the script with its message, and exit with its code.
try {
  # Invoke-Herdr: one herdr call, its result and what herdr answered (herdr.ps1, shared with rig.ps1 and lanes.ps1).
  . (Join-Path $rig 'herdr.ps1')

  # This pane and its space: --current is the calling pane (herdr's caller context), never the pane Jas has focused.
  $r = Invoke-Herdr pane current --current
  $own = $r.Result.pane.pane_id
  $space = $r.Result.pane.workspace_id
  $ownTab = $r.Result.pane.tab_id
  if (-not $own -or -not $space) { throw "herdr could not name this pane: $($r.Says). Nothing was closed." }

  # Each lane but the orchestrator, by the herdr agent name herdr agent start gave it (herdr agent prompt sends the /exit by that name). A lane
  # herdr answers agent_not_found for is not running and is skipped; any other failed answer stops the close. One that runs in another space
  # is not touched, and one in this very pane (the script run from a lane's pane) is left to the last step.
  $targets = @()
  foreach ($lane in $lanes) {
    $r = Invoke-Herdr agent get $lane
    if (-not $r.Ok -and $r.Says -match 'agent_not_found') { "$lane is not running ($($r.Says)): skipped."; continue }
    if (-not $r.Ok) { throw "herdr could not check ${lane}: $($r.Says). Nothing was closed." }
    $agent = $r.Result.agent
    if (-not $agent.pane_id -or -not $agent.workspace_id) { throw "herdr agent get $lane named no pane or space for it: $($r.Says). Nothing was closed." }
    if ($agent.workspace_id -cne $space) { "$lane runs in another herdr space ($($agent.workspace_id)): not touched."; continue }
    if ($agent.pane_id -eq $own) { "$lane runs in this pane ($own): no /exit; this pane closes last."; continue }
    $targets += [pscustomobject]@{ Lane = $lane; Pane = $agent.pane_id; Status = $agent.agent_status }
  }
  # A blocked lane waits on an approval: its turn is in flight like a working one's (herdr would refuse its /exit and its pane would be killed).
  # An unknown one is an agent herdr can't classify, which does not prove its turn is done.
  $working = @($targets | Where-Object { $_.Status -in 'working', 'blocked', 'unknown' })
  if ($working.Count -and -not $Force) {
    throw "$(@($working | ForEach-Object { $_.Lane }) -join ', ') working, waiting on an approval, or unknown: nothing was closed. Wait until it is idle, or Jas says ""close anyway"" (-Force)."
  }
  "close $Project in herdr space ${space}: $(if ($targets.Count) { @($targets | ForEach-Object { "$($_.Lane) $($_.Pane)" }) -join ', ' } else { 'no lane' }), then the seats tab if only lanes were in it, then this pane ($own)."

  foreach ($t in $targets) {
    "$($t.Lane) ($($t.Pane)): /exit"
    $r = Invoke-Herdr agent prompt $t.Lane '/exit'
    if (-not $r.Ok) { "$($t.Lane) did not take /exit ($($r.Says)); closing its pane anyway." }
    else {
      # Done when its pane shows no agent (or is gone). A pane list that fails or can't be read counts as not done yet.
      $clock = [Diagnostics.Stopwatch]::StartNew()
      do {
        Start-Sleep -Seconds 1
        $panes = (Invoke-Herdr pane list).Result.panes
        $exited = $null -ne $panes -and -not @($panes | Where-Object { $_.pane_id -eq $t.Pane -and $_.agent })
      } until ($exited -or $clock.Elapsed.TotalSeconds -ge 30)
      if (-not $exited) { "$($t.Lane) did not exit within 30 s; closing its pane anyway." }
    }
    "$($t.Lane): closing pane $($t.Pane)"
    $r = Invoke-Herdr pane close $t.Pane
    if (-not $r.Ok) { "$($t.Lane)'s pane did not close ($($r.Says)); going on." }
  }

  # The seats tab of this space, if it is still open (closing its last pane may have closed it); never this pane's own tab. It closes only when
  # every pane still in it (one pane list, read after the lanes) was one of this run's lanes: a pane Jas opened there, or a lane herdr did not
  # find by its name, keeps it open, since closing the tab would kill that pane unchecked.
  $tabs = (Invoke-Herdr tab list).Result.tabs
  $panes = (Invoke-Herdr pane list).Result.panes
  if ($null -eq $tabs) { 'herdr tab list gave no tabs: the seats tab, if open, stays.' }
  foreach ($tab in @($tabs | Where-Object { $_.workspace_id -ceq $space -and $_.label -ceq 'seats' -and $_.tab_id -ne $ownTab })) {
    $stay = @($panes | Where-Object { $_.tab_id -eq $tab.tab_id -and $_.pane_id -cnotin $targets.Pane } | ForEach-Object { $_.pane_id })
    if ($null -eq $panes) { "herdr pane list gave no panes: the seats tab ($($tab.tab_id)) stays." }
    elseif ($stay.Count) { "the seats tab ($($tab.tab_id)) stays, with $($stay -join ', ') in it (not one of this run's lanes): not touched." }
    else {
      "closing the seats tab ($($tab.tab_id))"
      $r = Invoke-Herdr tab close $tab.tab_id
      if (-not $r.Ok) { "the seats tab did not close ($($r.Says)); going on." }
    }
  }

  "closing this pane ($own): the orchestrator ends here."
  $r = Invoke-Herdr pane close $own
  if (-not $r.Ok) { throw "this pane did not close: $($r.Says). Close it by hand." }
} finally {
  Remove-Item -Path Function:\Invoke-Herdr -ErrorAction SilentlyContinue
}
