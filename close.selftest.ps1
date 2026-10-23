# close.selftest.ps1 - checks close.ps1 against a fake herdr in %TEMP%. The real herdr is never called: Jas's live rigs share its
# server. Each run of close.ps1 gets a PATH of only the fake, node and Windows, and nothing runs if any other herdr is found on it. The
# fake answers from a state file (herdr 0.8.2's JSON shapes), records every call and changes the state as herdr would. close.ps1 runs
# from a temp rig: copies of it and guard.cjs (next to this file), example's profile and a second project, sample, made from it.
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File <rig>\close.selftest.ps1   (about a minute: one case waits out the 30 s poll)
$ps = Join-Path $PSHOME 'powershell.exe'
$node = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$tmp = Join-Path $env:TEMP ('rig-close-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$rig = Join-Path $tmp 'rig'
$closePs1 = Join-Path $rig 'close.ps1'
$fake = Join-Path $tmp 'bin'
$stateFile = Join-Path $fake 'state.json'
$callsFile = Join-Path $fake 'calls.log'
$isolated = "$fake;$(Split-Path -Parent $node);$env:SystemRoot\System32;$env:SystemRoot"
$script:fails = 0
function Check($ok, $label) { if ($ok) { "ok   $label" } else { "FAIL $label"; $script:fails++ } }

$fakeHerdr = @'
'use strict';
// Fake herdr for close.selftest.ps1: answers from state.json next to it and appends every call to calls.log. An /exit ends the agent
// (its herdr name goes with it) unless the pane is stubborn; a blocked agent refuses a prompt; a closed tab takes its panes. A command
// named in state.json's `canned` gets that answer instead: `oops` (not JSON, exit 0) or a herdr error code (exit 1).
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, 'state.json');
const s = JSON.parse(fs.readFileSync(file, 'utf8'));
const a = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'calls.log'), a.join(' ') + '\n');
const ok = (result) => process.stdout.write(JSON.stringify({ id: 'cli:fake', result }) + '\n');
const fail = (code, message) => {
  process.stderr.write(JSON.stringify({ id: 'cli:fake', error: { code, message } }) + '\n');
  process.exitCode = 1;
};
const save = () => fs.writeFileSync(file, JSON.stringify(s));
const named = (n) => s.panes.find((p) => p.name === n && p.agent);
const cmd = a.slice(0, 2).join(' ');
const canned = (s.canned || {})[a.join(' ')];
if (canned === 'oops') process.stdout.write('oops\n');
else if (canned) fail(canned, a.join(' ') + ' failed');
else if (cmd === 'pane current' && a[2] === '--current' && a.length === 3) {
  const p = s.panes.find((x) => x.pane_id === s.current);
  p ? ok({ type: 'pane_current', pane: p }) : fail('pane_not_found', 'no current pane');
} else if (cmd === 'pane list' && a.length === 2) ok({ type: 'pane_list', panes: s.panes });
else if (cmd === 'tab list' && a.length === 2) ok({ type: 'tab_list', tabs: s.tabs });
else if (cmd === 'agent get' && a.length === 3) {
  const p = named(a[2]);
  p ? ok({ type: 'agent_info', agent: { ...p } }) : fail('agent_not_found', 'no agent ' + a[2]);
} else if (cmd === 'agent prompt' && a.length === 4) {
  const p = named(a[2]);
  if (!p) fail('agent_not_found', 'no agent ' + a[2]);
  else if (p.agent_status === 'blocked') fail('agent_blocked', a[2] + ' is blocked');
  else {
    if (a[3] === '/exit' && !p.stubborn) Object.assign(p, { agent: null, name: null, agent_status: 'unknown' });
    save();
    ok({ type: 'agent_prompted' });
  }
} else if (cmd === 'pane close' && a.length === 3) {
  const i = s.panes.findIndex((p) => p.pane_id === a[2]);
  if (i < 0) fail('pane_not_found', 'no pane ' + a[2]);
  else {
    s.panes.splice(i, 1);
    save();
    ok({ type: 'ok' });
  }
} else if (cmd === 'tab close' && a.length === 3) {
  const i = s.tabs.findIndex((t) => t.tab_id === a[2]);
  if (i < 0) fail('tab_not_found', 'no tab ' + a[2]);
  else {
    s.tabs.splice(i, 1);
    s.panes = s.panes.filter((p) => p.tab_id !== a[2]);
    save();
    ok({ type: 'ok' });
  }
} else {
  process.stderr.write('fake herdr: unexpected command: ' + a.join(' ') + '\n');
  process.exitCode = 2;
}
'@

