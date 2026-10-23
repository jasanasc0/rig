# wt.selftest.ps1 - checks wt-new.ps1 and wt-remove.ps1 (next to this file) in %TEMP%: copies of both in a temp rig whose one project,
# example (its profile with a temp root, a .env.local to copy and a node_modules junction), points at a throwaway repo with a local bare
# origin. No network and no real checkout. Creates and removes the worktree ex0-rigselftest there; the temp folder goes at the end.
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File <rig>\wt.selftest.ps1
$Project = 'example'
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('rig-wt-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$rig = Join-Path $tmp 'rig'
$script:fails = 0
function Check($ok, $label) { if ($ok) { "ok   $label" } else { "FAIL $label"; $script:fails++ } }

try {
  # The throwaway repo: one commit on main, pushed to a bare origin next to it, with a git-ignored .env.local and node_modules folder.
  $origin = Join-Path $tmp 'origin.git'
  $repo = Join-Path $tmp 'root'
  git init -q --bare -b main $origin
  git init -q -b main $repo
  git -C $repo remote add origin $origin
  [IO.File]::WriteAllText((Join-Path $repo '.gitignore'), "node_modules/`n.claude/`n.env.local`n")
  [IO.File]::WriteAllText((Join-Path $repo '.env.local'), "X=1`n")
  git -C $repo add .gitignore
  git -C $repo -c user.name=rig-test -c user.email=rig-test@localhost commit -q -m one
  git -C $repo push -q origin main
  if ($LASTEXITCODE -ne 0) { throw 'the throwaway repo could not be set up (git push to its local origin failed)' }
  New-Item -ItemType Directory (Join-Path $repo 'node_modules'), (Join-Path $rig $Project) | Out-Null
  [IO.File]::WriteAllText((Join-Path $repo 'node_modules\keep.txt'), 'x')
  foreach ($f in 'wt-new.ps1', 'wt-remove.ps1') { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $f) -Destination $rig -ErrorAction Stop }
  $exProfile = Get-Content -LiteralPath (Join-Path $PSScriptRoot "$Project\profile.json") -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
  $exProfile.root = $repo -replace '\\', '/'
  $exProfile.worktreeCopy = @('.env.local')
  $exProfile.nodeModulesJunction = $true
  [IO.File]::WriteAllText((Join-Path $rig "$Project\profile.json"), ($exProfile | ConvertTo-Json -Depth 5))

  # profile.json reader: guard.cjs (loadProfile) is the one validator; keep the find-by-prefix/root and slash-normalising (-replace) lines identical in rig.ps1, wt-new.ps1, wt-remove.ps1, wt.selftest.ps1 and statusline.ps1, and add no rule here.
  $p = Get-Content -LiteralPath (Join-Path $rig "$Project\profile.json") -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
  $root = $p.root -replace '/', '\'
  $active = Join-Path $rig "$Project\active-worktree"
  $name = "$($p.ticketPrefix)0-rigselftest"
  $wt = Join-Path $root ".claude\worktrees\$name"

  if ($p.nodeModulesJunction) { $before = (Get-ChildItem (Join-Path $root 'node_modules') -Force | Measure-Object).Count }

  & "$rig\wt-new.ps1" $name
  if (-not (Test-Path $wt)) { throw "wt-new.ps1 did not create $wt; stopping before the test writes anything under it" }
  Check (Test-Path $wt) 'worktree folder created'
  Check ($null -ne (git -C $root branch --list "worktree-$name")) 'branch created'
  foreach ($f in @($p.worktreeCopy)) { Check (Test-Path (Join-Path $wt $f)) "$f copied" }
  if ($p.nodeModulesJunction) { Check ((Get-Item (Join-Path $wt 'node_modules') -Force).LinkType -eq 'Junction') 'node_modules is a junction' }
  Check ([IO.File]::ReadAllText($active) -eq $wt) 'active-worktree points at the new worktree'

  # Review Focus 4: reusing a name refuses and leaves the worktree alone
  $second = 'no error'
  try { & "$rig\wt-new.ps1" $name } catch { $second = $_.Exception.Message }
  Check ($second -like '*already exists*') 'second wt-new with the same name refuses'
  Check ((Test-Path (Join-Path $wt '.git')) -and (git -C $wt rev-parse --abbrev-ref HEAD) -eq "worktree-$name") 'existing worktree untouched (still on its branch)'

  # Field note 4 (review-pam builder's open item): -Resume makes the registered worktree the coder's again with no git change; a name with no
  # worktree refuses and leaves active-worktree alone. The git state compared is the root's worktree paths, the branch and the worktree's HEAD
  # (not every ref: live lanes may commit elsewhere in the same repo meanwhile).
  function Get-ResumeState { ((@(git -C $root worktree list --porcelain) | Where-Object { $_ -like 'worktree *' }) + @(git -C $root rev-parse "refs/heads/worktree-$name") + @(git -C $wt rev-parse HEAD)) -join "`n" }
  [IO.File]::WriteAllText($active, '')
  $gitBefore = Get-ResumeState
  $resumed = 'ran'
  try { & "$rig\wt-new.ps1" $name -Resume } catch { $resumed = $_.Exception.Message }
  Check ($resumed -eq 'ran') "-Resume of the existing worktree runs ($resumed)"
  Check ([IO.File]::ReadAllText($active) -eq $wt) '-Resume points active-worktree at the existing worktree'
  Check ((Get-ResumeState) -eq $gitBefore) '-Resume changed nothing in git (worktrees, branch, HEAD)'
  $unregistered = 'no error'
  try { & "$rig\wt-new.ps1" "$name-none" -Resume } catch { $unregistered = $_.Exception.Message }
  Check ($unregistered -like '*not a registered worktree*') '-Resume of a name with no worktree refuses'
  Check ([IO.File]::ReadAllText($active) -eq $wt) 'the refused -Resume left active-worktree alone'

  # Review Focus 5: a real node_modules folder makes wt-remove refuse and delete nothing
  $nm = Join-Path $wt 'node_modules'
  if ($p.nodeModulesJunction) { [IO.Directory]::Delete($nm) }
  New-Item -ItemType Directory $nm | Out-Null
  [IO.File]::WriteAllText((Join-Path $nm 'keep.txt'), 'x')
  $refused = 'no error'
  try { & "$rig\wt-remove.ps1" $name } catch { $refused = $_.Exception.Message }
  Check ($refused -like '*real folder*') 'wt-remove refuses a real node_modules folder'
  Check (Test-Path (Join-Path $nm 'keep.txt')) 'the real folder was left alone'
  [IO.File]::Delete((Join-Path $nm 'keep.txt'))
  [IO.Directory]::Delete($nm)
  if ($p.nodeModulesJunction) { New-Item -ItemType Junction -Path $nm -Target (Join-Path $root 'node_modules') | Out-Null }

  & "$rig\wt-remove.ps1" $name
  Check (-not (Test-Path $wt)) 'worktree folder removed'
  Check ($null -eq (git -C $root branch --list "worktree-$name")) "branch removed (it is part of origin/$($p.defaultBranch))"
  if ($p.nodeModulesJunction) {
    $after = (Get-ChildItem (Join-Path $root 'node_modules') -Force | Measure-Object).Count
    Check ($after -eq $before) "main node_modules intact ($after entries)"
  }
  Check ([IO.File]::ReadAllText($active) -eq '') 'active-worktree emptied'
} catch {
  # A terminating error must not let the run fall through to "all checks passed": count it and report it.
  "FAIL self-test aborted: $($_.Exception.Message)"
  $script:fails++
} finally {
  # The worktree's node_modules junction (if a failed run left one) goes first, as a link, so the delete never reaches through it.
  $link = if ($wt) { Get-Item -LiteralPath (Join-Path $wt 'node_modules') -Force -ErrorAction SilentlyContinue }
  if ($link -and $link.LinkType -eq 'Junction') { [IO.Directory]::Delete($link.FullName) }
  if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
}
if (Test-Path -LiteralPath $tmp) { "FAIL the temp folder $tmp is still there"; $script:fails++ }
if ($script:fails) { "$($script:fails) check(s) failed"; exit 1 }
'wt selftest: all checks passed'
