# new-project.selftest.ps1 - checks new-project.ps1 on temp copies of the rig and temp roots only (never this rig's own folders).
# Run: powershell -NoProfile -File <rig>\new-project.selftest.ps1   (exit 1 on any FAIL)
# shortcut: a TEMP path with a space makes the good run a refusal (new-project.ps1 refuses a rig path with a space); set TEMP to a folder
# without one to run this selftest on such a machine.
$src = $PSScriptRoot
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('new-project-selftest-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
[void](New-Item -ItemType Directory -Path $tmp)
$script:fails = 0
function Check($ok, $label) { if ($ok) { "ok   $label" } else { "FAIL $label"; $script:fails++ } }
# A temp rig: the files new-project.ps1 needs (with the hook scripts projects.check.cjs looks for), and the template.
function New-Rig($dir) {
  [void](New-Item -ItemType Directory -Path $dir)
  foreach ($f in 'guard.cjs', 'refocus.cjs', 'context-check.cjs', 'projects.check.cjs', 'new-project.ps1', '.gitignore') { Copy-Item -LiteralPath (Join-Path $src $f) -Destination $dir }
  Copy-Item -LiteralPath (Join-Path $src 'example') -Destination (Join-Path $dir 'example') -Recurse
  $dir
}
function New-Dir($name) { (New-Item -ItemType Directory -Path (Join-Path $tmp $name)).FullName }
# Runs new-project.ps1 as Jas would, in its own powershell; its output lines land in $script:out, and the exit code is returned.
function New-Project($rig, $name, $root, $prefix) {
  $script:out = @(& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $rig 'new-project.ps1') -Name $name -Root $root -Prefix $prefix 2>&1 | ForEach-Object { "$_" })
  $LASTEXITCODE
}
# Every folder under the temp folder, and every file with its size and time: equal before and after means nothing was written. (Not a
# folder's time: NTFS updates it a moment after a copy into the folder, so it can change with nothing written.)
function Snapshot { (Get-ChildItem -LiteralPath $tmp -Recurse -Force | ForEach-Object { if ($_.PSIsContainer) { $_.FullName } else { "$($_.FullName)|$($_.Length)|$($_.LastWriteTimeUtc.Ticks)" } }) -join "`n" }
function Rel($base) { Get-ChildItem -LiteralPath $base -Recurse -File -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName.Substring($base.Length) } | Sort-Object }

