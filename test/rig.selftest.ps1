# rig.selftest.ps1 - checks rig.ps1's herdr steps (the rig README, Daily use) against a fake herdr and a fake claude in %TEMP%. The real
# herdr and claude are never called: live rigs share herdr's server, and a real claude would start a session.
# Each run is a copy of rig.ps1 in a temp rig folder (with herdr.ps1, a stub guard and two projects: example, from the profile next to this
# file, and sample, made from it with projectSettings true so both claude lines run; each root is a temp folder with a blank in its name),
# in a child powershell with a PATH of only the fakes, node and Windows. Before every run the test checks that this PATH finds herdr and
# claude only as the fakes, and runs nothing if not; the stub guard, which rig.ps1 asks before any herdr call or claude, refuses unless the
# child's PATH is that one. The fake herdr is the rig's fake-herdr.cjs, shared by every self-test.
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File <rig>\test\rig.selftest.ps1
$rigPs1 = Join-Path $PSScriptRoot '..\bin\rig.ps1'
$ps = Join-Path $PSHOME 'powershell.exe'
$node = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$tmp = Join-Path $env:TEMP ('rig-seats-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$fake = Join-Path $tmp 'bin'
$rig = Join-Path $tmp 'rig'
$stateFile = Join-Path $fake 'state.json'
$callsFile = Join-Path $fake 'calls.log'
$claudeFile = Join-Path $fake 'claude.json'
$isolated = "$fake;$(Split-Path -Parent $node);$env:SystemRoot\System32;$env:SystemRoot"
$roots = @{ example = Join-Path $tmp 'root example'; sample = Join-Path $tmp 'root sample' }
$script:fails = 0
function Check($ok, $label) { if ($ok) { "ok   $label" } else { "FAIL $label"; $script:fails++ } }

$fakeClaude = @'
'use strict';
// Fake claude for rig.selftest.ps1: records its arguments and its folder in claude.json next to it, and starts nothing.
const fs = require('fs');
const path = require('path');
fs.writeFileSync(path.join(__dirname, 'claude.json'), JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
'@
# rig.ps1 asks the guard about the profile before any herdr call or claude; this one says yes only on the test's isolated PATH.
$stubGuard = @"
'use strict';
require('fs').readFileSync(0);
process.exitCode = process.env.PATH === $($isolated | ConvertTo-Json) ? 0 : 1;
if (process.exitCode) process.stderr.write('stub guard: this is not the test PATH; nothing runs\n');
"@

# The claude arguments, per project (rig.ps1's two claude lines with the test rig as `$rig`): example's profile has projectSettings false,
# sample's true.
$want = @{
  example = @('--dangerously-skip-permissions', '--model', 'opus', '--effort', 'high', '-n', 'ex-orchestrator', '--setting-sources', 'user,local', '--mcp-config', "$rig\example\rules\mcp.json", '--settings', "$rig\example\rules\orchestrator.settings.json", '--append-system-prompt-file', "$rig\example\rules\orchestrator.md")
  sample = @('--dangerously-skip-permissions', '--model', 'opus', '--effort', 'high', '-n', 'sm-orchestrator', '--settings', "$rig\sample\rules\orchestrator.settings.json", '--append-system-prompt-file', "$rig\sample\rules\orchestrator.md")
}
function Pane($id, $tab) { [ordered]@{ pane_id = $id; tab_id = $tab; workspace_id = $id.Split(':')[0] } }
function Tab($id, $label) { [ordered]@{ tab_id = $id; workspace_id = $id.Split(':')[0]; label = $label } }
# Two herdr spaces: w1, where this rig.ps1 runs (in pane w1:p1), and w2, another project's rig; no seats tab yet.
function Base { @{ current = 'w1:p1'; panes = @((Pane 'w1:p1' 'w1:t1'), (Pane 'w2:p1' 'w2:t1')); tabs = @((Tab 'w1:t1' '1'), (Tab 'w2:t1' '1')) } }
# A herdr call as calls.log writes it (words joined by tabs), and shown with blanks.
function Call { $args -join "`t" }
function Show($calls) { @($calls | ForEach-Object { $_ -replace "`t", ' ' }) -join ' | ' }

# One run of the copied rig.ps1 in a child powershell with the isolated PATH: its exit code, output, every herdr call, what claude got and
# the state after.
function Invoke-Rig($state, $project, [switch]$NoHerdrEnv) {
  [IO.File]::WriteAllText($stateFile, ($state | ConvertTo-Json -Depth 5 -Compress))
  [IO.File]::WriteAllText($callsFile, '')
  if (Test-Path -LiteralPath $claudeFile) { Remove-Item -LiteralPath $claudeFile }
  $saved = @{ PATH = $env:PATH; HERDR_ENV = $env:HERDR_ENV }
  $env:PATH = $isolated
  try {
    # The isolation, before every run: on this PATH, herdr and claude are the fakes and nothing else.
    foreach ($name in 'herdr', 'claude') {
      $found = @(Get-Command $name -All -ErrorAction SilentlyContinue | ForEach-Object { $_.Source })
      if ($found.Count -ne 1 -or $found[0] -ne (Join-Path $fake "$name.cmd")) { throw "the test PATH finds $name at '$($found -join "', '")', not only the fake; nothing was run" }
    }
    $env:HERDR_ENV = $(if ($NoHerdrEnv) { $null } else { '1' })
    $out = @(& $ps -NoProfile -ExecutionPolicy Bypass -File (Join-Path $rig 'bin\rig.ps1') $project 2>&1 | ForEach-Object { "$_" })
    $code = $LASTEXITCODE
  } finally { $env:PATH = $saved.PATH; $env:HERDR_ENV = $saved.HERDR_ENV }
  $text = $out -join "`n"
  [pscustomobject]@{
    Code = $code; Out = $text; Flat = $text -replace '\s', ''; Warnings = ([regex]::Matches($text, 'WARNING:')).Count
    Calls = @([IO.File]::ReadAllLines($callsFile) | Where-Object { $_ })
    Claude = $(if (Test-Path -LiteralPath $claudeFile) { [IO.File]::ReadAllText($claudeFile) | ConvertFrom-Json } else { $null })
    State = [IO.File]::ReadAllText($stateFile) | ConvertFrom-Json
  }
}
# claude started once, in the project's root, with exactly its arguments, and rig.ps1 exited 0.
function Check-Claude($r, $project, $label) {
  $got = if ($r.Claude) { @($r.Claude.args) -join ' ' } else { 'not started' }
  Check ($r.Code -eq 0 -and $null -ne $r.Claude -and (@($r.Claude.args) -join "`t") -ceq ($want[$project] -join "`t") -and $r.Claude.cwd -eq $roots[$project]) "$label - exit 0, claude started in the root with its arguments ($got)"
}
# No call names another space than this one.
function Check-Space($r, $label, $otherSpace) {
  Check (-not @($r.Calls | Where-Object { @($_ -split "`t") | Where-Object { $_ -ceq $otherSpace -or $_.StartsWith("${otherSpace}:") } })) "$label - no call names the other space ($otherSpace)"
}

New-Item -ItemType Directory $fake | Out-Null
try {
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'fake-herdr.cjs') -Destination $fake # the rig's one fake herdr
  [IO.File]::WriteAllText((Join-Path $fake 'fake-claude.cjs'), $fakeClaude)
  foreach ($name in 'herdr', 'claude') { [IO.File]::WriteAllText((Join-Path $fake "$name.cmd"), "@`"$node`" `"%~dp0fake-$name.cjs`" %*`r`n@exit /b %ERRORLEVEL%`r`n") }
  # The test rig: rig.ps1 as it is (it finds its rig above its own folder, so the copy in bin\ runs on this folder), herdr.ps1, the stub guard, and
  # each project's profile (root: a temp folder) and the two orchestrator files rig.ps1 checks for.
  $text = [IO.File]::ReadAllText($rigPs1)
  if ([regex]::Matches($text, '(?m)^\$rig = Split-Path -Parent \$PSScriptRoot\r?$').Count -ne 1) { throw 'rig.ps1 has no single line $rig = Split-Path -Parent $PSScriptRoot, so its copy would not run on the test rig; nothing was run' }
  New-Item -ItemType Directory $rig, (Join-Path $rig 'bin'), (Join-Path $rig 'hooks') | Out-Null
  [IO.File]::WriteAllText((Join-Path $rig 'bin\rig.ps1'), $text)
  [IO.File]::WriteAllText((Join-Path $rig 'hooks\guard.cjs'), $stubGuard)
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\bin\herdr.ps1') -Destination (Join-Path $rig 'bin') # rig.ps1 dot-sources Invoke-Herdr from its rig folder
  foreach ($project in 'example', 'sample') {
    New-Item -ItemType Directory (Join-Path $rig "$project\rules"), $roots[$project] | Out-Null
    $p = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\example\profile.json') -Raw | ConvertFrom-Json
    if ($project -eq 'sample') {
      $p.name = 'sample'; $p.ticketPrefix = 'sm'; $p.projectSettings = $true
      foreach ($seat in 'orchestrator', 'coder', 'angela', 'oscar', 'pam', 'scribe') { $p.lanes.$seat = "sm-$seat" }
    }
    $p.root = $roots[$project] -replace '\\', '/'
    [IO.File]::WriteAllText((Join-Path $rig "$project\profile.json"), ($p | ConvertTo-Json -Depth 5))
    foreach ($f in 'orchestrator.settings.json', 'orchestrator.md') { [IO.File]::WriteAllText((Join-Path $rig "$project\rules\$f"), '') }
  }
  $root = $roots.example
  $create = Call tab create --workspace w1 --cwd $root --label seats --no-focus
  $steps = @((Call pane current --current), (Call workspace rename w1 example), (Call tab list))

  # (a) Inside herdr, no seats tab: the space is named after the project, the seats tab opens in it (its root as one word), then claude.
  $r = Invoke-Rig (Base) 'example'
  Check ((Show $r.Calls) -ceq (Show ($steps + $create))) "(a) no seats tab: pane current, rename w1 example, tab list, tab create in w1 ($(Show $r.Calls))"
  Check ($r.Out -match 'herdr space w1 is named example' -and $r.Out -match 'opened the seats tab of herdr space w1 \(w1:t3\)' -and $r.Warnings -eq 0) "(a) no seats tab: one line for the name and one for the tab opened, no warning"
  Check ($r.State.names.w1 -ceq 'example' -and @($r.State.tabs | Where-Object { $_.workspace_id -ceq 'w1' -and $_.label -ceq 'seats' }).Count -eq 1) '(a) no seats tab: w1 is named example and has one seats tab'
  Check-Claude $r 'example' '(a) no seats tab'
  Check-Space $r '(a) no seats tab' 'w2'

  # (b) A seats tab already in its own space: no tab create.
  $s = Base
  $s.tabs += Tab 'w1:t2' 'seats'
  $r = Invoke-Rig $s 'example'
  Check ((Show $r.Calls) -ceq (Show $steps)) "(b) its own seats tab open: no tab create ($(Show $r.Calls))"
  Check ($r.Out -match 'the seats tab of herdr space w1 is already open \(w1:t2\)' -and $r.Warnings -eq 0) '(b) its own seats tab open: said so, with its id'
  Check-Claude $r 'example' '(b) its own seats tab open'

  # (c) A seats tab only in ANOTHER space (and a tab labelled Seats in its own, which is not `seats`): its own opens.
  $s = Base
  $s.tabs += (Tab 'w2:t2' 'seats'), (Tab 'w1:t2' 'Seats')
  $r = Invoke-Rig $s 'example'
  Check ((Show $r.Calls) -ceq (Show ($steps + $create))) "(c) a seats tab only in w2: tab create in w1 ($(Show $r.Calls))"
  Check ($r.Out -match 'opened the seats tab of herdr space w1 \(w1:t5\)') '(c) a seats tab only in w2: said so, with the new id'
  Check-Claude $r 'example' '(c) a seats tab only in w2'
  Check-Space $r '(c) a seats tab only in w2' 'w2'

  # (d) pane current fails (a herdr error, an answer that is not JSON, a pane with no workspace_id): one warning, no rename, no tab call.
  # Each warning names the step and carries herdr's answer (matched without blanks: PowerShell wraps a long warning).
  foreach ($how in @{ How = 'server_busy'; Says = 'server_busy' }, @{ How = 'oops'; Says = 'oops' }, @{ How = 'no id'; Says = '"pane_id":"w1:p9"' }) {
    $s = Base
    if ($how.How -eq 'no id') { $s.current = 'w1:p9'; $s.panes += [ordered]@{ pane_id = 'w1:p9'; tab_id = 'w1:t1' } } else { $s.canned = @{ 'pane current --current' = $how.How } }
    $r = Invoke-Rig $s 'example'
    Check ((Show $r.Calls) -ceq (Show (Call pane current --current)) -and $r.Warnings -eq 1 -and $r.Flat -match ('WARNING:herdrpanecurrent--current.*' + [regex]::Escape($how.Says))) "(d) pane current fails ($($how.How)): one warning with the step and herdr's answer, no other herdr call ($(Show $r.Calls))"
    Check-Claude $r 'example' "(d) pane current fails ($($how.How))"
  }

  # (e) The rename fails: one warning with herdr's answer, and the tab steps still run.
  $s = Base
  $s.canned = @{ 'workspace rename w1 example' = 'server_busy' }
  $r = Invoke-Rig $s 'example'
  Check ((Show $r.Calls) -ceq (Show ($steps + $create)) -and $r.Warnings -eq 1 -and $r.Flat -match 'WARNING:herdrworkspacerename.*server_busy' -and $r.Out -match 'opened the seats tab') "(e) rename fails: a warning with server_busy, tab list and tab create still run ($(Show $r.Calls))"
  Check-Claude $r 'example' '(e) rename fails'

  # (f) tab list fails: one warning, no tab create.
  foreach ($how in 'server_busy', 'oops') {
    $s = Base
    $s.canned = @{ 'tab list' = $how }
    $r = Invoke-Rig $s 'example'
    Check ((Show $r.Calls) -ceq (Show $steps) -and $r.Warnings -eq 1 -and $r.Flat -match "WARNING:herdrtablist.*$how") "(f) tab list fails ($how): a warning with herdr's answer, no tab create ($(Show $r.Calls))"
    Check-Claude $r 'example' "(f) tab list fails ($how)"
  }

  # (g) tab create fails (a herdr error, or an answer without the new tab's id): one warning, claude still starts.
  foreach ($how in @{ How = 'server_busy'; Says = 'server_busy' }, @{ How = 'noid'; Says = '"type":"ok"' }) {
    $s = Base
    $s.canned = @{ ($create -replace "`t", ' ') = $how.How }
    $r = Invoke-Rig $s 'example'
    Check ((Show $r.Calls) -ceq (Show ($steps + $create)) -and $r.Warnings -eq 1 -and $r.Flat -match ('WARNING:herdrtabcreate.*' + [regex]::Escape($how.Says))) "(g) tab create fails ($($how.How)): a warning with herdr's answer ($(Show $r.Calls))"
    Check-Claude $r 'example' "(g) tab create fails ($($how.How))"
  }

  # (h) Outside herdr: no herdr call at all, the not-inside-herdr warning, claude starts.
  $r = Invoke-Rig (Base) 'example' -NoHerdrEnv
  Check ($r.Calls.Count -eq 0 -and $r.Warnings -eq 1 -and $r.Flat -match 'WARNING:Notinsideaherdrpane') "(h) no HERDR_ENV: no herdr call, one warning ($($r.Calls.Count) calls)"
  Check-Claude $r 'example' '(h) no HERDR_ENV'

  # (i) sample (projectSettings true: the other claude line) from w2 names w2 and opens its seats tab there only.
  $s = Base
  $s.current = 'w2:p1'
  $s.tabs += Tab 'w1:t2' 'seats'
  $r = Invoke-Rig $s 'sample'
  Check ((Show $r.Calls) -ceq (Show @((Call pane current --current), (Call workspace rename w2 sample), (Call tab list), (Call tab create --workspace w2 --cwd $roots.sample --label seats --no-focus)))) "(i) sample from w2 (a seats tab only in w1): rename w2 sample, tab create in w2 with its root ($(Show $r.Calls))"
  Check-Claude $r 'sample' '(i) sample'
  Check-Space $r '(i) sample' 'w1'

  # (j) A root with a blank and a trailing slash still reaches herdr as one word: Windows PowerShell 5.1 hands 'C:\x\my root\' to a native
  # program as `C:\x\my root" --label ...`, so rig.ps1 passes the root without its trailing backslash.
  $profileFile = Join-Path $rig 'example\profile.json'
  $profileText = [IO.File]::ReadAllText($profileFile)
  $p = $profileText | ConvertFrom-Json
  $p.root = ($roots.example -replace '\\', '/') + '/'
  [IO.File]::WriteAllText($profileFile, ($p | ConvertTo-Json -Depth 5))
  try { $r = Invoke-Rig (Base) 'example' } finally { [IO.File]::WriteAllText($profileFile, $profileText) }
  Check ((Show $r.Calls) -ceq (Show ($steps + $create))) "(j) a root ending in a slash: tab create gets it as one word, then --label and --no-focus ($(Show $r.Calls))"
  Check-Claude $r 'example' '(j) a root ending in a slash'
} catch {
  # A terminating error must not let the run fall through to "all checks passed": count it and report it.
  "FAIL self-test aborted: $($_.Exception.Message)"
  $script:fails++
} finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force   # a plain temp folder: no links inside
}
if ($script:fails) { "$($script:fails) check(s) failed"; exit 1 }
'rig selftest: all checks passed'
exit 0
