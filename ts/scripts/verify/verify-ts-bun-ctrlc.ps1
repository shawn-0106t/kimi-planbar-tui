# C-1 measurement tool for the ts/ (Bun) edition (SPEC 22.6): launch the TUI in a
# console window, inject Ctrl+C, and report whether the process died and whether
# the terminal came back. Run it AFTER ts/scripts/verify/launch-ts-bun.cmd.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File verify-ts-bun-ctrlc.ps1
#
# It measures, it does not assert: the registered conclusion is that Bun/Windows
# swallows the Ctrl+C console event, so `quit-clean=False` is the EXPECTED output
# for the Bun edition (the Rust edition quits). Emits three PNGs next to itself
# (1-before, 2-after-ctrlc, 3-after-echo) plus a text report on stdout. SendKeys
# only reaches the focused window, so the script refuses to type unless it
# actually owns the foreground.
param(
  [string]$Title = "kpt-ts-bun",
  [string]$MainScript = "src/main.ts"
)
$ErrorActionPreference = "Stop"
$here = (Resolve-Path .).Path

Add-Type -AssemblyName System.Drawing
Add-Type -Name U32 -Namespace Vfy -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr h, out RECT r);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int cmd);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsWindow(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint pid);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr h, System.IntPtr after, int x, int y, int cx, int cy, uint flags);
[System.Runtime.InteropServices.DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int v);
[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
'@
[Vfy.U32]::SetProcessDpiAwareness(2) | Out-Null

function Find-Window {
  Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*$Title*" } |
    Select-Object -First 1
}

function Get-Tui {
  Get-CimInstance Win32_Process -Filter "Name='bun.exe'" |
    Where-Object { $_.CommandLine -like "*$MainScript*" }
}

function Force-Foreground($h) {
  [Vfy.U32]::ShowWindow($h, 9) | Out-Null
  $fg = [Vfy.U32]::GetForegroundWindow()
  $fgPid = 0
  $fgThread = [Vfy.U32]::GetWindowThreadProcessId($fg, [ref]$fgPid)
  $cur = [Vfy.U32]::GetCurrentThreadId()
  [Vfy.U32]::AttachThreadInput($cur, $fgThread, $true) | Out-Null
  [Vfy.U32]::SetForegroundWindow($h) | Out-Null
  [Vfy.U32]::AttachThreadInput($cur, $fgThread, $false) | Out-Null
  Start-Sleep -Milliseconds 600
}

function Send($keys) {
  $wshell = New-Object -ComObject WScript.Shell
  $wshell.SendKeys($keys)
  Start-Sleep -Milliseconds 900
}

function Shot($hwnd, $name) {
  $r = New-Object "Vfy.U32+RECT"
  [Vfy.U32]::GetWindowRect($hwnd, [ref]$r) | Out-Null
  $w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
  if ($w -le 0 -or $h -le 0) { Write-Output "shot $name skipped: bad rect"; return }
  $TOPMOST = [System.IntPtr](-1); $NOTOPMOST = [System.IntPtr](-2)
  [Vfy.U32]::SetWindowPos($hwnd, $TOPMOST, 0, 0, 0, 0, 0x0001 -bor 0x0002) | Out-Null
  Start-Sleep -Milliseconds 500
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
  $path = Join-Path $here $name
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  [Vfy.U32]::SetWindowPos($hwnd, $NOTOPMOST, 0, 0, 0, 0, 0x0001 -bor 0x0002) | Out-Null
  Write-Output "shot: $path (${w}x${h})"
}

$proc = Find-Window
if (-not $proc) { Write-Output "FAIL: no window titled *$Title* (run launch-ts-bun.cmd first)"; exit 1 }
$hwnd = $proc.MainWindowHandle
Write-Output "window: hwnd=$hwnd title='$($proc.MainWindowTitle)'"

$before = @(Get-Tui)
Write-Output ("tui procs before: " + (($before | ForEach-Object { $_.ProcessId }) -join ","))
if ($before.Count -eq 0) { Write-Output "FAIL: no bun process running $MainScript"; exit 1 }
Shot $hwnd "1-before.png"

Force-Foreground $hwnd
if ([Vfy.U32]::GetForegroundWindow() -ne $hwnd) {
  Write-Output "FAIL: refused to send keys - window is not foreground"; exit 1
}
Send "^(c)"
Start-Sleep -Milliseconds 1500
$after = @(Get-Tui)
Write-Output ("tui procs after Ctrl+C: " + $(if ($after.Count) { ($after | ForEach-Object { $_.ProcessId }) -join "," } else { "none" }))
Shot $hwnd "2-after-ctrlc.png"

# A restored terminal answers: with raw mode left on, or the app still grabbing
# input, this line never appears on its own line below a live prompt.
Send "echo RESTORED-OK{ENTER}"
Shot $hwnd "3-after-echo.png"

$err = Join-Path (Split-Path $here -Parent) "tui-launch.err.log"
if (Test-Path $err) {
  $len = (Get-Item $err).Length
  Write-Output "stderr log: $len bytes"
  if ($len -gt 0) { Get-Content $err -TotalCount 12 | ForEach-Object { Write-Output "  | $_" } }
}
Write-Output ("RESULT: quit-clean=" + ($after.Count -eq 0))