# 1. A good run.
$rig = New-Rig (Join-Path $tmp 'rig')
$rootA = New-Dir 'root-a'
$code = New-Project $rig 'home-app' $rootA 'ha'
$proj = Join-Path $rig 'home-app'
Check ($code -eq 0 -and ($script:out -join "`n") -cmatch '(?m)^projects: 1 checked$' -and -not (($script:out -join "`n") -cmatch '(?m)^FAIL')) "a good run exits 0 and its projects.check run passes (exit $code)"
if ($code -ne 0) { $script:out }
& node (Join-Path $rig 'projects.check.cjs') | Out-Null
Check ($LASTEXITCODE -eq 0) 'projects.check.cjs with no name passes on the new project too'
$rigDir = [string](& node (Join-Path $rig 'projects.check.cjs') --rig-dir)
$files = @(Get-ChildItem -LiteralPath $proj -Recurse -File -Force -ErrorAction SilentlyContinue)
$text = ($files | ForEach-Object { [IO.File]::ReadAllText($_.FullName) }) -join "`n"
Check ($files.Count -gt 0 -and -not $text.Contains('{{')) 'no {{RIG}} (and no other {{...}} placeholder) is left in the new project'
Check ($files.Count -gt 0 -and $text -notmatch 'example') 'no "example" is left, in any case (the name, the root C:\example-project or C:/example-project)'
Check ($files.Count -gt 0 -and $text -notmatch '\bex(?=[0-9<-])|"ex"') 'no ex prefix is left, in any case (ex<n>, ex0-oscar.md, ex-<seat>, EX-<n>, "ex")'
$p = Get-Content -LiteralPath (Join-Path $proj 'profile.json') -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json
Check ($p.name -ceq 'home-app' -and $p.ticketPrefix -ceq 'ha' -and $p.root -ceq ($rootA -replace '\\', '/') -and $p.lanes.orchestrator -ceq 'ha-orchestrator' -and $p.lanes.coder -ceq 'ha-coder' -and $p.lanes.pam -ceq 'ha-pam') 'the profile holds the name, the prefix, the root with forward slashes and the ha-<seat> lanes'
$orch = '' + (Get-Content -LiteralPath (Join-Path $proj 'rules\orchestrator.md') -Raw -Encoding UTF8 -ErrorAction SilentlyContinue)
$want = @('rig for the project home-app', 'HA-<n>', 'HA-0', 'ha<n>-<slug>', 'ha0-oscar.md', 'ha-coder', "& '$rigDir/lanes.ps1' home-app", "Worktree: $rootA\.claude\worktrees\ha<n>-<slug>", "$rigDir/home-app/profile.json", "& '$rigDir/wt-new.ps1'")
$missing = @($want | Where-Object { -not $orch.Contains($_) })
Check ($rigDir -and $missing.Count -eq 0) "orchestrator.md names the project, its codes, worktrees, lanes, lanes.ps1 line, root (backslashes) and rig folder (missing: $($missing -join ' | '))"
$ex = Join-Path $rig 'example'
Check ((@(Rel $ex) -join '|') -ceq (@(Rel $proj) -join '|')) 'the new project has the template files, no more and no fewer'
$empty = @(Get-ChildItem -LiteralPath $ex -Recurse -File | Where-Object { $_.Length -eq 0 } | ForEach-Object { $_.FullName.Substring($ex.Length) })
$notEmpty = @($empty | Where-Object { $f = Join-Path $proj $_; -not (Test-Path -LiteralPath $f -PathType Leaf) -or (Get-Item -LiteralPath $f).Length -ne 0 })
Check ($empty.Count -gt 0 -and $notEmpty.Count -eq 0) "the template's empty files are copied and stay empty ($($empty -join ', '))"
Check ((Test-Path -LiteralPath (Join-Path $proj 'work\briefs') -PathType Container) -and (Test-Path -LiteralPath (Join-Path $proj 'work\pms') -PathType Container)) 'work\briefs and work\pms exist (the settings name them as additionalDirectories)'
$bom = @($files | Where-Object { $b = [IO.File]::ReadAllBytes($_.FullName); $b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF })
Check ($files.Count -gt 0 -and -not $text.Contains("`r") -and $bom.Count -eq 0) 'the new files keep LF line ends and have no BOM'

# A name and root that hold the template's own tokens come out whole: the values written in are never replaced again.
$rootB = New-Dir 'root-ex-1-example-project'
$code = New-Project $rig 'ex-example' $rootB 'et'
$p = Get-Content -LiteralPath (Join-Path $rig 'ex-example\profile.json') -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json
$orch = '' + (Get-Content -LiteralPath (Join-Path $rig 'ex-example\rules\orchestrator.md') -Raw -Encoding UTF8 -ErrorAction SilentlyContinue)
Check ($code -eq 0 -and $p.name -ceq 'ex-example' -and $p.root -ceq ($rootB -replace '\\', '/') -and $p.lanes.coder -ceq 'et-coder' -and $orch.Contains('rig for the project ex-example') -and $orch.Contains("Worktree: $rootB\.claude\worktrees\et<n>-<slug>") -and $orch.Contains("& '$rigDir/lanes.ps1' ex-example")) "a name ex-example and a root ...\root-ex-1-example-project come out whole (exit $code)"

