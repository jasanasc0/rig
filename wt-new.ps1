# wt-new.ps1 - create a ticket worktree for the rig (the rig README, The loop for a ticket). The orchestrator runs it; seats can't.
# Usage: & '<rig>\wt-new.ps1' <prefix><n>-<slug>   (ex123-short-slug for the prefix ex)
#        & '<rig>\wt-new.ps1' <prefix><n>-<slug> -Resume   (an existing ticket worktree becomes the coder's again)
# The project is the rig folder whose profile.json has that ticketPrefix: its root, default branch, files to copy, node_modules junction
# and active-worktree file come from there. Everything that can stop it is checked before git changes anything.
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-z]+\d+-[a-z0-9][a-z0-9-]*$')]
  [string]$Name,
  # Field note 4: no git change. The worktree has to be registered in the root (git worktree list) on its branch worktree-<name>; then
  # active-worktree points at it, as after a new one.
  [switch]$Resume
)
$rig = $PSScriptRoot
# profile.json reader: guard.cjs (loadProfile) is the one validator; keep the find-by-prefix/root and slash-normalising (-replace) lines identical in rig.ps1, wt-new.ps1, wt-remove.ps1, wt.selftest.ps1 and statusline.ps1, and add no rule here.
$projects = @(Get-ChildItem -LiteralPath $rig -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'profile.json') } | ForEach-Object {
  $file = Join-Path $_.FullName 'profile.json'
  try { $p = Get-Content -LiteralPath $file -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop }
  catch { throw "$file is not valid JSON ($($_.Exception.Message)); nothing was created. Tell Jas." }
  if ($p.ticketPrefix -and $Name -cmatch "^$([regex]::Escape($p.ticketPrefix))\d+-") { [pscustomobject]@{ Dir = $_.FullName; Profile = $p } }
})
if ($projects.Count -ne 1) { throw "No single project has the ticket prefix of '$Name' (each rig\<project>\profile.json names its ticketPrefix); nothing was created." }
$dir = $projects[0].Dir
$p = $projects[0].Profile
$root = $p.root -replace '/', '\'
$base = "origin/$($p.defaultBranch)"
$wt = Join-Path $root ".claude\worktrees\$Name"
$branch = "worktree-$Name"

# Field note 6: main's node_modules fits a worktree only while the branch's package-lock.json is the one that node_modules was installed
# from: the lockfile of the root checkout's HEAD (review-pam M3; the stale-install check below ties it to origin/<defaultBranch>, so a
# branch just made from there has it). And npm ci in a worktree whose node_modules is a junction would write into main's. So: 0 = the same
# lockfile (a junction is fine), 1 = they differ, any other exit = git could not compare (treated like a difference: no junction).
function Get-LockDiff {
  git -C $root diff --quiet HEAD $branch -- package-lock.json
  return $LASTEXITCODE
}
function Get-NpmLine($lockDiff) {
  $why = if ($lockDiff -eq 1) { "package-lock.json on $branch differs from the one in $root's HEAD (what its node_modules was installed from)" } else { "git could not compare package-lock.json between $root's HEAD and $branch (exit $lockDiff)" }
  "$why, so $wt gets no node_modules junction: Jas runs npm ci in $wt (npm ci in a worktree whose node_modules is a junction would write into $root\node_modules)."
}