# A pane as herdr's pane list and agent get show it: `name` is the herdr agent name (herdr agent start <lane> sets it; rig.ps1's
# orchestrator is "claude"), `agent` is null in a pane whose agent has exited.
function Pane($id, $tab, $name, $status = 'idle', [switch]$Shell, [switch]$Stubborn) {
  [ordered]@{
    pane_id = $id; tab_id = $tab; workspace_id = $id.Split(':')[0]; agent = $(if ($Shell) { $null } else { 'claude' }); agent_status = $status
    name = $(if ($Shell) { $null } else { $name }); terminal_title_stripped = $name; stubborn = [bool]$Stubborn
  }
}
function Tab($id, $label) { [ordered]@{ tab_id = $id; workspace_id = $id.Split(':')[0]; label = $label } }
# Two herdr spaces: w1 runs example's rig (this orchestrator in w1:p1, ex-pam on the seats tab w1:t2), w2 sample's (sm- lanes).
function Base {
  @{
    current = 'w1:p1'
    panes = @(
      (Pane 'w1:p1' 'w1:t1' 'claude'), (Pane 'w1:p2' 'w1:t1' 'ex-coder'), (Pane 'w1:p3' 'w1:t1' 'ex-angela'), (Pane 'w1:p4' 'w1:t1' 'ex-oscar'), (Pane 'w1:p5' 'w1:t2' 'ex-pam'),
      (Pane 'w2:p1' 'w2:t1' 'claude-2'), (Pane 'w2:p2' 'w2:t1' 'sm-coder'), (Pane 'w2:p5' 'w2:t2' 'sm-pam')
    )
    tabs = @((Tab 'w1:t1' 'example'), (Tab 'w1:t2' 'seats'), (Tab 'w2:t1' 'sample'), (Tab 'w2:t2' 'seats'))
  }
}
function P($state, $id) { $state.panes | Where-Object { $_.pane_id -eq $id } }

# One run of close.ps1 in a child powershell with the isolated PATH: its exit code, output, every herdr call and the state after.
function Invoke-Close($state, [string[]]$closeArgs, [switch]$NoHerdrEnv) {
  [IO.File]::WriteAllText($stateFile, ($state | ConvertTo-Json -Depth 5 -Compress))
  [IO.File]::WriteAllText($callsFile, '')
  $saved = @{ PATH = $env:PATH; HERDR_ENV = $env:HERDR_ENV }
  $env:PATH = $isolated
  $env:HERDR_ENV = $(if ($NoHerdrEnv) { $null } else { '1' })
  $clock = [Diagnostics.Stopwatch]::StartNew()
  try { $out = @(& $ps -NoProfile -ExecutionPolicy Bypass -File $closePs1 @closeArgs 2>&1 | ForEach-Object { "$_" }); $code = $LASTEXITCODE }
  finally { $env:PATH = $saved.PATH; $env:HERDR_ENV = $saved.HERDR_ENV }
  $calls = @([IO.File]::ReadAllLines($callsFile) | Where-Object { $_ })
  [pscustomobject]@{
    Code = $code; Out = $out -join "`n"; Seconds = $clock.Elapsed.TotalSeconds; Calls = $calls
    Changes = @($calls | Where-Object { $_ -match '^(?:agent prompt|pane close|tab close) ' }); State = [IO.File]::ReadAllText($stateFile) | ConvertFrom-Json
  }
}
# The checks every run shares: nothing outside the space, no server stop or workspace command, every read before the first change.
function Check-Common($r, $label, $otherSpace) {
  Check (-not @($r.Calls | Where-Object { $_ -match "(?:^| )${otherSpace}:" })) "$label - no call names the other space ($otherSpace)"
  Check (-not @($r.Calls | Where-Object { $_ -match '^(?:server|workspace|pane (?:run|send)|agent send)' })) "$label - no server, workspace, pane run or send command"
  $first = if ($r.Changes.Count) { [array]::IndexOf($r.Calls, $r.Changes[0]) } else { $r.Calls.Count }
  $reads = @(for ($i = 0; $i -lt $r.Calls.Count; $i++) { if ($r.Calls[$i] -match '^(?:pane current|agent get) ') { $i } })
  Check ($r.Calls.Count -and $r.Calls[0] -eq 'pane current --current' -and -not @($reads | Where-Object { $_ -gt $first })) "$label - pane current --current first, every agent get before the first change"
}
$exAll = @('agent prompt ex-coder /exit', 'pane close w1:p2', 'agent prompt ex-angela /exit', 'pane close w1:p3', 'agent prompt ex-oscar /exit', 'pane close w1:p4', 'agent prompt ex-pam /exit', 'pane close w1:p5', 'tab close w1:t2', 'pane close w1:p1')

