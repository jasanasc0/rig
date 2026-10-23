# Combined statusline: dev info (dir/branch/model/context/cost) + plugin pills + rig lane info.
# statusLine is a single command, so everything is emitted from here.
# It runs in place, as <rig>\statusline.ps1 (the statusLine command in ~\.claude\settings.json names it), and finds the project
# profiles next to itself. Check: powershell -NoProfile -ExecutionPolicy Bypass -File <rig>\statusline.check.ps1
$ClaudeDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME ".claude" }
# Bars use U+2588/U+2591; PS 5.1 defaults stdout to the OEM codepage, which mangles them.
# No-BOM UTF8 so the preamble doesn't leak into the statusline text.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$Esc = [char]27
$parts = @()
$badgeParts = @()

# Rig lanes (herdr): every <rig>\<project>\profile.json names a project's root and its five lanes (pam since the pam build). A session whose
# name is one of a project's lanes and whose folder is under that project's root is that project's lane (rig v4).
$RigDir = $PSScriptRoot
$Seats = @('orchestrator', 'coder', 'angela', 'oscar', 'pam')
$Dot = [char]0x00B7
$Shield = [char]::ConvertFromUtf32(0x1F6E1) + [char]0xFE0F

# Green under 70%, amber to 90%, red past it.
function Format-Bar($pct, $width = 10) {
    $p = [math]::Max(0, [math]::Min(100, [double]$pct))
    $fill = [int][math]::Round($p * $width / 100)
    $color = if ($p -ge 90) { "38;5;203" } elseif ($p -ge 70) { "38;5;221" } else { "38;5;114" }
    $bar = "${Esc}[${color}m" + ([string][char]0x2588 * $fill) + "${Esc}[38;5;238m" + ([string][char]0x2591 * ($width - $fill)) + "${Esc}[0m"
    "$bar ${Esc}[${color}m$([math]::Round($p))%${Esc}[0m"
}

# 42m, 3h05m, 2d4h
function Format-Age($ts) {
    if ($ts.TotalHours -lt 1) { return "{0}m" -f [int][math]::Max(0, [math]::Floor($ts.TotalMinutes)) }
    if ($ts.TotalDays -lt 1) { return "{0}h{1:D2}m" -f [int][math]::Floor($ts.TotalHours), $ts.Minutes }
    return "{0}d{1}h" -f $ts.Days, $ts.Hours
}

# Lit when on in THIS session, grey when off.
function Format-Pill($label, $on, $color) {
    $c = if ($on) { $color } else { "38;5;240" }
    "${Esc}[${c}m[$label]${Esc}[0m"
}

# --- Dev info --- read the JSON Claude Code pipes on stdin (session/model/workspace/context/cost).
$raw = [Console]::In.ReadToEnd()
$data = $null
if ($raw) {
    try { $data = $raw | ConvertFrom-Json -ErrorAction Stop } catch {}
}