if ($Resume) {
  $listing = @(git -C $root worktree list --porcelain)
  if ($LASTEXITCODE -ne 0) { throw "git worktree list failed in $root; nothing was changed." }
  # Porcelain: a "worktree <path>" line starts each entry, and "branch refs/heads/<name>" follows unless its HEAD is detached.
  $entries = @()
  foreach ($line in $listing) {
    if ($line.StartsWith('worktree ')) { $entries += [pscustomobject]@{ Path = ($line.Substring(9) -replace '/', '\').TrimEnd('\'); Branch = '' } }
    elseif ($line.StartsWith('branch ') -and $entries.Count) { $entries[-1].Branch = $line.Substring(7) -replace '^refs/heads/', '' }
  }
  $mine = @($entries | Where-Object { $_.Path -ieq $wt.TrimEnd('\') })
  if ($mine.Count -ne 1) { throw "$wt is not a registered worktree of $root; nothing was changed (wt-new.ps1 $Name without -Resume creates one)." }
  $on = $mine[0].Branch
  if ($on -cne $branch) { throw "$wt is on $(if ($on) { $on } else { 'a detached HEAD' }), not $branch; nothing was changed. Tell Jas." }
  if (-not (Test-Path -LiteralPath $wt -PathType Container)) { throw "$wt is registered but its folder is gone; nothing was changed. Tell Jas." }
  if ($p.nodeModulesJunction) {
    $lockDiff = Get-LockDiff
    $nm = Get-Item -LiteralPath (Join-Path $wt 'node_modules') -Force -ErrorAction SilentlyContinue
    # A real node_modules folder means Jas installed one already; a missing one or a junction needs his npm ci.
    if ($lockDiff -ne 0 -and (-not $nm -or $nm.LinkType -eq 'Junction')) {
      Get-NpmLine $lockDiff
      if ($nm) { "Its node_modules is still a junction into $root\node_modules: Jas removes that junction first (the link only), then runs npm ci." }
    } elseif (-not $nm) {
      # review-pam M4: the same lockfile but no node_modules at all (a junction Jas removed earlier, no npm ci since): the coder's first
      # test run would fail, so Jas hears it now. -Resume still makes no junction.
      "$wt has no node_modules: Jas runs npm ci in $wt before the coder runs anything there."
    }
  }
  [IO.File]::WriteAllText((Join-Path $dir 'active-worktree'), $wt)
  "worktree=$wt"
  "branch=$branch"
  "head=$(git -C $wt rev-parse HEAD)"
  exit 0
}

if (Test-Path $wt) { throw "Worktree $wt already exists. Pick another name, run wt-new.ps1 $Name -Resume to make it the coder's again, or remove it first with wt-remove.ps1." }
foreach ($f in @($p.worktreeCopy)) {
  if (-not (Test-Path -LiteralPath (Join-Path $root $f) -PathType Leaf)) { throw "$(Join-Path $root $f) is missing (the profile copies it into every worktree); nothing was created. Tell Jas." }
}
if ($p.nodeModulesJunction -and -not (Test-Path -LiteralPath (Join-Path $root 'node_modules') -PathType Container)) {
  throw "$root has no node_modules for the worktree's junction: Jas runs npm ci in $root first. Nothing was created."
}

git -C $root fetch origin --quiet
if ($LASTEXITCODE -ne 0) { throw 'git fetch origin failed; nothing was created.' }

git -C $root diff --quiet HEAD $base -- package-lock.json
if ($LASTEXITCODE -ne 0) { throw "package-lock.json differs between $root's HEAD and $base, so the install in $root is stale. Jas runs 'git pull --ff-only' and 'npm ci' in $root first. Nothing was created." }

git -C $root worktree add --quiet --no-track -b $branch $wt $base
if ($LASTEXITCODE -ne 0) { throw 'git worktree add failed; see the git message above.' }

foreach ($f in @($p.worktreeCopy)) {
  $to = Join-Path $wt $f
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $to) | Out-Null
  Copy-Item -LiteralPath (Join-Path $root $f) -Destination $to -ErrorAction Stop
}
if ($p.nodeModulesJunction) {
  $lockDiff = Get-LockDiff
  if ($lockDiff -eq 0) { New-Item -ItemType Junction -Path (Join-Path $wt 'node_modules') -Target (Join-Path $root 'node_modules') -ErrorAction Stop | Out-Null }
  else { Get-NpmLine $lockDiff }
}
[IO.File]::WriteAllText((Join-Path $dir 'active-worktree'), $wt)

"worktree=$wt"
"branch=$branch"
"base=$(git -C $wt rev-parse HEAD)"
