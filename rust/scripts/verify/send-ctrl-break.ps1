# send-ctrl-break.ps1 — REVIEW-RUST Minor 15 manual-acceptance probe.
# Sends CTRL_BREAK_EVENT to every process sharing this console after a delay,
# so a foreground TUI can be observed restoring (or stranding) its terminal.
# Usage (from a cmd window, BEFORE launching the TUI in the foreground):
#   start "" /b powershell -NoProfile -ExecutionPolicy Bypass -File send-ctrl-break.ps1 8
#   <path-to>\kimi-planbar-tui.exe
param([int]$DelaySeconds = 8)

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CtrlBreakProbe {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GenerateConsoleCtrlEvent(uint dwCtrlEvent, uint dwProcessGroupId);
}
'@

Start-Sleep -Seconds $DelaySeconds
# CTRL_BREAK_EVENT = 1; process group 0 = all processes sharing this console
# (the TUI, this helper, and the hosting cmd — the latter two just survive it).
[void][CtrlBreakProbe]::GenerateConsoleCtrlEvent(1, 0)
