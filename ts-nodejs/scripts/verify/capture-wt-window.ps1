# Capture a window to a PNG, by HWND (preferred) or process+title substring.
# Usage: powershell -File capture-wt-window.ps1 -Hwnd 2165230 -Out shot.png [-Keys "s"]
param(
  [long]$Hwnd = 0,
  [string]$TitleContains = "",
  [string]$ProcessName = "WindowsTerminal",
  [string]$Out = "wt-capture.png",
  [string]$Keys = "",
  [switch]$UsePrintWindow
)
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing
Add-Type -Name User32 -Namespace Win32Cap -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr h, out RECT r);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int cmd);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsWindow(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool PrintWindow(System.IntPtr h, System.IntPtr hdc, uint flags);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint pid);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr h, System.IntPtr after, int x, int y, int cx, int cy, uint flags);
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
'@
Add-Type -Name Shcore -Namespace Win32Cap -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int v);
'@
[Win32Cap.Shcore]::SetProcessDpiAwareness(2) | Out-Null

$hwnd = [System.IntPtr]::Zero
if ($Hwnd -ne 0) {
  $hwnd = [System.IntPtr]$Hwnd
  if (-not [Win32Cap.User32]::IsWindow($hwnd)) { Write-Error "not a window: $Hwnd"; exit 1 }
} else {
  $proc = Get-Process $ProcessName |
    Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*$TitleContains*" } |
    Select-Object -First 1
  if (-not $proc) { Write-Error "no window: process=$ProcessName title~$TitleContains"; exit 1 }
  $hwnd = $proc.MainWindowHandle
}

# Foreground-lock workaround: attach to the current foreground thread first.
function Force-Foreground($h) {
  [Win32Cap.User32]::ShowWindow($h, 9) | Out-Null   # SW_RESTORE
  $fg = [Win32Cap.User32]::GetForegroundWindow()
  $fgPid = 0
  $fgThread = [Win32Cap.User32]::GetWindowThreadProcessId($fg, [ref]$fgPid)
  $cur = [Win32Cap.User32]::GetCurrentThreadId()
  [Win32Cap.User32]::AttachThreadInput($cur, $fgThread, $true) | Out-Null
  [Win32Cap.User32]::SetForegroundWindow($h) | Out-Null
  [Win32Cap.User32]::AttachThreadInput($cur, $fgThread, $false) | Out-Null
  Start-Sleep -Milliseconds 600
}
if ($Keys -ne "") {
  Force-Foreground $hwnd
  if ([Win32Cap.User32]::GetForegroundWindow() -ne $hwnd) {
    Write-Error "foreground failed; refusing to SendKeys into the wrong window"
    exit 1
  }
  $wshell = New-Object -ComObject WScript.Shell
  $wshell.SendKeys($Keys)
  Start-Sleep -Milliseconds 800   # let the TUI redraw
}

$r = New-Object "Win32Cap.User32+RECT"
[Win32Cap.User32]::GetWindowRect($hwnd, [ref]$r) | Out-Null
$w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
if ($w -le 0 -or $h -le 0) { Write-Error "bad rect ${w}x${h}"; exit 1 }
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
if ($UsePrintWindow) {
  # Capture the window directly (works when it is behind other windows).
  $hdc = $g.GetHdc()
  $ok = [Win32Cap.User32]::PrintWindow($hwnd, $hdc, 2)  # PW_RENDERFULLCONTENT
  $g.ReleaseHdc($hdc)
  if (-not $ok) { Write-Error "PrintWindow failed"; exit 1 }
} else {
  # SetForegroundWindow is blocked by the foreground lock for non-interactive
  # callers; instead float the target above everything (no focus change),
  # capture, then unfloat.
  $HWND_TOPMOST = [System.IntPtr](-1); $HWND_NOTOPMOST = [System.IntPtr](-2)
  $SWP = 0x0001 -bor 0x0002  # NOSIZE | NOMOVE
  [Win32Cap.User32]::ShowWindow($hwnd, 9) | Out-Null   # SW_RESTORE
  [Win32Cap.User32]::SetWindowPos($hwnd, $HWND_TOPMOST, 0, 0, 0, 0, $SWP) | Out-Null
  Start-Sleep -Milliseconds 700
  $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
  [Win32Cap.User32]::SetWindowPos($hwnd, $HWND_NOTOPMOST, 0, 0, 0, 0, $SWP) | Out-Null
}
$bmp.Save((Resolve-Path .).Path + "\" + $Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "captured: $Out (${w}x${h})"