New-Item -ItemType Directory $fake | Out-Null
try {
  [IO.File]::WriteAllText((Join-Path $fake 'fake-herdr.cjs'), $fakeHerdr)
  [IO.File]::WriteAllText((Join-Path $fake 'herdr.cmd'), "@`"$node`" `"%~dp0fake-herdr.cjs`" %*`r`n@exit /b %ERRORLEVEL%`r`n")
  # The temp rig: close.ps1 and the guard as they are next to this file, example's profile, and sample's: example's with its name, root,
  # prefix and lanes changed (the guard checks both before close.ps1 reads a lane).
  New-Item -ItemType Directory (Join-Path $rig 'example'), (Join-Path $rig 'sample') | Out-Null
  foreach ($f in 'close.ps1', 'guard.cjs') { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $f) -Destination $rig -ErrorAction Stop }
  $exProfile = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'example\profile.json'))
  [IO.File]::WriteAllText((Join-Path $rig 'example\profile.json'), $exProfile)
  [IO.File]::WriteAllText((Join-Path $rig 'sample\profile.json'), $exProfile.Replace('"example"', '"sample"').Replace('C:/example-project', 'C:/sample-project').Replace('"ex"', '"sm"').Replace('"ex-', '"sm-'))
  # The isolation itself: on the PATH close.ps1 gets, herdr is the fake and nothing else.
  $saved = $env:PATH
  $env:PATH = $isolated
  $found = @(Get-Command herdr -All -ErrorAction SilentlyContinue | ForEach-Object { $_.Source })
  $env:PATH = $saved
  if ($found.Count -ne 1 -or $found[0] -ne (Join-Path $fake 'herdr.cmd')) { throw "the test PATH finds herdr at '$($found -join "', '")', not only the fake; nothing was run" }
  Check $true 'the test PATH finds only the fake herdr'

  # D: the order: each lane /exit then its pane, then the seats tab, then the orchestrator's own pane last.
  $r = Invoke-Close (Base) @('example')
  Check ($r.Code -eq 0) "example, all idle: exit 0 ($($r.Code))"
  Check (($r.Changes -join ' | ') -eq ($exAll -join ' | ')) "example, all idle: lanes /exit -> pane close, seats tab, own pane last ($($r.Changes -join ' | '))"
  Check ($r.Calls[-1] -eq 'pane close w1:p1') 'example, all idle: the last call closes its own pane'
  $polled = $true
  foreach ($lane in 'ex-coder', 'ex-angela', 'ex-oscar', 'ex-pam') {
    $at = [array]::IndexOf($r.Calls, "agent prompt $lane /exit")
    if ($at -lt 0 -or $r.Calls[$at + 1] -ne 'pane list') { $polled = $false }
  }
  Check $polled 'example, all idle: each /exit is followed by a pane list (the poll) before its pane closes'
  Check ((@($r.State.panes | Where-Object { $_.workspace_id -eq 'w2' }).Count -eq 3) -and (@($r.State.tabs | Where-Object { $_.workspace_id -eq 'w2' }).Count -eq 2)) "example, all idle: sample's space keeps its 3 panes and 2 tabs"
  Check-Common $r 'example, all idle' 'w2'

  # D: a working lane stops the whole close before anything closes; -Force closes it too.
  $s = Base
  (P $s 'w1:p4').agent_status = 'working'
  $r = Invoke-Close $s @('example')
  Check ($r.Code -ne 0 -and $r.Out -match 'ex-oscar' -and $r.Out -match 'working' -and $r.Out -match 'nothing was closed') "oscar working, no -Force: refused, names oscar ($($r.Code))"
  Check ($r.Changes.Count -eq 0 -and @($r.State.panes).Count -eq 8 -and @($r.State.tabs).Count -eq 4) 'oscar working, no -Force: no prompt and no close, every pane and tab still there'
  $r = Invoke-Close $s @('example', '-Force')
  Check ($r.Code -eq 0 -and ($r.Changes -join ' | ') -eq ($exAll -join ' | ')) "oscar working, -Force: closes every lane, the seats tab and its own pane ($($r.Changes -join ' | '))"
  Check-Common $r 'oscar working, -Force' 'w2'

  # I1 (review-close): a blocked lane (waiting on an approval) is a turn in flight too: it stops the close as a working one does.
  $s = Base
  (P $s 'w1:p4').agent_status = 'blocked'
  $r = Invoke-Close $s @('example')
  Check ($r.Code -ne 0 -and $r.Out -match 'ex-oscar' -and $r.Out -match 'waiting on an approval' -and $r.Out -match 'nothing was closed') "oscar blocked, no -Force: refused, names oscar ($($r.Code))"
  Check ($r.Changes.Count -eq 0 -and @($r.State.panes).Count -eq 8 -and @($r.State.tabs).Count -eq 4) 'oscar blocked, no -Force: no prompt and no close, every pane and tab still there'

  # N5 (rereview-close): an unknown lane (herdr can't classify it, which does not prove it is done) stops the close too; -Force closes it.
  $s = Base
  (P $s 'w1:p4').agent_status = 'unknown'
  $r = Invoke-Close $s @('example')
  Check ($r.Code -ne 0 -and $r.Out -match 'ex-oscar' -and $r.Out -match 'unknown' -and $r.Out -match 'nothing was closed') "oscar unknown, no -Force: refused, names oscar ($($r.Code))"
  Check ($r.Changes.Count -eq 0 -and @($r.State.panes).Count -eq 8 -and @($r.State.tabs).Count -eq 4) 'oscar unknown, no -Force: no prompt and no close, every pane and tab still there'
  $r = Invoke-Close $s @('example', '-Force')
  Check ($r.Code -eq 0 -and ($r.Changes -join ' | ') -eq ($exAll -join ' | ')) "oscar unknown, -Force: closes every lane, the seats tab and its own pane ($($r.Changes -join ' | '))"

  # D: a lane in another space is never touched; a lane herdr does not find is skipped; under -Force a blocked lane's pane closes without
  # /exit (herdr refuses a prompt to it).
  $s = Base
  $s.panes = @($s.panes | Where-Object { $_.pane_id -notin 'w1:p2', 'w1:p3', 'w1:p5' }) + @((Pane 'w2:p3' 'w2:t1' 'ex-coder'), (Pane 'w1:p3' 'w1:t1' 'ex-angela' -Shell))
  $s.tabs = @($s.tabs | Where-Object { $_.tab_id -ne 'w1:t2' })
  (P $s 'w1:p4').agent_status = 'blocked'
  $r = Invoke-Close $s @('example', '-Force')
  Check ($r.Code -eq 0) "example -Force, ex-coder in w2, ex-angela a shell, ex-oscar blocked, no ex-pam: exit 0 ($($r.Code))"
  Check (($r.Changes -join ' | ') -eq 'agent prompt ex-oscar /exit | pane close w1:p4 | pane close w1:p1') "only ex-oscar's pane and its own close, no tab ($($r.Changes -join ' | '))"
  Check ($r.Out -match 'ex-coder runs in another herdr space \(w2\)' -and $r.Out -match 'ex-angela is not running' -and $r.Out -match 'ex-pam is not running') 'ex-coder named as in another space, ex-angela and ex-pam as not running'
  Check ($r.Out -match 'ex-oscar did not take /exit') 'the blocked ex-oscar: its /exit refused, its pane closed anyway'
  Check ($null -ne (P $r.State 'w2:p3') -and $null -ne (P $r.State 'w1:p3')) "example's ex-coder in w2 and ex-angela's shell pane are still there"
  Check-Common $r 'skips' 'w2'

  # C1 (review-close): the seats tab closes only when every pane still in it was one of this run's lanes. A shell pane Jas opened there
  # keeps the tab open and is not touched; so does a pam that herdr does not find by its name while its pane works.
  $s = Base
  $s.panes = @($s.panes) + @((Pane 'w1:p6' 'w1:t2' 'pwsh' -Shell))
  $r = Invoke-Close $s @('example')
  $want = @($exAll | Where-Object { $_ -ne 'tab close w1:t2' })
  Check ($r.Code -eq 0 -and ($r.Changes -join ' | ') -eq ($want -join ' | ')) "a shell pane in the seats tab: every lane and its own pane close, no tab close ($($r.Changes -join ' | '))"
  Check ($r.Out -match 'seats tab \(w1:t2\) stays' -and $r.Out -match 'w1:p6' -and $null -ne (P $r.State 'w1:p6') -and @($r.State.tabs | Where-Object { $_.tab_id -eq 'w1:t2' }).Count -eq 1) 'a shell pane in the seats tab: said so, and the pane and the tab are still there'
  Check-Common $r 'a shell pane in the seats tab' 'w2'
  $s = Base
  (P $s 'w1:p5').name = $null
  (P $s 'w1:p5').agent_status = 'working'
  $r = Invoke-Close $s @('example')
  $want = @($exAll | Where-Object { $_ -notmatch 'pam|w1:p5|w1:t2' })
  Check ($r.Code -eq 0 -and ($r.Changes -join ' | ') -eq ($want -join ' | ')) "pam not found by name while its pane works: the other lanes and its own pane close, no tab close ($($r.Changes -join ' | '))"
  Check ($r.Out -match 'ex-pam is not running' -and $r.Out -match 'seats tab \(w1:t2\) stays' -and (P $r.State 'w1:p5').agent_status -eq 'working' -and @($r.State.tabs | Where-Object { $_.tab_id -eq 'w1:t2' }).Count -eq 1) "pam not found by name while its pane works: said so, and pam's pane and the tab are still there"
  Check-Common $r 'pam not found by name' 'w2'
  # A pane list that can't be read keeps the seats tab too (here no lane runs and the tab is empty, so it would close otherwise).
  $s = Base
  $s.panes = @($s.panes | Where-Object { $_.pane_id -notin 'w1:p2', 'w1:p3', 'w1:p4', 'w1:p5' })
  $s.canned = @{ 'pane list' = 'oops' }
  $r = Invoke-Close $s @('example')
  Check ($r.Code -eq 0 -and ($r.Changes -join ' | ') -eq 'pane close w1:p1' -and $r.Out -match 'pane list gave no panes: the seats tab \(w1:t2\) stays') "pane list answers oops after the lanes: the seats tab stays, its own pane closes ($($r.Changes -join ' | '))"

  # M1 (review-close): only herdr's agent_not_found means "not running"; any other failed agent get stops the close before anything closes.
  $s = Base
  $s.canned = @{ 'agent get ex-angela' = 'server_busy' }
  $r = Invoke-Close $s @('example')
  Check ($r.Code -ne 0 -and $r.Changes.Count -eq 0 -and $r.Out -match 'ex-angela' -and $r.Out -match 'server_busy' -and $r.Out -match 'nothing was closed') "agent get ex-angela fails (server_busy, not agent_not_found): refused, nothing closed ($($r.Code))"

  # M2 (review-close): run from a lane's own pane (Jas's ! in ex-oscar), that lane is not closed mid-loop: its pane is this pane, closed last.
  $s = Base
  $s.current = 'w1:p4'
  $r = Invoke-Close $s @('example')
  Check ($r.Code -eq 0 -and ($r.Changes -join ' | ') -eq 'agent prompt ex-coder /exit | pane close w1:p2 | agent prompt ex-angela /exit | pane close w1:p3 | agent prompt ex-pam /exit | pane close w1:p5 | tab close w1:t2 | pane close w1:p4') "run from ex-oscar's pane: no /exit to ex-oscar, its pane closes last ($($r.Changes -join ' | '))"
  Check ($r.Out -match 'ex-oscar runs in this pane \(w1:p4\)' -and $null -ne (P $r.State 'w1:p1')) "run from ex-oscar's pane: said so; the orchestrator's pane (not a lane) is untouched"
  Check-Common $r "run from ex-oscar's pane" 'w2'

  # Projects stay apart: sample's orchestrator in w2 closes only sm- lanes in w2.
  $s = Base
  $s.current = 'w2:p1'
  $r = Invoke-Close $s @('sample')
  Check ($r.Code -eq 0 -and ($r.Changes -join ' | ') -eq 'agent prompt sm-coder /exit | pane close w2:p2 | agent prompt sm-pam /exit | pane close w2:p5 | tab close w2:t2 | pane close w2:p1') "sample from w2: sm-coder, sm-pam, its seats tab, its own pane ($($r.Changes -join ' | '))"
  Check ($r.Out -match 'sm-angela is not running' -and @($r.State.panes | Where-Object { $_.workspace_id -eq 'w1' }).Count -eq 5) "sample from w2: sm-angela skipped, example's 5 panes untouched"
  Check-Common $r 'sample' 'w1'

  # D: the poll timeout: a lane that does not exit within 30 s has its pane closed anyway, and the close goes on.
  $s = Base
  (P $s 'w1:p4').stubborn = $true
  $r = Invoke-Close $s @('example')
  Check ($r.Code -eq 0 -and ($r.Changes -join ' | ') -eq ($exAll -join ' | ')) "oscar does not exit: the close still runs in order ($($r.Changes -join ' | '))"
  Check ($r.Out -match 'ex-oscar did not exit within 30 s; closing its pane anyway' -and $r.Seconds -ge 30) "ex-oscar does not exit: said so, after 30 s ($([int]$r.Seconds) s)"

  # D: an invalid project or no HERDR_ENV refuses before any herdr call; so does a pane herdr can't name.
  foreach ($bad in 'nope', 'Example', '..\example') {
    $r = Invoke-Close (Base) @($bad)
    Check ($r.Code -ne 0 -and $r.Calls.Count -eq 0 -and $r.Out -match 'Nothing was closed') "project '$bad': refused before any herdr call ($($r.Code), $($r.Calls.Count) calls)"
  }
  $r = Invoke-Close (Base) @('example') -NoHerdrEnv
  Check ($r.Code -ne 0 -and $r.Calls.Count -eq 0 -and $r.Out -match 'HERDR_ENV') "no HERDR_ENV: refused before any herdr call ($($r.Code), $($r.Calls.Count) calls)"
  $s = Base
  $s.current = 'w9:p9'
  $r = Invoke-Close $s @('example')
  Check ($r.Code -ne 0 -and $r.Changes.Count -eq 0 -and $r.Out -match 'nothing was closed') "its own pane not found (pane current fails): refused, nothing closed ($($r.Code))"

  # M6 (review-close): an answer that is not JSON in the check phase refuses with nothing closed; a lane's pane that won't close is passed
  # over; its own pane that won't close throws with herdr's answer. (The throw's text is matched without its spaces: PowerShell may wrap it.)
  foreach ($cmd in 'pane current --current', 'agent get ex-oscar') {
    $s = Base
    $s.canned = @{ $cmd = 'oops' }
    $r = Invoke-Close $s @('example')
    Check ($r.Code -ne 0 -and $r.Changes.Count -eq 0 -and $r.Out -match 'nothing was closed') "$cmd answers oops (not JSON): refused, nothing closed ($($r.Code))"
  }
  $s = Base
  $s.canned = @{ 'pane close w1:p3' = 'pane_busy' }
  $r = Invoke-Close $s @('example')
  Check ($r.Code -eq 0 -and ($r.Changes -join ' | ') -eq ($exAll -join ' | ') -and $r.Out -match "ex-angela's pane did not close \(.*pane_busy.*\); going on") "ex-angela's pane does not close: said so, and the close goes on ($($r.Code), $($r.Changes -join ' | '))"
  $s = Base
  $s.canned = @{ 'pane close w1:p1' = 'pane_busy' }
  $r = Invoke-Close $s @('example')
  $flat = $r.Out -replace '\s', ''
  Check ($r.Code -ne 0 -and ($r.Changes -join ' | ') -eq ($exAll -join ' | ') -and $flat -match 'thispanedidnotclose:herdrpaneclosew1:p1\(exit1\).*pane_busy.*Closeitbyhand') "its own pane does not close: throws with herdr's answer ($($r.Code))"
} catch {
  # A terminating error must not let the run fall through to "all checks passed": count it and report it.
  "FAIL self-test aborted: $($_.Exception.Message)"
  $script:fails++
} finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force   # a plain temp folder: no links inside
}
if ($script:fails) { "$($script:fails) check(s) failed"; exit 1 }
'close selftest: all checks passed'