$cwd = $null
if ($data) {
    $cwd = if ($data.workspace.current_dir) { $data.workspace.current_dir } else { $data.cwd }
    $projDir = $data.workspace.project_dir

    if ($cwd) {
        $cwdLeaf = Split-Path -Leaf $cwd
        # project_dir = where the session was launched; only show it when it
        # differs from cwd (i.e. you've cd'd elsewhere during the session).
        if ($projDir -and $projDir -ne $cwd) {
            $cwdLeaf = "$(Split-Path -Leaf $projDir)/$cwdLeaf"
        }
        $parts += "${Esc}[2m$cwdLeaf${Esc}[0m"

        # skip optional locks: read-only status query, avoid lock contention
        $branch = git -C $cwd --no-optional-locks rev-parse --abbrev-ref HEAD 2>$null
        if ($LASTEXITCODE -eq 0 -and $branch) {
            $parts += "${Esc}[2m$branch${Esc}[0m"
        }
    }

    if ($data.model.display_name) {
        $parts += "${Esc}[2m$($data.model.display_name)${Esc}[0m"
    }

    # Amber from 50%, red from 75% (the lane rotation point).
    $used = $data.context_window.used_percentage
    if ($null -ne $used) {
        $ctxPct = [math]::Round($used)
        $ctxColor = if ($ctxPct -ge 75) { "38;5;203" } elseif ($ctxPct -ge 50) { "38;5;221" } else { "2" }
        $parts += "${Esc}[${ctxColor}mctx $ctxPct%${Esc}[0m"
    }

    $cost = $data.cost.total_cost_usd
    if ($null -ne $cost) {
        $parts += "${Esc}[2m`$$([math]::Round($cost, 2))${Esc}[0m"
    }

    # rate_limits only appears for Pro/Max subscribers after the first API
    # response in the session; each window may be independently absent.
    function Format-ResetIn($resetsAt) {
        if (-not $resetsAt) { return "" }
        $resetDt = [DateTimeOffset]::FromUnixTimeSeconds([int64]$resetsAt).LocalDateTime
        $diff = $resetDt - (Get-Date)
        if ($diff.TotalSeconds -le 0) { return "" }
        if ($diff.TotalDays -ge 1) { return " {0}d{1}h" -f $diff.Days, $diff.Hours }
        return " {0}h{1:D2}m" -f [math]::Floor($diff.TotalHours), $diff.Minutes
    }

    $fiveH = $data.rate_limits.five_hour
    if ($fiveH -and $null -ne $fiveH.used_percentage) {
        $reset = Format-ResetIn $fiveH.resets_at
        $suffix = if ($reset) { "${Esc}[2m resets in$reset${Esc}[0m" } else { "" }
        $parts += "${Esc}[2m5h${Esc}[0m $(Format-Bar $fiveH.used_percentage)$suffix"
    }
}

# --- Which session is this? --- a rig lane reads its own project's settings file (the one it started with).
$seat = $null
$lane = $null
$laneRaw = $null
$projectDir = $null
$prefix = $null
$name = if ($data) { [string]$data.session_name } else { '' }
if ($name -and $cwd) {
    $here = ([string]$cwd) -replace '/', '\'
    # profile.json reader: guard.cjs (loadProfile) is the one validator; keep the find-by-prefix/root and slash-normalising (-replace) lines identical in rig.ps1, wt-new.ps1, wt-remove.ps1, wt.selftest.ps1 and statusline.ps1, and add no rule here.
    foreach ($pf in @(Get-ChildItem -Path (Join-Path $RigDir '*\profile.json') -ErrorAction SilentlyContinue)) {
        try { $p = Get-Content -LiteralPath $pf.FullName -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop } catch { continue }
        $root = (([string]$p.root) -replace '/', '\').TrimEnd('\')
        if (-not $root -or -not ($here -eq $root -or $here.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase))) { continue }
        $key = $Seats | Where-Object { [string]$p.lanes.$_ -eq $name } | Select-Object -First 1
        if ($key) { $seat = $key; $projectDir = $pf.DirectoryName; $prefix = [string]$p.ticketPrefix; break }
    }
}
if ($seat) {
    try {
        $laneRaw = Get-Content (Join-Path $projectDir "rules\$seat.settings.json") -Raw -ErrorAction Stop
        $lane = $laneRaw | ConvertFrom-Json -ErrorAction Stop
    } catch {}
}

$cfg = $null
$Settings = Join-Path $ClaudeDir "settings.json"
if (Test-Path $Settings) {
    try { $cfg = Get-Content $Settings -Raw -ErrorAction Stop | ConvertFrom-Json } catch {}
}

# A lane's own enabledPlugins win over the global ones (same merge Claude Code does with --settings).
function Test-PluginOn($key) {
    if ($lane -and $lane.enabledPlugins -and $null -ne $lane.enabledPlugins.$key) { return [bool]$lane.enabledPlugins.$key }
    return ($cfg -and $cfg.enabledPlugins.$key -eq $true)
}

