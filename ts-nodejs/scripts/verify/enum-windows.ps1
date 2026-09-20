# Enumerate all visible top-level windows: hwnd, pid, title.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -Name EnumWin -Namespace Win32Enum -MemberDefinition @'
public delegate bool EnumProc(System.IntPtr h, System.IntPtr l);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, System.IntPtr l);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode)] public static extern int GetWindowTextW(System.IntPtr h, System.Text.StringBuilder sb, int n);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint pid);
'@
$script:rows = New-Object System.Collections.Generic.List[string]
$cb = [Win32Enum.EnumWin+EnumProc]{
  param($h, $l)
  if ([Win32Enum.EnumWin]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 512
    [void][Win32Enum.EnumWin]::GetWindowTextW($h, $sb, 512)
    $procId = 0
    [void][Win32Enum.EnumWin]::GetWindowThreadProcessId($h, [ref]$procId)
    if ($sb.Length -gt 0) { $script:rows.Add(("{0} | pid={1} | {2}" -f $h.ToInt64(), $procId, $sb.ToString())) }
  }
  return $true
}
[void][Win32Enum.EnumWin]::EnumWindows($cb, [System.IntPtr]::Zero)
$script:rows | ForEach-Object { $_ }
