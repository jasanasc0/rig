# launch.selftest.ps1 - checks launch.ps1 (README, Daily use) against the rig's fake herdr (fake-herdr.cjs) and a fake
# Windows Terminal in %TEMP%. The real herdr and wt are never called: your live rigs share herdr's server. Each run is a copy of launch.ps1
# (its rig is the folder above its bin: a temp rig folder named rig with two projects, alpha and beta, whose roots are temp folders with a blank
# in their names) in a child powershell with a PATH of only the fakes, node and Windows; before every run the test checks that this PATH
# finds herdr and wt only as the fakes, and runs nothing if not. The fake wt logs its arguments and, when herdr's server is down, "starts"
# it with one default space named after its -d folder, as herdr does when a window attaches (unless state.json says wtDead).
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File <rig>\test\launch.selftest.ps1
$launchPs1 = Join-Path $PSScriptRoot '..\bin\launch.ps1'
$ps = Join-Path $PSHOME 'powershell.exe'
$node = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$tmp = Join-Path $env:TEMP ('rig-launch-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$fake = Join-Path $tmp 'bin'
$rig = Join-Path $tmp 'rig'
$stateFile = Join-Path $fake 'state.json'
$callsFile = Join-Path $fake 'calls.log'
$wtFile = Join-Path $fake 'wt.log'
$isolated = "$fake;$(Split-Path -Parent $node);$env:SystemRoot\System32;$env:SystemRoot"
$roots = @{ alpha = Join-Path $tmp 'root alpha'; beta = Join-Path $tmp 'root beta' }
$script:fails = 0
function Check($ok, $label) { if ($ok) { "ok   $label" } else { "FAIL $label"; $script:fails++ } }

$fakeWt = @'
'use strict';
// Fake Windows Terminal for launch.selftest.ps1: logs its arguments (joined by tabs) to wt.log; when herdr's server is down (state.json
// down) and wtDead is not set, it brings the server up with one default space, labelled after the -d folder, holding one shell pane.
const fs = require('fs');
const path = require('path');
const a = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'wt.log'), a.join('\t') + '\n');
const file = path.join(__dirname, 'state.json');
const s = JSON.parse(fs.readFileSync(file, 'utf8'));
if (s.down && !s.wtDead) {
  const dir = a[a.indexOf('-d') + 1];
  const ws = 'w' + (Math.max(0, ...[...s.panes, ...s.tabs].map((x) => Number(x.workspace_id.slice(1)) || 0)) + 1);
  s.down = false;
  s.tabs.push({ tab_id: ws + ':t1', workspace_id: ws, label: '1' });
  s.panes.push({ pane_id: ws + ':p1', tab_id: ws + ':t1', workspace_id: ws, cwd: dir });
  s.names = { ...s.names, [ws]: path.basename(dir) };
  fs.writeFileSync(file, JSON.stringify(s));
}
'@

function Pane($id, $extra = @{}) { $p = [ordered]@{ pane_id = $id; tab_id = $id.Split(':')[0] + ':t1'; workspace_id = $id.Split(':')[0] }; foreach ($k in $extra.Keys) { $p[$k] = $extra[$k] }; $p }
function Tab($id, $label = '1') { [ordered]@{ tab_id = $id; workspace_id = $id.Split(':')[0]; label = $label } }
function Call { $args -join "`t" }
function Show($calls) { @($calls | ForEach-Object { $_ -replace "`t", ' ' }) -join ' | ' }
$typedAlpha = "& '$rig\bin\rig.ps1' alpha"
$typedBeta = "& '$rig\bin\rig.ps1' beta"
$typedView = "node '$rig\bin\rigview.mjs'"

