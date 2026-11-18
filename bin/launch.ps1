# launch.ps1 - start the shift in one go (README, Daily use). The Desktop shortcut (README, Daily use) runs it:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File <rig>\bin\launch.ps1
# 1. herdr's server: when herdr says server_not_running, a Windows Terminal window with herdr starts it (herdr's API never starts one) in
#    the rig folder, so the default space herdr makes is labelled after it (rig): that one is free to use.
# 2. Each project (a rig folder with a profile.json) whose orchestrator is not running gets `& '<rig>\bin\rig.ps1' <project>` typed into a
#    free pane, as you would by hand: the one pane of a space labelled with its name, else that free default space, else a space made for it.
#    rig.ps1 then names the space, opens its seats tab and starts the orchestrator, which starts its lanes.
# 3. The rig view (rigview.mjs) starts the same way in a space labelled view, unless a pane there already runs it; that space gets focus.
# 4. A window: the one from step 1, or a new one attached to the running server.
# A pane is free when no agent runs in it and only its shell is in the foreground (herdr pane process-info). It only adds: it never closes,
# stops or kills anything, and never types into a pane that is not free, nor into a space you made for your own shell. One launch at a time
# (a named mutex). A herdr failure warns and skips what needs its answer; with a warning it waits for Enter so you can read it. The owner's own:
# the guard keeps every seat's shell off this file. launch.selftest.ps1 checks it against the fake herdr. -NoWait (the self-test) skips
# the wait at the end.
param([switch]$NoWait)
$rig = Split-Path -Parent $PSScriptRoot
$script:warned = 0
function Say-Warning($text) { Write-Warning $text; $script:warned++ }
# One launch at a time (review, Critical 1): two double-clicks would both see no rig running and start every rig twice. Held to the end.
$lock = New-Object Threading.Mutex($false, 'Local\rig-launch')
try { $mine = $lock.WaitOne(0) } catch [Threading.AbandonedMutexException] { $mine = $true } # a launch that died still released it
if (-not $mine) { Say-Warning 'another launch.ps1 is already running (a second double-click?); this one does nothing' }
else {
  try {
    # Invoke-Herdr: one herdr call, its result and what herdr answered (herdr.ps1, shared with rig.ps1, lanes.ps1 and close.ps1).
    . (Join-Path $PSScriptRoot 'herdr.ps1')
    function Get-Snapshot { $r = Invoke-Herdr api snapshot; [pscustomobject]@{ Snap = $r.Result.snapshot; Says = $r.Says } }
    # Callers wrap these in @(): PowerShell unrolls a one-item array on return, and a lone JSON object has no .Count in Windows PowerShell 5.1.
    function PanesOf($space) { @($snap.panes | Where-Object { $_.workspace_id -ceq $space }) }
    # Only entries with an argv0: a failed call gives $null, which @() would turn into one empty entry that passes every test (re-review A).
    function Get-Foreground($pane) { @((Invoke-Herdr pane process-info --pane $pane).Result.process_info.foreground_processes | Where-Object { $_ -and $_.argv0 }) }
    # Free: no agent in it (snapshot agents[]; herdr's panes carry no agent field for a shell) and only a shell in its foreground. A pane
    # herdr can't describe is not free.
    function Test-Free($pane) {
      if ($agentPanes -contains $pane) { return $false }
      $fg = @(Get-Foreground $pane)
      $fg.Count -gt 0 -and @($fg | Where-Object { (Split-Path -Leaf "$($_.argv0)") -notmatch '^(powershell|pwsh|cmd)(\.exe)?$' }).Count -eq 0
    }
    function Open-Window {
      try { & wt -w new -d $rig herdr; 'opened a Windows Terminal window with herdr' }
      catch { Say-Warning "could not open a Windows Terminal window with herdr ($($_.Exception.Message)); open herdr by hand" }
    }

    $projects = @(Get-ChildItem -LiteralPath $rig -Directory | Sort-Object Name | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'profile.json') -PathType Leaf } | ForEach-Object {
        $p = Get-Content -LiteralPath (Join-Path $_.FullName 'profile.json') -Raw | ConvertFrom-Json
        # Without its trailing backslash: Windows PowerShell 5.1 would pass 'C:\x\my root\' as `C:\x\my root" --label ...` (one word).
        [pscustomobject]@{ Name = $p.name; Lane = $p.lanes.orchestrator; Root = ($p.root -replace '/', '\').TrimEnd('\') }
      })

    $s = Get-Snapshot
    $opened = $false
    $spare = @()
    if (-not $s.Snap) {
      # Only herdr's own "no server" starts one (review, Important 3): any other failure may be your running server, whose spaces are yours.
      if ($s.Says -notmatch 'server_not_running') { throw "herdr did not give its state, so nothing was started: $($s.Says)" }
      "herdr's server is not running; starting it with a window"
      Open-Window
      $opened = $true
      $until = (Get-Date).AddSeconds(30)
      # Until the server answers with the default space the new window's herdr makes as it attaches.
      while ((-not $s.Snap -or -not @($s.Snap.workspaces).Count) -and (Get-Date) -lt $until) { Start-Sleep -Milliseconds 500; $s = Get-Snapshot }
      if (-not $s.Snap) { throw "herdr's server did not answer within 30 s ($($s.Says)); nothing was started" }
      $snap = $s.Snap
      $agentPanes = @($snap.agents | ForEach-Object { $_.pane_id })
      # The default space this window made: labelled after the rig folder (wt -d), one free pane.
      $spare = @($snap.workspaces | Where-Object { $_.label -ceq (Split-Path -Leaf $rig) } | ForEach-Object {
          $in = @(PanesOf $_.workspace_id)
          if ($in.Count -eq 1 -and (Test-Free $in[0].pane_id)) { [pscustomobject]@{ Space = $_.workspace_id; Pane = $in[0].pane_id } }
        } | Select-Object -First 1)
    }
    $snap = $s.Snap
    $agentPanes = @($snap.agents | ForEach-Object { $_.pane_id })

    # The pane to type into for a space labelled $label: the one free pane of that space, the free default space, or a new space. $null
    # (said why) when a space of that label holds anything else, which you sort out by hand.
    function Get-Pane($label, $cwd) {
      $own = @($snap.workspaces | Where-Object { $_.label -ceq $label })
      if ($own.Count) {
        $in = @(PanesOf $own[0].workspace_id)
        if ($own.Count -eq 1 -and $in.Count -eq 1 -and (Test-Free $in[0].pane_id)) { return [pscustomobject]@{ Space = $own[0].workspace_id; Pane = $in[0].pane_id; Line = "its space $($own[0].workspace_id)" } }
        Say-Warning "${label}: $($own.Count) space(s) labelled $label ($(@($own | ForEach-Object { $_.workspace_id }) -join ', ')), the first with $($in.Count) pane(s), not one free pane: not touched; start it there by hand"
        return $null
      }
      if ($script:spare.Count) {
        $sp = $script:spare[0]
        $script:spare = @()
        return [pscustomobject]@{ Space = $sp.Space; Pane = $sp.Pane; Line = "herdr's new default space $($sp.Space)" }
      }
      $r = Invoke-Herdr workspace create --cwd $cwd --label $label --no-focus
      $pane = $r.Result.root_pane.pane_id
      $space = $r.Result.workspace.workspace_id
      if (-not $pane -or -not $space) { Say-Warning "${label}: herdr workspace create gave no space or pane, so nothing was started: $($r.Says)"; return $null }
      [pscustomobject]@{ Space = $space; Pane = $pane; Line = "a new space $space" }
    }
    # One command typed into the pane (herdr pane run: the text and Enter); its line, and $script:sent says whether herdr took it.
    function Send-Line($label, $at, $command) {
      $r = Invoke-Herdr pane run $at.Pane $command
      $script:sent = $r.Ok
      if ($r.Ok) { "${label}: typed $command into $($at.Pane) ($($at.Line))" } else { Say-Warning "${label}: herdr pane run did not take $command in $($at.Pane): $($r.Says)" }
    }

    foreach ($p in $projects) {
      $running = @($snap.agents | Where-Object { $_.name -ceq $p.Lane -or (-not $_.name -and $_.terminal_title_stripped -ceq $p.Lane) })
      if ($running.Count) { "$($p.Name): its orchestrator runs (in $($running[0].pane_id)), left alone"; continue }
      $at = Get-Pane $p.Name $p.Root
      if ($at) { Send-Line $p.Name $at "& '$rig\bin\rig.ps1' $($p.Name)" }
    }

    # The view runs when a pane of a view space has rigview.mjs in its foreground (herdr shows no title for a pane without an agent).
    $view = @($snap.workspaces | Where-Object { $_.label -ceq 'view' } | ForEach-Object { PanesOf $_.workspace_id } | Where-Object {
        @(Get-Foreground $_.pane_id | Where-Object { "$($_.cmdline)" -match 'rigview\.mjs' }).Count })
    $viewSpace = $null
    if ($view.Count) { "view: runs (in $($view[0].pane_id)), left alone"; $viewSpace = $view[0].workspace_id }
    else {
      $at = Get-Pane 'view' $rig
      if ($at) {
        Send-Line 'view' $at "node '$rig\bin\rigview.mjs'"
        if ($script:sent) { $viewSpace = $at.Space }
      }
    }
    if ($viewSpace) {
      $r = Invoke-Herdr workspace focus $viewSpace
      if ($r.Ok) { "focused the view space $viewSpace" } else { Say-Warning "herdr workspace focus did not focus $($viewSpace): $($r.Says)" }
    }
    if (-not $opened) { Open-Window }
  } catch {
    Say-Warning $_.Exception.Message
  } finally {
    Remove-Item Function:\Invoke-Herdr, Function:\Get-Snapshot, Function:\PanesOf, Function:\Get-Foreground, Function:\Test-Free, Function:\Open-Window, Function:\Get-Pane, Function:\Send-Line -ErrorAction SilentlyContinue
  }
}
if (-not $NoWait) { if ($script:warned) { $null = Read-Host 'Something above needs a look. Press Enter to close' } else { Start-Sleep -Seconds 3 } }
if ($mine) { $lock.ReleaseMutex() }
if ($script:warned) { exit 1 }
