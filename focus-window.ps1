# Put the browser in front of the user after a workspace was opened.
#
# A page cannot do this itself: browsers refuse cross-application focus, so
# window.focus() in the GUI can never raise its own browser window. The
# permission lives in the process the user's own action started, which is why
# `dsh-open` (launched by the shell or the Explorer context menu) calls this.
#
# The window title is the only reliable handle: a browser exposes the title of
# the ACTIVE tab only, so a match means a window is showing the GUI right now.
# Several windows can belong to one browser process, so matching by process
# alone would raise the wrong one.
#
# Raising a window that belongs to another process is refused by the Windows
# foreground lock whenever this process did not start from the current foreground
# chain — which is exactly the case behind a context menu. The ladder below tries
# the documented escapes in order and, when none of them takes focus, still lifts
# the window to the top of the Z-order: a window in front is what the caller
# wants, and opening another tab instead is far worse, because every tab holds a
# permanent HTTP connection against the page's per-origin budget.
#
# Mode `auto` looks for a window, waiting up to `-WaitSeconds` for one to appear
# because a page that is still loading has no title yet, and opens `-OpenUrl`
# only when no window shows the GUI at all. Mode `tab` always opens it.
#
# Exit codes: 0 raised and focused, 5 brought to the front without focus,
# 4 opened a tab, 3 matched but could not be brought forward and no URL was
# given, 2 nothing matched and no URL was given.

param(
  # Substring of the window title. The Web UI titles itself "<session> - DeepSeek Harness".
  [string]$TitleLike = 'DeepSeek Harness',
  # Browsers only, so a document or editor window cannot be raised by accident.
  [string[]]$ProcessNames = @('chrome', 'msedge', 'firefox', 'brave', 'vivaldi', 'opera', 'chromium', 'arc', 'iexplore'),
  [ValidateSet('auto', 'tab')][string]$Mode = 'auto',
  # Opened when no window can be raised: the GUI URL.
  [string]$OpenUrl = '',
  # How long to keep looking for a window whose page is still loading.
  [int]$WaitSeconds = 0
)

$ErrorActionPreference = 'Stop'

# Start the GUI in a new browser tab. Returns whether a URL was opened and
# writes nothing else, so a caller can use the result as a condition.
function Open-GuiTab {
  if ($OpenUrl -eq '') { return $false }
  Start-Process -FilePath $OpenUrl
  return $true
}

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class FocusWindow {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr param);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr param);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool join);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hwnd, bool altTab);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
"@

# Every visible top-level browser window whose title shows the GUI. Returns one
# array: the enumeration callback adds to a list and writes nothing itself.
function Find-GuiWindows {
  $found = New-Object System.Collections.Generic.List[object]
  $callback = [FocusWindow+EnumProc]{
    param([IntPtr]$hwnd, [IntPtr]$param)
    if (-not [FocusWindow]::IsWindowVisible($hwnd)) { return $true }
    $buffer = New-Object System.Text.StringBuilder 512
    [void][FocusWindow]::GetWindowTextW($hwnd, $buffer, $buffer.Capacity)
    $title = $buffer.ToString()
    if ($title -eq '' -or $title -notlike "*$TitleLike*") { return $true }
    $owner = 0
    [void][FocusWindow]::GetWindowThreadProcessId($hwnd, [ref]$owner)
    $name = try { (Get-Process -Id $owner -ErrorAction Stop).ProcessName } catch { '' }
    if ($ProcessNames -notcontains $name) { return $true }
    $found.Add([pscustomobject]@{
      Hwnd = $hwnd
      Pid = $owner
      Process = $name
      Title = $title
      Minimized = [FocusWindow]::IsIconic($hwnd)
    })
    return $true
  }
  [void][FocusWindow]::EnumWindows($callback, [IntPtr]::Zero)
  return $found.ToArray()
}