# One run of the copied launch.ps1 in a child powershell with the isolated PATH: exit code, output, herdr calls, wt calls, state after.
function Invoke-Launch($state) {
  [IO.File]::WriteAllText($stateFile, ($state | ConvertTo-Json -Depth 6 -Compress))
  [IO.File]::WriteAllText($callsFile, '')
  [IO.File]::WriteAllText($wtFile, '')
  $saved = $env:PATH
  $env:PATH = $isolated
  try {
    foreach ($name in 'herdr', 'wt') {
      $found = @(Get-Command $name -All -ErrorAction SilentlyContinue | ForEach-Object { $_.Source })
      if ($found.Count -ne 1 -or $found[0] -ne (Join-Path $fake "$name.cmd")) { throw "the test PATH finds $name at '$($found -join "', '")', not only the fake; nothing was run" }
    }
    $out = @(& $ps -NoProfile -ExecutionPolicy Bypass -File (Join-Path $rig 'bin\launch.ps1') -NoWait 2>&1 | ForEach-Object { "$_" })
    $code = $LASTEXITCODE
  } finally { $env:PATH = $saved }
  $st = [IO.File]::ReadAllText($stateFile) | ConvertFrom-Json
  [pscustomobject]@{
    Code = $code; Out = ($out -join "`n"); Warnings = @($out | Where-Object { $_ -match '^WARNING:' -or $_ -match 'needs a look' }).Count
    Calls = @([IO.File]::ReadAllLines($callsFile) | Where-Object { $_ })
    Wt = @([IO.File]::ReadAllLines($wtFile) | Where-Object { $_ })
    State = $st
    Ran = @{} + (& { $h = @{}; foreach ($p in @($st.panes)) { if ($p.ran) { $h[$p.pane_id] = @($p.ran) -join ' / ' } }; $h })
  }
}
# Nothing that closes, stops or kills: launch.ps1 only adds.
function Check-OnlyAdds($r, $label) {
  Check (-not @($r.Calls | Where-Object { $_ -match '^(pane close|tab close|workspace close|server stop|agent prompt|agent start|pane split|pane send)' })) "$label - no call closes, stops, prompts or splits ($(Show $r.Calls))"
}

