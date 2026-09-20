# Check whether the TUI node process is running (started via cmd /k in the new WT window).
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  ForEach-Object { "{0} | {1}" -f $_.ProcessId, $_.CommandLine }
Write-Output "--- cmd.exe hosting it:"
Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" |
  Where-Object { $_.CommandLine -like "*ts-nodejs*" } |
  ForEach-Object { "{0} | {1}" -f $_.ProcessId, $_.CommandLine }
