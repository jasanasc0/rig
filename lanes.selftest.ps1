# lanes.selftest.ps1 - checks lanes.ps1 (the rig README, Daily use) against the rig's fake herdr (fake-herdr.cjs) in %TEMP%. The
# real herdr is never called: Jas's live rigs share its server. Each run is lanes.ps1, unchanged, in a temp rig folder (with herdr.ps1, a
# stub guard and two projects: example, from the profile next to this file, and sample, made from it with projectSettings true; each root is
# a temp folder with a blank in its name) in a child powershell with a PATH of only the fake, node and Windows, and the caller context herdr
# gives every pane ($env:HERDR_ENV, HERDR_PANE_ID, HERDR_TAB_ID, HERDR_WORKSPACE_ID). Before every run the test checks that this PATH finds
# herdr only as the fake, and runs nothing if not; the stub guard, which lanes.ps1 asks before any herdr call, refuses unless the child's
# PATH is that one.
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File <rig>\lanes.selftest.ps1
$ps = Join-Path $PSHOME 'powershell.exe'
$node = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$tmp = Join-Path $env:TEMP ('rig-lanes-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$fake = Join-Path $tmp 'bin'
$rig = Join-Path $tmp 'rig'
$stateFile = Join-Path $fake 'state.json'
$callsFile = Join-Path $fake 'calls.log'
$isolated = "$fake;$(Split-Path -Parent $node);$env:SystemRoot\System32;$env:SystemRoot"
$roots = @{ example = Join-Path $tmp 'root example'; sample = Join-Path $tmp 'root sample' }
$script:fails = 0
function Check($ok, $label) { if ($ok) { "ok   $label" } else { "FAIL $label"; $script:fails++ } }
# lanes.ps1 asks the guard about the profile before any herdr call; this one says yes only on the test's isolated PATH.
$stubGuard = @"
'use strict';
require('fs').readFileSync(0);
process.exitCode = process.env.PATH === $($isolated | ConvertTo-Json) ? 0 : 1;
if (process.exitCode) process.stderr.write('stub guard: this is not the test PATH; nothing runs\n');
"@

# The flags each worker lane starts with (the rig README, The seats), the same in every project, and a lane's whole argument list after
# `--`: -n <lane>, --setting-sources user,local where the profile's projectSettings is false (example; sample's is true), the flags, then
# its own project's settings file, seat file and MCP config.
$flags = [ordered]@{
  coder = '--model opus --effort max --permission-mode auto --disallowedTools Agent'
  angela = '--model fable --effort max --permission-mode auto --disallowedTools Edit Write NotebookEdit Agent'
  oscar = '--model sonnet --effort medium --permission-mode auto --disallowedTools Edit Write NotebookEdit Agent'
  pam = '--model sonnet --effort medium --permission-mode auto --disallowedTools Edit Write NotebookEdit Agent'
}
$lanes = @{}
function Lane($project, $seat) { $lanes[$project].$seat }
function ClaudeArgs($project, $seat) {
  $rules = ($rig -replace '\\', '/') + "/$project/rules"
  $sources = if ($project -eq 'example') { '--setting-sources user,local ' } else { '' }
  "-n $(Lane $project $seat) $sources$($flags[$seat]) --settings $rules/$seat.settings.json --append-system-prompt-file $rules/seats/$seat.md --strict-mcp-config --mcp-config $rules/mcp.json" -split ' '
}
# A herdr call as calls.log writes it (words joined by tabs), and shown with blanks.
function Call { $args -join "`t" }
function Show($calls) { @($calls | ForEach-Object { $_ -replace "`t", ' ' }) -join ' | ' }
function Split($from, $direction, $project) { Call pane split $from --direction $direction --cwd $roots[$project] --no-focus }
function Launch($project, $seat, $pane) { (@('agent', 'start', (Lane $project $seat), '--kind', 'claude', '--pane', $pane, '--') + (ClaudeArgs $project $seat)) -join "`t" }
function Gets($project) { foreach ($seat in 'coder', 'angela', 'oscar', 'pam') { Call agent get (Lane $project $seat) } }
function Pane($id, $tab, $name) {
  $p = [ordered]@{ pane_id = $id; tab_id = $tab; workspace_id = $id.Split(':')[0] }
  if ($name) { $p.agent = 'claude'; $p.name = $name; $p.agent_status = 'idle' }
  $p
}
function Tab($id, $label) { [ordered]@{ tab_id = $id; workspace_id = $id.Split(':')[0]; label = $label } }
# Two herdr spaces. w1: example's, its orchestrator in w1:p1 (tab w1:t1) and its seats tab w1:t2 holding one empty pane, w1:p5. w2: sample's,
# laid out the same. No lane runs yet.
function Base {
  @{
    panes = @((Pane 'w1:p1' 'w1:t1'), (Pane 'w1:p5' 'w1:t2'), (Pane 'w2:p1' 'w2:t1'), (Pane 'w2:p5' 'w2:t2'))
    tabs = @((Tab 'w1:t1' '1'), (Tab 'w1:t2' 'seats'), (Tab 'w2:t1' '1'), (Tab 'w2:t2' 'seats'))
  }
}
# Base with lanes already running (pane id -> seat): pam in the seats tab's pane, the others in new panes of tab 1.
function Running($project, $map) {
  $s = Base
  foreach ($id in $map.Keys) {
    $p = @($s.panes | Where-Object { $_.pane_id -eq $id })[0]
    if (-not $p) { $p = Pane $id ($id.Split(':')[0] + ':t1'); $s.panes += $p }
    $p.agent = 'claude'; $p.name = Lane $project $map[$id]; $p.agent_status = 'idle'
  }
  $s
}

# One run of lanes.ps1 in a child powershell with the isolated PATH and a pane's caller context: its exit code, output, every herdr call
# and the state after.
function Invoke-Lanes($state, $project, $pane = 'w1:p1', $tab = 'w1:t1', [switch]$NoHerdrEnv, [switch]$NoPaneId, [switch]$DotSource) {
  [IO.File]::WriteAllText($stateFile, ($state | ConvertTo-Json -Depth 6 -Compress))
  [IO.File]::WriteAllText($callsFile, '')
  $names = 'PATH', 'HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID'
  $saved = @{}
  foreach ($n in $names) { $saved[$n] = [Environment]::GetEnvironmentVariable($n, 'Process') }
  try {
    $env:PATH = $isolated
    # The isolation, before every run: on this PATH, herdr is the fake and nothing else.
    $found = @(Get-Command herdr -All -ErrorAction SilentlyContinue | ForEach-Object { $_.Source })
    if ($found.Count -ne 1 -or $found[0] -ne (Join-Path $fake 'herdr.cmd')) { throw "the test PATH finds herdr at '$($found -join "', '")', not only the fake; nothing was run" }
    $env:HERDR_ENV = $(if ($NoHerdrEnv) { $null } else { '1' })
    $env:HERDR_PANE_ID = $(if ($NoPaneId) { $null } else { $pane })
    $env:HERDR_TAB_ID = $tab
    $env:HERDR_WORKSPACE_ID = $pane.Split(':')[0]
    # -DotSource: lanes.ps1 dot-sourced into the child's own shell (a refusal caught there), which then says whether any of its helpers is
    # still defined there.
    $run = if ($DotSource) { @('-Command', "try { . '$(Join-Path $rig 'lanes.ps1')' $project } catch { 'caught: ' + `$_ }; 'leaked: ' + [bool](Get-Command Invoke-Herdr, Start-Lane, ClaudeArgs -ErrorAction SilentlyContinue)") } else { @('-File', (Join-Path $rig 'lanes.ps1'), $project) }
    $out = @(& $ps -NoProfile -ExecutionPolicy Bypass @run 2>&1 | ForEach-Object { "$_" })
    $code = $LASTEXITCODE
  } finally { foreach ($n in $names) { [Environment]::SetEnvironmentVariable($n, $saved[$n], 'Process') } }
  $text = $out -join "`n"
  [pscustomobject]@{
    Code = $code; Out = $text; Flat = $text -replace '\s', ''
    Calls = @([IO.File]::ReadAllLines($callsFile) | Where-Object { $_ })
    Acts = @([IO.File]::ReadAllLines($callsFile) | Where-Object { $_ -match "^(?:pane`tsplit|agent`tstart|tab`tcreate|pane`tclose)`t" })
    State = [IO.File]::ReadAllText($stateFile) | ConvertFrom-Json
  }
}
function P($state, $id) { @($state.panes | Where-Object { $_.pane_id -eq $id })[0] }
# The lane in pane $id has its herdr name and exactly its argument list.
function Check-Lane($r, $project, $seat, $id, $label) {
  $p = P $r.State $id
  Check ($null -ne $p -and $p.name -ceq (Lane $project $seat) -and (@($p.args) -join "`t") -ceq ((ClaudeArgs $project $seat) -join "`t")) "$label - $(Lane $project $seat) runs in $id with its flags and its own rules ($(if ($p) { @($p.args) -join ' ' } else { 'no pane' }))"
}
# No call names another space than this one.
function Check-Space($r, $label, $otherSpace) {
  Check (-not @($r.Calls | Where-Object { @($_ -split "`t") | Where-Object { $_ -ceq $otherSpace -or $_.StartsWith("${otherSpace}:") } })) "$label - no call names the other space ($otherSpace)"
}

New-Item -ItemType Directory $fake | Out-Null
try {
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'fake-herdr.cjs') -Destination $fake # the rig's one fake herdr
  [IO.File]::WriteAllText((Join-Path $fake 'herdr.cmd'), "@`"$node`" `"%~dp0fake-herdr.cjs`" %*`r`n@exit /b %ERRORLEVEL%`r`n")
  # The test rig: lanes.ps1 and herdr.ps1 as they are, the stub guard, and each project's profile (root: a temp folder with a blank).
  New-Item -ItemType Directory $rig | Out-Null
  foreach ($f in 'lanes.ps1', 'herdr.ps1') { if (Test-Path -LiteralPath (Join-Path $PSScriptRoot $f)) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $f) -Destination $rig } }
  [IO.File]::WriteAllText((Join-Path $rig 'guard.cjs'), $stubGuard)
  foreach ($project in 'example', 'sample') {
    New-Item -ItemType Directory (Join-Path $rig "$project\rules"), $roots[$project] | Out-Null
    $p = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'example\profile.json') -Raw | ConvertFrom-Json
    if ($project -eq 'sample') {
      $p.name = 'sample'; $p.ticketPrefix = 'sm'; $p.projectSettings = $true
      foreach ($seat in 'orchestrator', 'coder', 'angela', 'oscar', 'pam') { $p.lanes.$seat = "sm-$seat" }
    }
    $p.root = $roots[$project] -replace '\\', '/'
    $lanes[$project] = $p.lanes
    [IO.File]::WriteAllText((Join-Path $rig "$project\profile.json"), ($p | ConvertTo-Json -Depth 5))
  }
  $reads = @(Gets 'example') + @((Call tab list), (Call pane list))
  $all = @((Split 'w1:p1' right example), (Launch example coder 'w1:p6'), (Split 'w1:p6' down example), (Launch example angela 'w1:p7'), (Split 'w1:p7' right example), (Launch example oscar 'w1:p8'), (Launch example pam 'w1:p5'))

  # (a) No lane runs: tab 1 gets coder right of the orchestrator, angela below coder, oscar right of angela, each in the project's root; pam
  # starts in the seats tab's pane. Every lane has its own flags and its project's rules; one line each; exit 0.
  $r = Invoke-Lanes (Base) 'example'
  Check ((Show $r.Calls) -ceq (Show ($reads + $all))) "(a) no lane runs: four agent gets, tab list, pane list, then three splits and four starts ($(Show $r.Calls))"
  Check-Lane $r 'example' 'coder' 'w1:p6' '(a)'
  Check-Lane $r 'example' 'angela' 'w1:p7' '(a)'
  Check-Lane $r 'example' 'oscar' 'w1:p8' '(a)'
  Check-Lane $r 'example' 'pam' 'w1:p5' '(a)'
  Check (@('w1:p6', 'w1:p7', 'w1:p8' | Where-Object { (P $r.State $_).tab_id -ceq 'w1:t1' -and (P $r.State $_).cwd -ceq $roots.example }).Count -eq 3) '(a) the three new panes are in tab 1 and open in the root'
  Check ($r.Code -eq 0 -and $r.Out -match 'coder: started in w1:p6' -and $r.Out -match 'angela: started in w1:p7' -and $r.Out -match 'oscar: started in w1:p8' -and $r.Out -match 'pam: started in w1:p5') "(a) exit 0, one line per lane ($($r.Code))"
  Check-Space $r '(a)' 'w2'

  # (b) Every lane runs in this space: nothing is split or started; pane list is not read; exit 0.
  $r = Invoke-Lanes (Running 'example' ([ordered]@{ 'w1:p2' = 'coder'; 'w1:p3' = 'angela'; 'w1:p4' = 'oscar'; 'w1:p5' = 'pam' })) 'example'
  Check ((Show $r.Calls) -ceq (Show (@(Gets 'example') + (Call tab list)))) "(b) every lane runs: only the reads ($(Show $r.Calls))"
  Check ($r.Code -eq 0 -and $r.Out -match 'coder: running in w1:p2' -and $r.Out -match 'pam: running in w1:p5') "(b) exit 0, each lane said running with its pane ($($r.Code))"

  # (c) Only angela is missing: she is split below coder's pane, nothing else moves.
  $r = Invoke-Lanes (Running 'example' ([ordered]@{ 'w1:p2' = 'coder'; 'w1:p4' = 'oscar'; 'w1:p5' = 'pam' })) 'example'
  Check ((Show $r.Acts) -ceq (Show @((Split 'w1:p2' down example), (Launch example angela 'w1:p6')))) "(c) angela missing: split coder's pane down, start angela there ($(Show $r.Acts))"
  Check-Lane $r 'example' 'angela' 'w1:p6' '(c)'
  Check ($r.Code -eq 0) "(c) exit 0 ($($r.Code))"

  # (d) Only coder is missing: he is split right of the orchestrator's own pane.
  $r = Invoke-Lanes (Running 'example' ([ordered]@{ 'w1:p3' = 'angela'; 'w1:p4' = 'oscar'; 'w1:p5' = 'pam' })) 'example'
  Check ((Show $r.Acts) -ceq (Show @((Split 'w1:p1' right example), (Launch example coder 'w1:p6')))) "(d) coder missing: split the own pane right, start coder ($(Show $r.Acts))"

  # (e) herdr answers agent_not_ready for angela (a dialog waits in her pane): said, she counts as started, oscar still splits from her pane.
  $s = Base
  $s.canned = @{ ((Launch example angela 'w1:p7') -replace "`t", ' ') = 'agent_not_ready' }
  $r = Invoke-Lanes $s 'example'
  Check ((Show $r.Acts) -ceq (Show $all)) "(e) agent_not_ready: the same calls as (a) ($(Show $r.Acts))"
  Check ($r.Code -eq 0 -and $r.Out -match 'angela: started in w1:p7' -and $r.Out -match 'agent_not_ready' -and $r.Out -match 'dialog') "(e) exit 0, angela's line says to answer the dialog in her pane ($($r.Code))"

  # (f) This space has no seats tab: tab 1 still starts; pam does not; the line gives Jas the tab create command for this space and root;
  # lanes.ps1 never creates a tab itself; exit 1.
  $s = Base
  $s.tabs = @($s.tabs | Where-Object { $_.tab_id -ne 'w1:t2' })
  $s.panes = @($s.panes | Where-Object { $_.pane_id -ne 'w1:p5' })
  $r = Invoke-Lanes $s 'example'
  # Without w1:p5 the new panes are w1:p2 to w1:p4.
  $tab1 = @((Split 'w1:p1' right example), (Launch example coder 'w1:p2'), (Split 'w1:p2' down example), (Launch example angela 'w1:p3'), (Split 'w1:p3' right example), (Launch example oscar 'w1:p4'))
  Check ((Show $r.Acts) -ceq (Show $tab1)) "(f) no seats tab: tab 1 starts, no pam and no tab create ($(Show $r.Acts))"
  Check ($r.Code -eq 1 -and $r.Flat -match ('pam:notstarted.*noseatstab.*herdrtabcreate--workspacew1--cwd' + [regex]::Escape("'" + ($roots.example -replace '\s', '') + "'") + '--labelseats--no-focus')) "(f) exit 1, pam's line gives Jas the command for w1 and the root ($($r.Code))"

  # (g) The seats tab holds two panes, or its one pane runs an agent: pam is not started, said, exit 1.
  $s = Base
  $s.panes += Pane 'w1:p9' 'w1:t2'
  $r = Invoke-Lanes $s 'example'
  Check ($r.Code -eq 1 -and -not @($r.Acts | Where-Object { $_ -match "^agent`tstart`tex-pam`t" }) -and $r.Out -match 'pam: not started: the seats tab \(w1:t2\) holds 2 panes') "(g) two panes in the seats tab: no pam, said, exit 1 ($($r.Code))"
  $s = Base
  (P $s 'w1:p5').agent = 'claude'
  $r = Invoke-Lanes $s 'example'
  Check ($r.Code -eq 1 -and -not @($r.Acts | Where-Object { $_ -match "^agent`tstart`tex-pam`t" }) -and $r.Out -match 'pam: not started: the seats tab \(w1:t2\) .*agent') "(g) an agent in the seats tab's pane: no pam, said, exit 1 ($($r.Code))"

  # (h) coder's name runs in another space (w2): not started here and said; angela splits from the own pane instead; exit 1.
  $s = Base
  $s.panes += Pane 'w2:p3' 'w2:t1' 'ex-coder'
  $r = Invoke-Lanes $s 'example'
  Check ($r.Code -eq 1 -and $r.Out -match 'coder: runs in another herdr space \(w2\)' -and -not @($r.Acts | Where-Object { $_ -match "^agent`tstart`tex-coder`t" })) "(h) coder in w2: not started, said, exit 1 ($($r.Code))"
  Check (@($r.Acts)[0] -ceq (Split 'w1:p1' down example)) "(h) angela splits from the own pane ($(Show @($r.Acts)[0]))"

  # (i) Started from a pane in this space's seats tab (a leftover tab-2 pane): nothing is split or started (tab-1 lanes would land in the
  # seats tab); the line says to start the rig from a pane in another tab.
  $r = Invoke-Lanes (Base) 'example' 'w1:p5' 'w1:t2'
  Check ($r.Code -ne 0 -and $r.Acts.Count -eq 0 -and $r.Out -match 'seats tab' -and $r.Out -match 'nothing was started') "(i) run from the seats tab: refused, nothing started ($($r.Code), $(Show $r.Acts))"

  # (j) What stops it before any herdr call: a project that is not a rig folder, no HERDR_ENV, no HERDR_PANE_ID.
  foreach ($bad in 'nope', 'Example', '..\example', 'example;x') {
    $r = Invoke-Lanes (Base) $bad
    Check ($r.Code -ne 0 -and $r.Calls.Count -eq 0 -and $r.Out -match 'Nothing was started') "(j) project '$bad': refused before any herdr call ($($r.Code), $($r.Calls.Count) calls)"
  }
  $r = Invoke-Lanes (Base) 'example' -NoHerdrEnv
  Check ($r.Code -ne 0 -and $r.Calls.Count -eq 0 -and $r.Out -match 'HERDR_ENV') "(j) no HERDR_ENV: refused before any herdr call ($($r.Code), $($r.Calls.Count) calls)"
  $r = Invoke-Lanes (Base) 'example' -NoPaneId
  Check ($r.Code -ne 0 -and $r.Calls.Count -eq 0 -and $r.Out -match 'HERDR_PANE_ID') "(j) no HERDR_PANE_ID: refused before any herdr call ($($r.Code), $($r.Calls.Count) calls)"

  # (k) A read herdr can't answer (an error other than agent_not_found, an answer that is not JSON): nothing is split or started.
  $s = Base
  $s.canned = @{ 'agent get ex-angela' = 'server_busy' }
  $r = Invoke-Lanes $s 'example'
  Check ($r.Code -ne 0 -and $r.Acts.Count -eq 0 -and $r.Out -match 'angela' -and $r.Out -match 'server_busy' -and $r.Out -match 'nothing was started') "(k) agent get angela fails: refused, nothing started ($($r.Code))"
  foreach ($cmd in 'tab list', 'pane list') {
    $s = Base
    $s.canned = @{ $cmd = 'oops' }
    $r = Invoke-Lanes $s 'example'
    Check ($r.Code -ne 0 -and $r.Acts.Count -eq 0 -and $r.Out -match 'nothing was started') "(k) $cmd answers oops: refused, nothing started ($($r.Code))"
  }

  # (l) sample from its own space w2: sm- names, no --setting-sources (its projectSettings is true), its own rules; nothing names w1.
  $r = Invoke-Lanes (Base) 'sample' 'w2:p1' 'w2:t1'
  Check ((Show $r.Acts) -ceq (Show @((Split 'w2:p1' right sample), (Launch sample coder 'w2:p6'), (Split 'w2:p6' down sample), (Launch sample angela 'w2:p7'), (Split 'w2:p7' right sample), (Launch sample oscar 'w2:p8'), (Launch sample pam 'w2:p5')))) "(l) sample: its four lanes in w2 ($(Show $r.Acts))"
  Check-Lane $r 'sample' 'coder' 'w2:p6' '(l)'
  Check-Lane $r 'sample' 'pam' 'w2:p5' '(l)'
  Check-Space $r '(l)' 'w1'

  # (m) A root with a blank and a trailing slash reaches herdr as one word.
  $profileFile = Join-Path $rig 'example\profile.json'
  $profileText = [IO.File]::ReadAllText($profileFile)
  $p = $profileText | ConvertFrom-Json
  $p.root = ($roots.example -replace '\\', '/') + '/'
  [IO.File]::WriteAllText($profileFile, ($p | ConvertTo-Json -Depth 5))
  try { $r = Invoke-Lanes (Base) 'example' } finally { [IO.File]::WriteAllText($profileFile, $profileText) }
  Check ((Show $r.Acts) -ceq (Show $all)) "(m) a root ending in a slash: each split gets it as one word ($(Show $r.Acts))"

  # (t) Dot-sourced, lanes.ps1 leaves no herdr helper in the caller's shell: Invoke-Herdr, Start-Lane and
  # ClaudeArgs are gone when it ends, so no later statement of that shell can drive herdr past the guard, however the script was loaded.
  $r = Invoke-Lanes (Base) 'example' -DotSource
  Check ($r.Out -match 'every lane of example runs' -and $r.Out -match 'leaked: False') "(t) dot-sourced: the lanes start and no helper is left in the caller ($((($r.Out -split "`n") | Select-Object -Last 1)))"
  $r = Invoke-Lanes (Base) 'example' 'w1:p5' 'w1:t2' -DotSource
  Check ($r.Out -match 'caught: .*nothing was started' -and $r.Out -match 'leaked: False') "(t) dot-sourced and refused (run from the seats tab): no helper is left in the caller ($((($r.Out -split "`n") | Select-Object -Last 1)))"

  # (n) A long herdr answer is cut at 300 characters in the line lanes.ps1 prints (its lines land in the orchestrator's context).
  $s = Base
  $s.canned = @{ 'tab list' = 'long' }
  $r = Invoke-Lanes $s 'example'
  Check ($r.Flat.Contains('x' * 300 + '...') -and -not $r.Flat.Contains('x' * 301)) "(n) a 1,000-character answer: 300 shown, then ..."

  # (o) A new pane's shell not at its prompt yet: herdr answers agent_pane_unavailable, and lanes.ps1 asks again
  # until the start goes through.
  $s = Base
  $s.notReady = @{ 'w1:p6' = 2 }
  $r = Invoke-Lanes $s 'example'
  $tries = @($r.Calls | Where-Object { $_ -ceq (Launch example coder 'w1:p6') }).Count
  Check ($r.Code -eq 0 -and $tries -eq 3 -and $r.Out -match 'coder: started in w1:p6') "(o) coder's shell ready on the third try: started, exit 0 ($tries tries, $($r.Code))"
  Check-Lane $r 'example' 'coder' 'w1:p6' '(o)'

  # (p) A shell that never gets there: after 15 s coder is not started, lanes.ps1 closes the pane it split for him (no empty pane piles up
  # when it runs again), angela splits from the orchestrator's own pane instead, and the run ends with exit 1.
  $s = Base
  $s.notReady = @{ 'w1:p6' = 1000 }
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $r = Invoke-Lanes $s 'example'
  $took = $clock.Elapsed.TotalSeconds
  Check ($r.Code -eq 1 -and $took -ge 15 -and $r.Out -match 'coder: not started: herdr agent start failed in w1:p6.*agent_pane_unavailable' -and $r.Out -match 'closed again') "(p) never ready: given up after 15 s, said, exit 1 ($([int]$took) s, $($r.Code))"
  $splits = @($r.Acts | Where-Object { $_ -match "^pane`tsplit`t" })
  Check ($null -eq (P $r.State 'w1:p6') -and @($r.Calls | Where-Object { $_ -ceq (Call pane close w1:p6) }).Count -eq 1 -and $splits[1] -ceq (Split 'w1:p1' down example)) "(p) never ready: its pane closed again, angela split from the own pane ($(Show $splits))"

  # (q) A start that fails another way: the same for a tab-1 lane; pam's pane is the seats tab's own, so it stays.
  $s = Base
  $s.canned = @{ ((Launch example coder 'w1:p6') -replace "`t", ' ') = 'server_busy'; ((Launch example pam 'w1:p5') -replace "`t", ' ') = 'server_busy' }
  $r = Invoke-Lanes $s 'example'
  Check ($r.Code -eq 1 -and $r.Out -match 'coder: not started: .*server_busy.*closed again' -and $null -eq (P $r.State 'w1:p6')) "(q) coder's start fails (server_busy): said, his pane closed again, exit 1 ($($r.Code))"
  Check ($r.Out -match 'pam: not started: .*server_busy' -and $null -ne (P $r.State 'w1:p5') -and -not @($r.Calls | Where-Object { $_ -ceq (Call pane close w1:p5) })) "(q) pam's start fails: said, the seats tab's pane stays"

  # (r) A split that fails: that lane is not started and the next one splits from the pane before it.
  $s = Base
  $s.canned = @{ ((Split 'w1:p1' right example) -replace "`t", ' ') = 'server_busy' }
  $r = Invoke-Lanes $s 'example'
  Check ($r.Code -eq 1 -and $r.Out -match 'coder: not started: herdr pane split gave no pane' -and @($r.Acts)[1] -ceq (Split 'w1:p1' down example)) "(r) coder's split fails: said, angela splits from the own pane, exit 1 ($(Show $r.Acts))"

  # (s) pam's name runs in another space: not started here, said, exit 1; its seats tab is not even read.
  $s = Base
  $s.panes += Pane 'w2:p4' 'w2:t2' 'ex-pam'
  $r = Invoke-Lanes $s 'example'
  Check ($r.Code -eq 1 -and $r.Out -match 'pam: runs in another herdr space \(w2\)' -and -not @($r.Acts | Where-Object { $_ -match "^agent`tstart`tex-pam`t" }) -and -not @($r.Calls | Where-Object { $_ -ceq (Call pane list) })) "(s) pam in w2: not started, said, exit 1, no pane list ($($r.Code))"
} catch {
  # A terminating error must not let the run fall through to "all checks passed": count it and report it.
  "FAIL self-test aborted: $($_.Exception.Message)"
  $script:fails++
} finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force   # a plain temp folder: no links inside
}
if ($script:fails) { "$($script:fails) check(s) failed"; exit 1 }
'lanes selftest: all checks passed'
exit 0