# Take the foreground for one window, using every escape the foreground lock
# allows. Returns true only when the window really is the foreground window; the
# last step lifts it to the top of the Z-order either way, which is reported
# separately because it is still visible to the user.
function Invoke-Raise {
  param([IntPtr]$Hwnd, [bool]$Minimized)

  $foreground = [FocusWindow]::GetForegroundWindow()
  $foregroundThread = 0
  [void][FocusWindow]::GetWindowThreadProcessId($foreground, [ref]$foregroundThread)
  $thisThread = [FocusWindow]::GetCurrentThreadId()
  # Joining the foreground thread's input queue is what lets a background process
  # take the foreground; without it SetForegroundWindow only flashes the taskbar.
  $joined = $false
  if ($foregroundThread -ne 0 -and $foregroundThread -ne $thisThread) {
    $joined = [FocusWindow]::AttachThreadInput($thisThread, $foregroundThread, $true)
  }
  # A synthetic ALT keystroke marks this thread as user-driven, which is the
  # documented way past the lock that refuses SetForegroundWindow otherwise.
  [FocusWindow]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
  try {
    if ($Minimized) { [void][FocusWindow]::ShowWindow($Hwnd, 9) }  # SW_RESTORE
    [void][FocusWindow]::BringWindowToTop($Hwnd)
    [void][FocusWindow]::SetForegroundWindow($Hwnd)
    if ([FocusWindow]::GetForegroundWindow() -ne $Hwnd) {
      # A minimize/restore cycle counts as user activity for this window.
      [void][FocusWindow]::ShowWindow($Hwnd, 6)  # SW_MINIMIZE
      [void][FocusWindow]::ShowWindow($Hwnd, 9)  # SW_RESTORE
      [void][FocusWindow]::SetForegroundWindow($Hwnd)
    }
    if ([FocusWindow]::GetForegroundWindow() -ne $Hwnd) {
      # The Alt+Tab primitive is not subject to the same lock.
      [FocusWindow]::SwitchToThisWindow($Hwnd, $true)
    }
  } finally {
    [FocusWindow]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)  # KEYEVENTF_KEYUP
    if ($joined) { [void][FocusWindow]::AttachThreadInput($thisThread, $foregroundThread, $false) }
  }
  if ([FocusWindow]::GetForegroundWindow() -eq $Hwnd) { return $true }

  # Focus was refused. Lifting the window above every other window still puts it
  # in front of the user, and a topmost pulse leaves no lasting state behind.
  [void][FocusWindow]::SetWindowPos($Hwnd, [IntPtr](-1), 0, 0, 0, 0, 0x43)  # HWND_TOPMOST, NOMOVE|NOSIZE|SHOWWINDOW
  Start-Sleep -Milliseconds 120
  [void][FocusWindow]::SetWindowPos($Hwnd, [IntPtr](-2), 0, 0, 0, 0, 0x43)  # HWND_NOTOPMOST
  return $false
}

$windows = @()
if ($Mode -eq 'auto') {
  $deadline = (Get-Date).AddSeconds($WaitSeconds)
  while ($true) {
    $windows = @(Find-GuiWindows)
    if ($windows.Count -gt 0 -or (Get-Date) -ge $deadline) { break }
    Start-Sleep -Milliseconds 250
  }
}

if ($windows.Count -gt 0) {
  # Prefer a window that is already on screen; otherwise the first match.
  $target = $windows | Where-Object { -not $_.Minimized } | Select-Object -First 1
  if ($null -eq $target) { $target = $windows[0] }

  if (Invoke-Raise -Hwnd $target.Hwnd -Minimized $target.Minimized) {
    Write-Output "focus-window: raised pid $($target.Pid) '$($target.Title)'"
    exit 0
  }
  Write-Output "focus-window: pid $($target.Pid) '$($target.Title)' could not take focus; brought it to the front"
  exit 5
}

if ($Mode -eq 'auto') {
  Write-Output "focus-window: no $($ProcessNames -join '/') window titled like '*$TitleLike*' (waited ${WaitSeconds}s)"
}
if (Open-GuiTab) {
  Write-Output "focus-window: opened $OpenUrl"
  exit 4
}
exit 2