# --- GitNexus --- its hook is global, so it runs in every session (presence badge).
$badgeParts += Format-Pill "GITNEXUS" (Test-Path (Join-Path $ClaudeDir "hooks\gitnexus\gitnexus-hook.cjs")) "38;5;75"

# --- Superpowers --- plugin enabled for this session.
$badgeParts += Format-Pill "SUPERPOWERS" (Test-PluginOn 'superpowers@claude-plugins-official') "38;5;141"

# --- Ponytail --- its SessionStart hook is global, so on/off is the mode this session started with,
# picked the way ponytail-config.js getDefaultMode does: PONYTAIL_DEFAULT_MODE (a lane's comes from
# its settings env), then %APPDATA%\ponytail\config.json defaultMode, then full. The shared
# .ponytail-active flag only supplies the level (/ponytail ultra): a checker lane's start deletes it.
# ponytail: "stop ponytail" typed mid-session isn't seen (it only deletes the shared flag); per-session
# state would need ponytail to keep one flag per session.
$startMode = if ($seat) { if ($lane -and $lane.env) { [string]$lane.env.PONYTAIL_DEFAULT_MODE } else { '' } } else { [string]$env:PONYTAIL_DEFAULT_MODE }
if (-not $startMode) {
    $ptConfig = Join-Path $(if ($env:APPDATA) { $env:APPDATA } else { Join-Path $HOME "AppData\Roaming" }) "ponytail\config.json"
    try { $startMode = [string](Get-Content $ptConfig -Raw -ErrorAction Stop | ConvertFrom-Json).defaultMode } catch {}
}
$startMode = $startMode.Trim().ToLowerInvariant()
if (@('off', 'lite', 'full', 'ultra') -notcontains $startMode) { $startMode = "full" }
$Flag = Join-Path $ClaudeDir ".ponytail-active"
$flagMode = $null
if (Test-Path $Flag) {
    try { $flagMode = (Get-Content $Flag -ErrorAction Stop | Select-Object -First 1).Trim().ToLowerInvariant() } catch {}
}
$ptMode = if ($startMode -eq "off") { "off" } elseif (@('lite', 'full', 'ultra') -contains $flagMode) { $flagMode } else { $startMode }
$ptLabel = if ($ptMode -eq "full" -or $ptMode -eq "off") { "PONYTAIL" } else { "PONYTAIL:$($ptMode.ToUpperInvariant())" }
$badgeParts += Format-Pill $ptLabel ($ptMode -ne "off") "38;5;108"

# --- ADHD --- plugin enabled for this session and its always-on flag present.
$adhdOn = (Test-PluginOn 'i-have-adhd@i-have-adhd') -and (Test-Path (Join-Path $ClaudeDir ".i-have-adhd-always"))
$badgeParts += Format-Pill "ADHD" $adhdOn "38;5;216"

$badgeLine = $badgeParts -join " "

# --- Rig lane only: guard shield and its project's active ticket with its age.
if ($seat) {
    if ($laneRaw -and $laneRaw -match 'guard\.cjs') {
        $badgeLine += " ${Esc}[2m$Dot${Esc}[0m ${Esc}[38;5;114m$Shield${Esc}[0m"
    }
    $awPath = Join-Path $projectDir "active-worktree"
    try {
        $aw = [IO.File]::ReadAllText($awPath).Trim()
        if ($aw) {
            $leaf = Split-Path -Leaf $aw
            $ticket = if ($prefix -and $leaf -match "^$([regex]::Escape($prefix))(\d+)-") { "$($prefix.ToUpperInvariant())-$($Matches[1])" } else { $leaf }
            $age = Format-Age ((Get-Date) - (Get-Item -LiteralPath $awPath).LastWriteTime)
            $badgeLine += " ${Esc}[2m$Dot${Esc}[0m ${Esc}[38;5;223m$ticket $age${Esc}[0m"
        }
    } catch {}
}

$lines = @()
if ($parts.Count -gt 0) { $lines += ($parts -join " ") }
$lines += $badgeLine
[Console]::Write(($lines -join "`n"))