# 2. Each refusal: one line, exit 1, nothing written anywhere under the temp folder.
$aFile = Join-Path $tmp 'a-file.txt'
[IO.File]::WriteAllText($aFile, 'x')
$spacedRoot = New-Dir 'root space'
$quotedRoot = New-Dir "root'q"
$dollarRoot = New-Dir 'root$d'
$refusals = @(
  @('home-app', $rootA, 'hb', 'an existing project folder'),
  @('example', $rootA, 'hb', 'example, the template (a folder the engine tracks)'),
  @('test', $rootA, 'hb', "test, a folder the engine's git tracks (.gitignore !/test/)"),
  @('con', $rootA, 'hb', 'the Windows device name con'),
  @('nul', $rootA, 'hb', 'the Windows device name nul'),
  @('com1', $rootA, 'hb', 'the Windows device name com1'),
  @('lpt9', $rootA, 'hb', 'the Windows device name lpt9'),
  @('Home', $rootA, 'hb', 'a name with a capital'),
  @('a_b', $rootA, 'hb', 'a name with _'),
  @('..', $rootA, 'hb', 'the name ..'),
  @('new-a', $rootA, 'HB', 'a prefix in capitals'),
  @('new-b', $rootA, 'h1', 'a prefix with a digit'),
  @('new-c', $rootA, 'h-b', 'a prefix with -'),
  @('new-d', $rootA, 'ex', "the prefix ex (example's)"),
  @('new-e', (Join-Path $tmp 'no-such-root'), 'hb', 'a root that does not exist'),
  @('new-f', $aFile, 'hb', 'a root that is a file'),
  @('new-g', $spacedRoot, 'hb', 'a root with a space'),
  @('new-h', $quotedRoot, 'hc', "a root with a '"),
  @('new-i', $dollarRoot, 'hd', 'a root with a $')
) # one name and prefix per case, so a case that wrongly writes a project can't make a later one pass as "already exists"
foreach ($c in $refusals) {
  $before = Snapshot
  $code = New-Project $rig $c[0] $c[1] $c[2]
  Check ($code -eq 1 -and $script:out.Count -eq 1 -and $script:out[0] -clike 'new-project: *nothing written' -and (Snapshot) -ceq $before) "refused with one line, nothing written: $($c[3]) (exit $code; $($script:out -join ' | '))"
}

# 3. A rig path with a space, a ' or a $.
foreach ($folder in 'rig space', "rig'q", 'rig$d') {
  $badRig = New-Rig (Join-Path $tmp $folder)
  $before = Snapshot
  $code = New-Project $badRig 'new' $rootA 'hb'
  Check ($code -eq 1 -and $script:out.Count -eq 1 -and $script:out[0] -clike "*rig folder*$folder*nothing written" -and (Snapshot) -ceq $before) "a rig path ...\$folder is refused with one line, nothing written (exit $code; $($script:out -join ' | '))"
}

# 4. Nothing half-made. A project that fails its check (here: home-app's prefix) is removed again.
$rootC = New-Dir 'root-c'
$before = Snapshot
$code = New-Project $rig 'clash' $rootC 'ha'
Check ($code -eq 1 -and $script:out[-1] -clike 'new-project: clash fails the check above, so * was removed*nothing written' -and (Snapshot) -ceq $before) "a project that fails its check is removed, nothing left (exit $code; last line: $($script:out[-1]))"
# A copy that breaks off (a read-only template file can't be filled in) leaves nothing either.
$roRig = New-Rig (Join-Path $tmp 'rig-ro')
Set-ItemProperty -LiteralPath (Join-Path $roRig 'example\profile.json') -Name IsReadOnly -Value $true
$before = Snapshot
$code = New-Project $roRig 'broken' $rootC 'br'
$said = $script:out -join ' '
Check ($code -ne 0 -and $said -notmatch 'checking it' -and $said -match 'denied' -and -not (Test-Path -LiteralPath (Join-Path $roRig 'broken')) -and (Snapshot) -ceq $before) "a copy that breaks off midway (access denied) is removed, nothing left (exit $code)"

# 5. A rig folder with a letter outside the console's code page (e-acute), with the console on code page 437 as on a default Windows
# install: node prints the folder in UTF-8, and new-project.ps1 must read it as such.
$eRig = New-Rig (Join-Path $tmp ('rig-' + [char]0x00E9))
$rootE = New-Dir 'root-e'
$cp = [Console]::OutputEncoding
$forced = 'console code page 437'
try { [Console]::OutputEncoding = [Text.Encoding]::GetEncoding(437) } catch { $forced = "console code page left as it was: $($_.Exception.Message)" }
try { $code = New-Project $eRig 'home-app' $rootE 'ha' } finally { try { [Console]::OutputEncoding = $cp } catch {} }
& node (Join-Path $eRig 'projects.check.cjs') | Out-Null
$checkCode = $LASTEXITCODE
$settings = '' + (Get-Content -LiteralPath (Join-Path $eRig 'home-app\rules\coder.settings.json') -Raw -Encoding UTF8 -ErrorAction SilentlyContinue)
Check ($code -eq 0 -and $checkCode -eq 0 -and $settings.Contains('/rig-' + [char]0x00E9 + '/guard.cjs --project home-app')) "a rig folder rig-e-acute comes through whole ($forced; exit $code, projects.check exit $checkCode)"

Remove-Item -LiteralPath $tmp -Recurse -Force
if ($script:fails) { "$($script:fails) check(s) failed"; exit 1 }
'new-project selftest: all checks passed'
exit 0
