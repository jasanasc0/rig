# Self-check for statusline.ps1 (next to this file). Run: powershell -NoProfile -ExecutionPolicy Bypass -File <rig>\statusline.check.ps1
# A fake Claude folder and a fake rig folder in %TEMP% (removed in finally), and sample stdin. The fake rig holds a copy of statusline.ps1,
# which takes the rig as its own folder, example's profile and settings from this repo, and a second project, sample, made from them.
# Cases A-J are the v3 check's; K-T add the second project's lanes and the project rules of v4; U and V the fix wave's; W and X pam's
# lane in each project (review-pam M8).
$ErrorActionPreference = 'Stop'
# The script under test writes UTF-8 (the shield is an emoji); read its output as UTF-8 too, whatever console this check runs from
# (from Git Bash the default is the OEM code page, and the shield would be missed).
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$here = $PSScriptRoot
$fake = Join-Path ([IO.Path]::GetTempPath()) ('rig-statusline-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$saved = @{ CLAUDE_CONFIG_DIR = $env:CLAUDE_CONFIG_DIR; APPDATA = $env:APPDATA; PONYTAIL_DEFAULT_MODE = $env:PONYTAIL_DEFAULT_MODE }
$fails = 0
try {
    $claude = Join-Path $fake 'claude'; $rig = Join-Path $fake 'rig'; $appdata = Join-Path $fake 'appdata'
    New-Item -ItemType Directory -Force (Join-Path $claude 'hooks\gitnexus'), $appdata | Out-Null
    # The global settings this check needs: superpowers and ADHD on (a lane's own settings turn them off).
    Set-Content (Join-Path $claude 'settings.json') '{"enabledPlugins":{"superpowers@claude-plugins-official":true,"i-have-adhd@i-have-adhd":true}}' -Encoding ascii
    Set-Content (Join-Path $claude 'hooks\gitnexus\gitnexus-hook.cjs') '' -Encoding ascii
    Set-Content (Join-Path $claude '.i-have-adhd-always') '' -Encoding ascii
    # example only (this repo's), and sample: example's profile with its name, root, prefix and lanes changed, and example's settings files.
    foreach ($proj in 'example', 'sample') { New-Item -ItemType Directory -Force (Join-Path $rig "$proj\rules") | Out-Null }
    $exProfile = [IO.File]::ReadAllText((Join-Path $here 'example\profile.json'))
    [IO.File]::WriteAllText((Join-Path $rig 'example\profile.json'), $exProfile)
    [IO.File]::WriteAllText((Join-Path $rig 'sample\profile.json'), $exProfile.Replace('"example"', '"sample"').Replace('C:/example-project', 'C:/sample-project').Replace('"ex"', '"sm"').Replace('"ex-', '"sm-'))
    foreach ($proj in 'example', 'sample') { Copy-Item (Join-Path $here 'example\rules\*.settings.json') (Join-Path $rig "$proj\rules") }
    $aw = Join-Path $rig 'example\active-worktree'
    $pgAw = Join-Path $rig 'sample\active-worktree'

    # The script under test, unchanged, in the fake rig: it finds the profiles next to itself.
    $script = Join-Path $rig 'statusline.ps1'
    Copy-Item -LiteralPath (Join-Path $here 'statusline.ps1') -Destination $script

    $E = [char]27
    $color = @{ GITNEXUS = '38;5;75'; SUPERPOWERS = '38;5;141'; PONYTAIL = '38;5;108'; ADHD = '38;5;216' }
    $exDir = 'C:\\example-project'
    $pgDir = 'C:\\sample-project'

    # $pgText: what sample's active-worktree holds for this case (example's holds $awText).
    function Run($name, $json, $flag, $awText, $envMode, $expect, $pgText = '') {
        $flagPath = Join-Path $claude '.ponytail-active'
        if ($flag) { Set-Content $flagPath $flag -Encoding ascii } elseif (Test-Path $flagPath) { Remove-Item $flagPath }
        [IO.File]::WriteAllText($aw, $awText)
        [IO.File]::WriteAllText($pgAw, $pgText)
        (Get-Item $aw).LastWriteTime = (Get-Date).AddMinutes(-42)
        (Get-Item $pgAw).LastWriteTime = (Get-Date).AddMinutes(-7)
        $env:CLAUDE_CONFIG_DIR = $claude; $env:APPDATA = $appdata
        if ($envMode) { $env:PONYTAIL_DEFAULT_MODE = $envMode } else { Remove-Item Env:PONYTAIL_DEFAULT_MODE -ErrorAction SilentlyContinue }
        $out = $json | powershell -NoProfile -ExecutionPolicy Bypass -File $script
        $code = $LASTEXITCODE
        $out = ($out -join "`n")
        $got = @()
        foreach ($p in 'GITNEXUS', 'SUPERPOWERS', 'ADHD') {
            $got += if ($out.Contains("$E[$($color[$p])m[$p]")) { "$p=on" } elseif ($out.Contains("$E[38;5;240m[$p]")) { "$p=off" } else { "$p=?" }
        }
        if ($out -match "$E\[$([regex]::Escape($color.PONYTAIL))m\[(PONYTAIL[^\]]*)\]") { $got += "PONYTAIL=on:$($Matches[1])" }
        elseif ($out.Contains("$E[38;5;240m[PONYTAIL]")) { $got += "PONYTAIL=off" } else { $got += "PONYTAIL=?" }
        $got += if ($out.Contains([char]::ConvertFromUtf32(0x1F6E1))) { 'shield' } else { 'noshield' }
        $got += if ($out -cmatch '[A-Z]+-\d+ \d+m') { "ticket:$($Matches[0])" } elseif ($out -match "$E\[38;5;223m([^$E]+)$E") { "ticket:$($Matches[1])" } else { 'noticket' }
        $got += if ($out -match "$E\[([0-9;]+)mctx \d+%") { "ctx:$($Matches[1])" } else { 'noctx' }
        $got += "exit:$code"
        $g = $got -join ' '
        if ($g -eq $expect) { "ok    $name" } else { "FAIL  $name`n      want: $expect`n      got:  $g"; $script:fails++ }
    }

    $wt = 'C:\example-project\.claude\worktrees\ex567-login-copy'
    $pgWt = 'C:\sample-project\.claude\worktrees\sm12-page-copy'
    function J($sname, $cwd, $ctx) {
        $n = if ($sname) { "`"session_name`":`"$sname`"," } else { '' }
        "{$n`"workspace`":{`"current_dir`":`"$cwd`",`"project_dir`":`"$cwd`"},`"model`":{`"display_name`":`"Opus 5.5`"},`"context_window`":{`"used_percentage`":$ctx},`"cost`":{`"total_cost_usd`":1.5}}"
    }
    Run 'A this window'          (J '' 'C:\\work' 30) $null $wt $null 'GITNEXUS=on SUPERPOWERS=on ADHD=on PONYTAIL=on:PONYTAIL noshield noticket ctx:2 exit:0'
    Run 'B ex-orchestrator'      (J 'ex-orchestrator' $exDir 55) $null $wt $null 'GITNEXUS=on SUPERPOWERS=on ADHD=on PONYTAIL=on:PONYTAIL shield ticket:EX-567 42m ctx:38;5;221 exit:0'
    Run 'C ex-coder in worktree' (J 'ex-coder' ($exDir + '\\.claude\\worktrees\\ex567-login-copy') 80) 'full' $wt $null 'GITNEXUS=on SUPERPOWERS=off ADHD=off PONYTAIL=on:PONYTAIL shield ticket:EX-567 42m ctx:38;5;203 exit:0'
    Run 'D ex-angela'            (J 'ex-angela' $exDir 74) 'full' $wt $null 'GITNEXUS=on SUPERPOWERS=off ADHD=off PONYTAIL=off shield ticket:EX-567 42m ctx:38;5;221 exit:0'
    Run 'E ex-oscar'             (J 'ex-oscar' $exDir 49) $null $wt $null 'GITNEXUS=on SUPERPOWERS=off ADHD=off PONYTAIL=off shield ticket:EX-567 42m ctx:2 exit:0'
    Run 'F ex-coder name, not rig' (J 'ex-coder' 'C:\\work\\other-app' 30) $null $wt $null 'GITNEXUS=on SUPERPOWERS=on ADHD=on PONYTAIL=on:PONYTAIL noshield noticket ctx:2 exit:0'
    Run 'G ultra flag'           (J '' 'C:\\work' 30) 'ultra' $wt $null 'GITNEXUS=on SUPERPOWERS=on ADHD=on PONYTAIL=on:PONYTAIL:ULTRA noshield noticket ctx:2 exit:0'
    Run 'H ex-coder, no ticket'  (J 'ex-coder' $exDir 10) $null '' $null 'GITNEXUS=on SUPERPOWERS=off ADHD=off PONYTAIL=on:PONYTAIL shield noticket ctx:2 exit:0'
    Run 'I no stdin'             '' $null $wt $null 'GITNEXUS=on SUPERPOWERS=on ADHD=on PONYTAIL=on:PONYTAIL noshield noticket noctx exit:0'
    Run 'J env off, this window' (J '' 'C:\\work' 30) 'full' $wt 'off' 'GITNEXUS=on SUPERPOWERS=on ADHD=on PONYTAIL=off noshield noticket ctx:2 exit:0'
    # v4: the second project's lanes, recognised by their sm- names under sample's root, with sample's settings and its own ticket.
    Run 'K sm-orchestrator'          (J 'sm-orchestrator' $pgDir 55) $null $wt $null 'GITNEXUS=on SUPERPOWERS=on ADHD=on PONYTAIL=on:PONYTAIL shield ticket:SM-12 7m ctx:38;5;221 exit:0' $pgWt
    Run 'L sm-coder in worktree'     (J 'sm-coder' ($pgDir + '\\.claude\\worktrees\\sm12-page-copy') 80) 'full' $wt $null 'GITNEXUS=on SUPERPOWERS=off ADHD=off PONYTAIL=on:PONYTAIL shield ticket:SM-12 7m ctx:38;5;203 exit:0' $pgWt
    Run 'M sm-angela'                (J 'sm-angela' $pgDir 74) 'full' $wt $null 'GITNEXUS=on SUPERPOWERS=off ADHD=off PONYTAIL=off shield ticket:SM-12 7m ctx:38;5;221 exit:0' $pgWt
    Run 'N sm-oscar'                 (J 'sm-oscar' $pgDir 49) $null $wt $null 'GITNEXUS=on SUPERPOWERS=off ADHD=off PONYTAIL=off shield ticket:SM-12 7m ctx:2 exit:0' $pgWt
    Run 'O sm-coder, no sm ticket'   (J 'sm-coder' $pgDir 10) $null $wt $null 'GITNEXUS=on SUPERPOWERS=off ADHD=off PONYTAIL=on:PONYTAIL shield noticket ctx:2 exit:0' ''
    Run "P ex-coder (example's name) in sample" (J 'ex-coder' $pgDir 30) $null $wt $null 'GITNEXUS=on SUPERPOWERS=on ADHD=on PONYTAIL=on:PONYTAIL noshield noticket ctx:2 exit:0' $pgWt
    Run 'Q sm-coder in example'      (J 'sm-coder' $exDir 30) $null $wt $null 'GITNEXUS=on SUPERPOWERS=on ADHD=on PONYTAIL=on:PONYTAIL noshield noticket ctx:2 exit:0' $pgWt
    Run 'R example coder keeps EX while sample has SM' (J 'ex-coder' $exDir 30) $null $wt $null 'GITNEXUS=on SUPERPOWERS=off ADHD=off PONYTAIL=on:PONYTAIL shield ticket:EX-567 42m ctx:2 exit:0' $pgWt
    Run "S ex-coder in a folder that only starts like example's root" (J 'ex-coder' ($exDir + 'X') 30) $null $wt $null 'GITNEXUS=on SUPERPOWERS=on ADHD=on PONYTAIL=on:PONYTAIL noshield noticket ctx:2 exit:0'
    Run 'T sm-orchestrator, other worktree name shown as is' (J 'sm-orchestrator' $pgDir 30) $null $wt $null 'GITNEXUS=on SUPERPOWERS=on ADHD=on PONYTAIL=on:PONYTAIL shield ticket:scratch-x 7m ctx:2 exit:0' 'C:\sample-project\.claude\worktrees\scratch-x'
    # review-pam M8: pam's lane (lanes.pam: example's ex-pam, sample's sm-pam) shows its shield and its project's ticket, with pam's settings.
    Run 'W ex-pam'                   (J 'ex-pam' $exDir 49) $null $wt $null 'GITNEXUS=on SUPERPOWERS=off ADHD=off PONYTAIL=off shield ticket:EX-567 42m ctx:2 exit:0' $pgWt
    Run 'X sm-pam'                   (J 'sm-pam' $pgDir 49) $null $wt $null 'GITNEXUS=on SUPERPOWERS=off ADHD=off PONYTAIL=off shield ticket:SM-12 7m ctx:2 exit:0' $pgWt
    # Fix wave: a ticket prefix with a regex character is matched as text (P7-M1; the guard would refuse such a profile, the status line
    # reads profiles on its own), and a broken profile.json beside the real ones changes nothing (P7-M3: the same output as B).
    New-Item -ItemType Directory -Force (Join-Path $rig 'cpp\rules') | Out-Null
    [IO.File]::WriteAllText((Join-Path $rig 'cpp\profile.json'), '{"name":"cpp","root":"C:/work/cpp-fake","ticketPrefix":"c+","lanes":{"orchestrator":"cpp-orchestrator","coder":"cpp-coder","angela":"cpp-angela","oscar":"cpp-oscar"}}')
    Copy-Item (Join-Path $here 'example\rules\orchestrator.settings.json') (Join-Path $rig 'cpp\rules')
    $cppAw = Join-Path $rig 'cpp\active-worktree'
    [IO.File]::WriteAllText($cppAw, 'C:\work\cpp-fake\.claude\worktrees\c+12-x')
    (Get-Item $cppAw).LastWriteTime = (Get-Date).AddMinutes(-3)
    Run 'U a prefix with a regex character (c+)' (J 'cpp-orchestrator' 'C:\\work\\cpp-fake' 30) $null $wt $null 'GITNEXUS=on SUPERPOWERS=on ADHD=on PONYTAIL=on:PONYTAIL shield ticket:C+-12 3m ctx:2 exit:0'
    New-Item -ItemType Directory -Force (Join-Path $rig 'aaa-broken') | Out-Null
    [IO.File]::WriteAllText((Join-Path $rig 'aaa-broken\profile.json'), '{ "name": "aaa-broken", "lanes": ')
    Run 'V a broken profile.json beside the real ones: as B' (J 'ex-orchestrator' $exDir 55) $null $wt $null 'GITNEXUS=on SUPERPOWERS=on ADHD=on PONYTAIL=on:PONYTAIL shield ticket:EX-567 42m ctx:38;5;221 exit:0'
} finally {
    foreach ($k in $saved.Keys) { if ($null -eq $saved[$k]) { Remove-Item "Env:$k" -ErrorAction SilentlyContinue } else { Set-Item "Env:$k" $saved[$k] } }
    if (Test-Path -LiteralPath $fake) { Remove-Item -LiteralPath $fake -Recurse -Force }
}
if (Test-Path -LiteralPath $fake) { "FAIL  the temp folder $fake is still there"; $fails++ }
if ($fails) { "$fails check(s) failed"; exit 1 } else { 'all checks passed' }
