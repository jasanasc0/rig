# rig.ps1 - start a project's orchestrator lane (the rig README, Daily use). Run inside herdr: & '<rig>\rig.ps1' <project>
# The project is any rig folder with a profile.json (new-project.ps1 makes one); the guard checks that profile before Claude starts.
param([Parameter(Mandatory = $true)][string]$Project)
$rig = $PSScriptRoot
$profileFile = Join-Path $rig "$Project\profile.json"
if ($Project -cnotmatch '^[a-z0-9][a-z0-9-]*$' -or -not (Test-Path -LiteralPath $profileFile -PathType Leaf)) {
  throw "No project '$Project': there is no $profileFile. A project is a rig folder with a profile.json."
}
# The guard refuses every call of a project whose profile is wrong; ask it once now (a harmless Read) so that shows here, not in the lane.
'{"tool_name":"Read","tool_input":{"file_path":"README.md"}}' | node "$rig\guard.cjs" --project $Project --seat orchestrator
if ($LASTEXITCODE -ne 0) { throw "The guard refuses $profileFile (its reason is above); fix the profile first." }
foreach ($f in "$rig\$Project\rules\orchestrator.settings.json", "$rig\$Project\rules\orchestrator.md") {
  if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { throw "$f is missing: a project needs its rules folder (new-project.ps1 copies it from example). Claude was not started." }
}
# profile.json reader: guard.cjs (loadProfile) is the one validator; keep the find-by-prefix/root and slash-normalising (-replace) lines identical in rig.ps1, wt-new.ps1, wt-remove.ps1, wt.selftest.ps1 and statusline.ps1, and add no rule here.
$p = Get-Content -LiteralPath $profileFile -Raw | ConvertFrom-Json
if ($env:HERDR_ENV -ne '1') { Write-Warning 'Not inside a herdr pane: the orchestrator will not be able to open lanes. Start herdr first.' }
Set-Location -LiteralPath $p.root
$lane = $p.lanes.orchestrator
# projectSettings false: the repo's own .claude/settings.json and its hooks stay out of the session, so GitNexus comes from
# the rig's mcp.json. The guard check above refuses a profile whose projectSettings is not true or false.
if ($p.projectSettings -eq $true) {
  claude --dangerously-skip-permissions --model opus --effort high -n $lane --settings "$rig\$Project\rules\orchestrator.settings.json" --append-system-prompt-file "$rig\$Project\rules\orchestrator.md"
} else {
  claude --dangerously-skip-permissions --model opus --effort high -n $lane --setting-sources user,local --mcp-config "$rig\$Project\rules\mcp.json" --settings "$rig\$Project\rules\orchestrator.settings.json" --append-system-prompt-file "$rig\$Project\rules\orchestrator.md"
}