New-Item -ItemType Directory $fake | Out-Null
try {
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'fake-herdr.cjs') -Destination $fake # the rig's one fake herdr
  [IO.File]::WriteAllText((Join-Path $fake 'fake-wt.cjs'), $fakeWt)
  foreach ($name in 'herdr', 'wt') { [IO.File]::WriteAllText((Join-Path $fake "$name.cmd"), "@`"$node`" `"%~dp0fake-$name.cjs`" %*`r`n@exit /b %ERRORLEVEL%`r`n") }
  # The test rig: launch.ps1 and herdr.ps1 in its bin, two projects and a folder that is no project.
  New-Item -ItemType Directory (Join-Path $rig 'bin'), (Join-Path $rig 'notes') | Out-Null
  Copy-Item -LiteralPath $launchPs1 -Destination (Join-Path $rig 'bin')
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\bin\herdr.ps1') -Destination (Join-Path $rig 'bin')
  foreach ($project in 'alpha', 'beta') {
    New-Item -ItemType Directory (Join-Path $rig $project), $roots[$project] | Out-Null
    $lane = if ($project -eq 'alpha') { 'orchestrator' } else { 'b-orchestrator' }
    $profile = [ordered]@{ name = $project; root = ($roots[$project] -replace '\\', '/') + '/'; lanes = [ordered]@{ orchestrator = $lane } }
    [IO.File]::WriteAllText((Join-Path $rig "$project\profile.json"), ($profile | ConvertTo-Json -Depth 4))
  }
  $newWindow = Call -w new -d $rig herdr

  # 1. A fresh start: no server. The window starts it; alpha takes the default space, beta and the view get spaces of their own.
  $r = Invoke-Launch @{ down = $true; panes = @(); tabs = @() }
  Check ($r.Code -eq 0 -and $r.Warnings -eq 0) "fresh: exit 0, no warning ($($r.Out -replace "`n", ' | '))"
  Check ($r.Wt.Count -eq 1 -and $r.Wt[0] -ceq $newWindow) "fresh: one window, with herdr, named after the rig folder ($(Show $r.Wt))"
  Check ($r.Ran['w1:p1'] -ceq $typedAlpha) "fresh: rig.ps1 alpha typed into herdr's default space w1 ($($r.Ran['w1:p1']))"
  Check ($r.Calls -contains (Call workspace create --cwd $roots.beta --label beta --no-focus)) "fresh: beta's space made in beta's root, without the trailing slash ($(Show $r.Calls))"
  Check ($r.Ran['w2:p1'] -ceq $typedBeta) "fresh: rig.ps1 beta typed into its new space w2 ($($r.Ran['w2:p1']))"
  Check ($r.Calls -contains (Call workspace create --cwd $rig --label view --no-focus) -and $r.Ran['w3:p1'] -ceq $typedView) "fresh: the view started in a new space labelled view ($($r.Ran['w3:p1']))"
  Check ($r.State.focused -ceq 'w3') "fresh: the view space has focus ($($r.State.focused))"
  Check-OnlyAdds $r 'fresh'

  # 2. Everything already runs: the nameless alpha orchestrator (by its title), beta's by name, the view by its foreground (rigview.mjs).
  # Nothing is typed or made; your own default space (Desktop) is never touched; the view space gets focus and a window opens.
  $up = @{ panes = @(
      (Pane 'w1:p1' @{ agent = 'claude'; terminal_title_stripped = 'orchestrator' }),
      (Pane 'w2:p1' @{ agent = 'claude'; name = 'b-orchestrator' }),
      (Pane 'w3:p1' @{ fg = @("C:\Program Files\nodejs\node.exe C:\work\rig\bin\rigview.mjs") }),
      (Pane 'w4:p1')); tabs = @((Tab 'w1:t1'), (Tab 'w2:t1'), (Tab 'w3:t1'), (Tab 'w4:t1')); names = @{ w1 = 'alpha'; w2 = 'beta'; w3 = 'view'; w4 = 'Desktop' } }
  $r = Invoke-Launch $up
  Check ($r.Code -eq 0 -and $r.Warnings -eq 0) "running: exit 0, no warning ($($r.Out -replace "`n", ' | '))"
  Check ($r.Ran.Count -eq 0 -and -not @($r.Calls | Where-Object { $_ -match '^workspace create' })) "running: nothing typed, no space made ($(Show $r.Calls))"
  Check ($r.Out -match 'alpha: its orchestrator runs \(in w1:p1\), left alone' -and $r.Out -match 'beta: its orchestrator runs \(in w2:p1\)' -and $r.Out -match 'view: runs \(in w3:p1\)') 'running: one line each says it runs and is left alone'
  Check ($r.State.focused -ceq 'w3' -and $r.Wt.Count -eq 1 -and $r.Wt[0] -ceq $newWindow) "running: view focused, one window opened ($(Show $r.Wt))"
  Check-OnlyAdds $r 'running'

  # 3. Server up, no rig: a leftover space labelled alpha with one free pane is used; your own Desktop space (one free pane) is not a spare
  # (this run did not start the server); beta and the view get new spaces.
  $r = Invoke-Launch @{ panes = @((Pane 'w1:p1'), (Pane 'w2:p1')); tabs = @((Tab 'w1:t1'), (Tab 'w2:t1')); names = @{ w1 = 'Desktop'; w2 = 'alpha' } }
  Check ($r.Code -eq 0 -and $r.Ran['w2:p1'] -ceq $typedAlpha) "leftover: rig.ps1 alpha typed into the space labelled alpha ($($r.Ran['w2:p1']))"
  Check (-not $r.Ran.ContainsKey('w1:p1')) "leftover: your own Desktop space is never typed into ($($r.Ran['w1:p1']))"
  Check ($r.Ran['w3:p1'] -ceq $typedBeta -and $r.Ran['w4:p1'] -ceq $typedView) "leftover: beta and the view get new spaces w3, w4 ($(Show $r.Calls))"

  # 4. A space labelled beta that holds two panes and no beta orchestrator: not touched, a warning, exit 1; alpha and the view still start.
  $r = Invoke-Launch @{ panes = @((Pane 'w1:p1'), (Pane 'w1:p2')); tabs = @((Tab 'w1:t1')); names = @{ w1 = 'beta' } }
  Check ($r.Code -eq 1 -and $r.Warnings -ge 1 -and $r.Out -match 'beta: 1 space\(s\) labelled beta \(w1\), the first with 2 pane\(s\)') "busy space: beta not touched, warned, exit 1 ($($r.Out -replace "`n", ' | '))"
  Check (-not $r.Ran.ContainsKey('w1:p1') -and -not $r.Ran.ContainsKey('w1:p2') -and $r.Ran['w2:p1'] -ceq $typedAlpha -and $r.Ran['w3:p1'] -ceq $typedView) "busy space: alpha and the view still start ($(Show $r.Calls))"

  # 5. The view space is there but the view was quit (its one pane is a free shell): the view is typed there, no new space.
  $r = Invoke-Launch @{ panes = @(
      (Pane 'w1:p1' @{ agent = 'claude'; terminal_title_stripped = 'orchestrator' }), (Pane 'w2:p1' @{ agent = 'claude'; name = 'b-orchestrator' }), (Pane 'w3:p1'))
    tabs = @((Tab 'w1:t1'), (Tab 'w2:t1'), (Tab 'w3:t1')); names = @{ w1 = 'alpha'; w2 = 'beta'; w3 = 'view' } }
  Check ($r.Code -eq 0 -and $r.Ran['w3:p1'] -ceq $typedView -and -not @($r.Calls | Where-Object { $_ -match '^workspace create' })) "view quit: typed into the view space's own pane, no new space ($(Show $r.Calls))"

  # 6. herdr refuses beta's space: a warning names it, beta is not started, the view still is; exit 1.
  $r = Invoke-Launch @{ panes = @((Pane 'w1:p1' @{ agent = 'claude'; terminal_title_stripped = 'orchestrator' })); tabs = @((Tab 'w1:t1')); names = @{ w1 = 'alpha' }
    canned = @{ ("workspace create --cwd $($roots.beta) --label beta --no-focus") = 'workspace_create_failed' } }
  Check ($r.Code -eq 1 -and $r.Out -match 'beta: herdr workspace create gave no space or pane' -and $r.Ran.Count -eq 1 -and $r.Ran['w2:p1'] -ceq $typedView) "create fails: beta warned and skipped, the view started ($($r.Out -replace "`n", ' | '))"

  # 6b. herdr does not take beta's command, nor the focus: two warnings, the view still typed; exit 1.
  $r = Invoke-Launch @{ panes = @((Pane 'w1:p1' @{ agent = 'claude'; terminal_title_stripped = 'orchestrator' })); tabs = @((Tab 'w1:t1')); names = @{ w1 = 'alpha' }
    canned = @{ "pane run w2:p1 $typedBeta" = 'pane_run_failed'; 'workspace focus w3' = 'workspace_focus_failed' } }
  Check ($r.Code -eq 1 -and $r.Out -match 'beta: herdr pane run did not take' -and $r.Out -match 'herdr workspace focus did not focus w3' -and $r.Ran['w3:p1'] -ceq $typedView) "run and focus fail: both warned, the view still typed ($($r.Out -replace "`n", ' | '))"

  # 8. A space labelled alpha whose one pane runs something (no agent, but not at its shell): not typed into, warned (review, Important 2).
  $r = Invoke-Launch @{ panes = @((Pane 'w1:p1' @{ fg = @('C:\Program Files\nodejs\node.exe C:\work\server.js') })); tabs = @((Tab 'w1:t1')); names = @{ w1 = 'alpha' } }
  Check ($r.Code -eq 1 -and -not $r.Ran.ContainsKey('w1:p1') -and $r.Out -match 'alpha: 1 space\(s\) labelled alpha \(w1\), the first with 1 pane\(s\), not one free pane') "busy pane: a pane running a program is not typed into ($($r.Out -replace "`n", ' | '))"

  # 9. herdr answers something other than server_not_running: your server may be up, so nothing starts and no window opens (Important 3).
  $r = Invoke-Launch @{ panes = @((Pane 'w1:p1')); tabs = @((Tab 'w1:t1')); names = @{ w1 = 'rig' }; canned = @{ 'api snapshot' = 'protocol_mismatch' } }
  Check ($r.Code -eq 1 -and $r.Out -match 'herdr did not give its state' -and $r.Wt.Count -eq 0 -and $r.Calls.Count -eq 1) "other error: warned, no window, only the one snapshot asked ($(Show $r.Calls))"

  # 10. Server up with a space labelled rig (the rig folder's name) that this run did not make: not a spare, never typed into.
  $r = Invoke-Launch @{ panes = @((Pane 'w1:p1')); tabs = @((Tab 'w1:t1')); names = @{ w1 = 'rig' } }
  Check ($r.Code -eq 0 -and -not $r.Ran.ContainsKey('w1:p1') -and $r.Ran['w2:p1'] -ceq $typedAlpha) "server up: an old rig-labelled space is not a spare ($(Show $r.Calls))"

  # 11. Another launch holds the lock (a second double-click): this one warns and calls nothing (review, Critical 1).
  $held = New-Object Threading.Mutex($false, 'Local\rig-launch')
  if (-not $held.WaitOne(0)) { throw 'the test could not take the launch lock (a real launch.ps1 running?); nothing was run' }
  try { $r = Invoke-Launch @{ panes = @(); tabs = @() } } finally { $held.ReleaseMutex() }
  Check ($r.Code -eq 1 -and $r.Out -match 'another launch.ps1 is already running' -and $r.Calls.Count -eq 0 -and $r.Wt.Count -eq 0) "locked: a second launch warns and calls nothing ($(Show $r.Calls))"

  # 12. herdr can't describe a pane (process-info fails): it is not free, so neither alpha's space nor the view space is typed into.
  $r = Invoke-Launch @{ panes = @((Pane 'w1:p1'), (Pane 'w2:p1' @{ agent = 'claude'; name = 'b-orchestrator' }), (Pane 'w3:p1')); tabs = @((Tab 'w1:t1'), (Tab 'w2:t1'), (Tab 'w3:t1'))
    names = @{ w1 = 'alpha'; w2 = 'beta'; w3 = 'view' }; canned = @{ 'pane process-info --pane w1:p1' = 'pane_not_found'; 'pane process-info --pane w3:p1' = 'pane_not_found' } }
  Check ($r.Code -eq 1 -and $r.Ran.Count -eq 0 -and $r.Out -match 'alpha: 1 space\(s\) labelled alpha' -and $r.Out -match 'view: 1 space\(s\) labelled view') "unreadable pane: not free, nothing typed, both warned ($(Show $r.Calls))"

  # 7. The server never comes up (the window's herdr dies): after 30 s a warning, nothing made or typed, exit 1.
  $r = Invoke-Launch @{ down = $true; wtDead = $true; panes = @(); tabs = @() }
  Check ($r.Code -eq 1 -and $r.Out -match 'did not answer within 30 s' -and $r.Ran.Count -eq 0 -and -not @($r.Calls | Where-Object { $_ -notmatch '^api\tsnapshot$' })) "no server: warned after 30 s, only snapshots asked ($($r.Calls.Count) calls)"
  Check ($r.Wt.Count -eq 1) "no server: one window tried, none after ($(Show $r.Wt))"
} finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
if ($script:fails) { "launch.selftest: $($script:fails) FAILED"; exit 1 }
'launch.selftest: all checks passed'
