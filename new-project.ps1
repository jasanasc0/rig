# new-project.ps1 - makes a project folder <rig>\<name>\ from the template example\ (the README, Adding a project).
# Run: powershell -NoProfile -File <rig>\new-project.ps1 -Name <name> -Root <the project's main checkout> -Prefix <ticket prefix>
# It copies example\, fills in the rig folder ({{RIG}}), the root, the name and the prefix (lanes <prefix>-<seat>, tickets <PREFIX>-<n>,
# worktrees <prefix><n>-<slug>), then runs projects.check.cjs on the new project. It refuses, writing nothing: a name or prefix in the
# wrong shape, a name the engine's git tracks or Windows reserves, the prefix ex (example's), a folder that exists, a root that is not an
# existing folder, and a rig or root path holding a space, ' or $. A project that fails the check, or a copy that breaks off, is removed.
param(
  [Parameter(Mandatory = $true)][string]$Name,
  [Parameter(Mandatory = $true)][string]$Root,
  [Parameter(Mandatory = $true)][string]$Prefix
)
$ErrorActionPreference = 'Stop'
$rig = $PSScriptRoot
function Refuse($why) { "new-project: $why; nothing written"; exit 1 }
# A space or ' breaks the hook and lane start commands (unquoted) and the role texts' quoted lines; the guard refuses a --cwd holding $.
$unsafe = '[ ''$]'

if ($Name -cnotmatch '^[a-z0-9][a-z0-9-]*\z') { Refuse "'$Name' is not a project name (lowercase letters, digits and -, not starting with -)" }
# The top-level folders the engine's git tracks (the .gitignore's !/<folder>/ lines: example, .githooks, test).
$tracked = @(Get-Content -LiteralPath (Join-Path $rig '.gitignore') -ErrorAction SilentlyContinue | ForEach-Object { if ($_ -cmatch '^!/([^/]+)/\s*$') { $Matches[1] } })
if ($tracked -ccontains $Name) { Refuse "'$Name' is a folder the engine's git tracks (.gitignore !/$Name/), so the project would be committed into the engine repo" }
if ($Name -cmatch '^(con|prn|aux|nul|com[1-9]|lpt[1-9])\z') { Refuse "'$Name' is a Windows device name (con, prn, aux, nul, com1-9, lpt1-9), not a folder name" }
if ($Prefix -cnotmatch '^[a-z]+\z') { Refuse "'$Prefix' is not a ticket prefix (lowercase letters only)" }
if ($Prefix -ceq 'ex') { Refuse "the prefix ex is example's (the template's), and wt-new.ps1 and wt-remove.ps1 find a project by its prefix" }
$dest = Join-Path $rig $Name
if (Test-Path -LiteralPath $dest) { Refuse "$dest already exists" }
if (-not (Test-Path -LiteralPath $Root -PathType Container)) { Refuse "the root $Root is not an existing folder" }
$rootDir = (Resolve-Path -LiteralPath $Root).ProviderPath -replace '(?<!:)\\+$', ''
if ($rootDir -match $unsafe) { Refuse "the root $rootDir holds a space, ' or `$, which would break the hook, lane start and role commands" }
# The rig folder as the guard writes it (RIG_DIR: forward slashes, its case on disk): the guard compares the lane start lines with it exactly.
# node prints UTF-8, so it is read as UTF-8 (a rig path with letters outside the console's code page comes through whole), then the
# console's encoding is put back.
$enc = [Console]::OutputEncoding
try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false } catch {} # no console: nothing to set
try { $rigDir = [string](& node "$rig\projects.check.cjs" --rig-dir) } catch { $rigDir = '' } finally { try { [Console]::OutputEncoding = $enc } catch {} }
if ($LASTEXITCODE -ne 0 -or -not $rigDir) { Refuse 'node could not print the rig folder (is Node on the PATH?)' }
if ($rigDir -match $unsafe) { Refuse "the rig folder $rigDir holds a space, ' or `$, which would break the hook, lane start and role commands; move the rig" }

# The template's tokens (example\'s only project-specific words) and what each becomes. The keys are case-sensitive: ex and EX differ.
$map = New-Object 'System.Collections.Generic.Dictionary[string,string]'
$map['{{RIG}}'] = $rigDir
$map['C:/example-project'] = $rootDir -replace '\\', '/'
$map['C:\example-project'] = $rootDir
$map['example'] = $Name
$map['ex'] = $Prefix
$map['EX'] = $Prefix.ToUpperInvariant()
# One pass over each file, so a value written in is never matched again (a rig path, root or name may hold example or ex- itself). The
# root comes before the name it contains; the prefix only where it is one: ex<n>, ex0-oscar.md, ex-<seat>, the profile's "ex", EX-<n>.
$tokens = '\{\{RIG\}\}|C:/example-project|C:\\example-project|\bexample\b|\bex(?=[0-9<-])|(?<=")ex(?=")|\bEX(?=-)'

# $dest did not exist above, so on any error everything under it is this run's own and goes.
try {
  Copy-Item -LiteralPath (Join-Path $rig 'example') -Destination $dest -Recurse
  foreach ($f in Get-ChildItem -LiteralPath $dest -Recurse -File -Force) {
    $text = [IO.File]::ReadAllText($f.FullName)
    $filled = [regex]::Replace($text, $tokens, { param($m) $map[$m.Value] })
    if ($filled -cne $text) { [IO.File]::WriteAllText($f.FullName, $filled) } # UTF-8 without a BOM; line ends as in the template
  }
  # The folders the settings name as additionalDirectories; git ignores them, so the template has neither.
  foreach ($d in 'briefs', 'pms') { [void](New-Item -ItemType Directory -Path (Join-Path $dest "work\$d") -Force) }
} catch {
  Remove-Item -LiteralPath $dest -Recurse -Force -ErrorAction SilentlyContinue
  throw
}

"new-project: made $dest; checking it:"
& node "$rig\projects.check.cjs" $Name
if ($LASTEXITCODE -ne 0) {
  Remove-Item -LiteralPath $dest -Recurse -Force
  "new-project: $Name fails the check above, so $dest was removed; fix what it names and run again; nothing written"
  exit 1
}
"new-project: next, write each FILL IN: paragraph in $dest\rules (the README, Adding a project), then start it with rig.ps1 $Name"
exit 0
