# rig.ps1 - start a project's orchestrator lane (the rig README, Daily use). Run inside herdr: & '<rig>\bin\rig.ps1' <project>
# The project is any rig folder with a profile.json (new-project.ps1 makes one); the guard checks that profile before Claude starts.
param([Parameter(Mandatory = $true)][string]$Project)
# The rig is the folder above this script's bin\.
$rig = Split-Path -Parent $PSScriptRoot
$profileFile = Join-Path $rig "$Project\profile.json"
if ($Project -cnotmatch '^[a-z0-9][a-z0-9-]*$' -or -not (Test-Path -LiteralPath $profileFile -PathType Leaf)) {
  throw "No project '$Project': there is no $profileFile. A project is a rig folder with a profile.json."
}
# The guard refuses every call of a project whose profile is wrong; ask it once now (a harmless Read) so that shows here, not in the lane.
'{"tool_name":"Read","tool_input":{"file_path":"README.md"}}' | node "$rig\hooks\guard.cjs" --project $Project --seat orchestrator
if ($LASTEXITCODE -ne 0) { throw "The guard refuses $profileFile (its reason is above); fix the profile first." }
foreach ($f in "$rig\$Project\rules\orchestrator.settings.json", "$rig\$Project\rules\orchestrator.md") {
  if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { throw "$f is missing: a project needs its rules folder (new-project.ps1 copies it from example). Claude was not started." }
}
# profile.json reader: guard.cjs (loadProfile) is the one validator; keep the find-by-prefix/root and slash-normalising (-replace) lines identical in rig.ps1, wt-new.ps1, wt-remove.ps1, wt.selftest.ps1 and statusline.ps1, and add no rule here.
$p = Get-Content -LiteralPath $profileFile -Raw | ConvertFrom-Json
$root = $p.root -replace '/', '\'
# Invoke-Herdr: one herdr call, its result and what herdr answered (herdr.ps1, shared with lanes.ps1 and close.ps1).
. "$PSScriptRoot\herdr.ps1"
if ($env:HERDR_ENV -ne '1') { Write-Warning 'Not inside a herdr pane: the orchestrator will not be able to open lanes. Start herdr first.' }
else {
  # The seats build (the rig README, Daily use): name this herdr space after the project and open its seats tab, before Claude starts. A herdr
  # failure only warns: the steps that need its answer are skipped, and the orchestrator still starts with the same arguments.
  # This pane's space: --current is the calling pane, never the pane Jas has focused.
  $r = Invoke-Herdr pane current --current
  $space = $r.Result.pane.workspace_id
  if (-not $space) { Write-Warning "herdr pane current --current did not name this pane's space, so the space was not named and no seats tab was opened: $($r.Says)" }
  else {
    $r = Invoke-Herdr workspace rename $space $Project
    if ($r.Ok) { "herdr space $space is named $Project" } else { Write-Warning "herdr workspace rename did not name space $space ${Project}: $($r.Says)" }
    # tab list lists every space: only a seats tab in this one counts. Without the list no tab opens (a second seats tab would confuse
    # the orchestrator).
    $r = Invoke-Herdr tab list
    $tabs = $r.Result.tabs
    if ($null -eq $tabs) { Write-Warning "herdr tab list gave no tabs, so no seats tab was opened (one may be open already): $($r.Says)" }
    else {
      $seats = @($tabs | Where-Object { $_.workspace_id -ceq $space -and $_.label -ceq 'seats' } | ForEach-Object { $_.tab_id })
      if ($seats.Count) { "the seats tab of herdr space $space is already open ($($seats -join ', '))" }
      else {
        # Without its trailing backslash: Windows PowerShell 5.1 would pass 'C:\x\my root\' as `C:\x\my root" --label ...` (one word).
        $r = Invoke-Herdr tab create --workspace $space --cwd $root.TrimEnd('\') --label seats --no-focus
        $tab = $r.Result.tab.tab_id
        if ($tab) { "opened the seats tab of herdr space $space ($tab)" } else { Write-Warning "herdr tab create did not open the seats tab, or named no tab: $($r.Says)" }
      }
    }
  }
}
Set-Location -LiteralPath $p.root
$lane = $p.lanes.orchestrator
# projectSettings false: the repo's own .claude/settings.json and its hooks stay out of the session, so GitNexus comes from
# the rig's mcp.json. The guard check above refuses a profile whose projectSettings is not true or false.
if ($p.projectSettings -eq $true) {
  claude --dangerously-skip-permissions --model opus --effort high -n $lane --settings "$rig\$Project\rules\orchestrator.settings.json" --append-system-prompt-file "$rig\$Project\rules\orchestrator.md"
} else {
  claude --dangerously-skip-permissions --model opus --effort high -n $lane --setting-sources user,local --mcp-config "$rig\$Project\rules\mcp.json" --settings "$rig\$Project\rules\orchestrator.settings.json" --append-system-prompt-file "$rig\$Project\rules\orchestrator.md"
}
