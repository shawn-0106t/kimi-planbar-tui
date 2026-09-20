@echo off
rem Launch the ts/ (Bun + OpenTUI) TUI in a plain console window for the SPEC 20
rem real-terminal round (C-1: does Ctrl+C quit, and is the terminal restored).
rem WT's command-line handoff is broken on this machine (it treats the argument
rem string as the exe name), and PowerShell 5.1 mis-quotes the nested command
rem line, so the window is started from a cmd batch file.
rem chcp 65001 first per the README baseline for legacy conhost.
start "kpt-ts-bun" cmd /k "chcp 65001>nul && cd /d C:\Users\rexxa\Documents\trae_projects\github\kimi-planbar-tui\ts && bun --use-system-ca run src/main.ts 2> C:\Users\rexxa\Documents\trae_projects\github\kimi-planbar-tui\ts\tui-launch.err.log"
