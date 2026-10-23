# wt-remove.ps1 - remove a ticket worktree after Jas merges (the rig README, The loop for a ticket). The orchestrator runs it; seats can't.
# Usage: & '<rig>\wt-remove.ps1' <prefix><n>-<slug>   (ex123-short-slug for the prefix ex)
# The project is the rig folder whose profile.json has that ticketPrefix (see wt-new.ps1).
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-z]+\d+-[a-z0-9][a-z0-9-]*$')]
  [string]$Name
)
$rig = $PSScriptRoot
# profile.json reader: guard.cjs (loadProfile) is the one validator; keep the find-by-prefix/root and slash-normalising (-replace) lines identical in rig.ps1, wt-new.ps1, wt-remove.ps1, wt.selftest.ps1 and statusline.ps1, and add no rule here.
$projects = @(Get-ChildItem -LiteralPath $rig -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'profile.json') } | ForEach-Object {
  $file = Join-Path $_.FullName 'profile.json'
  try { $p = Get-Content -LiteralPath $file -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop }
  catch { throw "$file is not valid JSON ($($_.Exception.Message)); nothing was removed. Tell Jas." }
  if ($p.ticketPrefix -and $Name -cmatch "^$([regex]::Escape($p.ticketPrefix))\d+-") { [pscustomobject]@{ Dir = $_.FullName; Profile = $p } }
})
if ($projects.Count -ne 1) { throw "No single project has the ticket prefix of '$Name' (each rig\<project>\profile.json names its ticketPrefix); nothing was removed." }
$p = $projects[0].Profile
$root = $p.root -replace '/', '\'
$base = "origin/$($p.defaultBranch)"
$wt = Join-Path $root ".claude\worktrees\$Name"
$branch = "worktree-$Name"
$active = Join-Path $projects[0].Dir 'active-worktree'

if (-not (Test-Path $wt)) { throw "No worktree at $wt." }

$dirty = git -C $wt status --porcelain
if ($dirty) { throw "Worktree $wt has uncommitted changes; nothing was removed. Tell Jas." }

$nm = Get-Item -LiteralPath (Join-Path $wt 'node_modules') -Force -ErrorAction SilentlyContinue
if ($nm) {
  if ($nm.LinkType -ne 'Junction') { throw "$($nm.FullName) is a real folder, not a junction. Stopping so nothing shared gets deleted; tell Jas." }
  [IO.Directory]::Delete($nm.FullName)  # removes the link only, never the folder it points to
}

git -C $root worktree remove $wt
if ($LASTEXITCODE -ne 0) {
  if ($nm) { New-Item -ItemType Junction -Path (Join-Path $wt 'node_modules') -Target (Join-Path $root 'node_modules') | Out-Null }
  throw 'git worktree remove failed (probably a lane is still inside it: ask it to use ExitWorktree). The node_modules link was restored; nothing else changed.'
}

git -C $root fetch origin --quiet
git -C $root merge-base --is-ancestor $branch $base
if ($LASTEXITCODE -eq 0) {
  git -C $root branch -q -D $branch
  "branch $branch deleted (it is part of $base)"
} else {
  "branch $branch kept: it is not part of $base (a squash merge, or not merged yet). Jas deletes it when sure."
}

if ((Test-Path $active) -and ([IO.File]::ReadAllText($active) -eq $wt)) { [IO.File]::WriteAllText($active, '') }
"removed $wt"
