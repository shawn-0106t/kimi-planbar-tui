@echo off
rem Generic console-window launcher for the verify probes:
rem   launch-probe.cmd <window-title> <script-path-relative-to-ts>
rem Opens a WT-hosted console running the probe so real terminal input (Ctrl+C,
rem keypresses) can be injected. The window is started from a batch file because
rem WT's command-line handoff is broken on this machine and PowerShell 5.1
rem mis-quotes the nested command line.
start "%~1" cmd /k "chcp 65001>nul && cd /d C:\Users\rexxa\Documents\trae_projects\github\kimi-planbar-tui\ts && bun --use-system-ca run %~2"
