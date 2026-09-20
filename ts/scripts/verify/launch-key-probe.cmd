@echo off
rem Launch scripts/verify/key-probe.ts in its own console window (same WT-hosted
rem conhost path as launch-ts-bun.cmd; see that file for why the window is
rem started from a batch file).
start "kpt-keyprobe" cmd /k "chcp 65001>nul && cd /d C:\Users\rexxa\Documents\trae_projects\github\kimi-planbar-tui\ts && bun --use-system-ca run scripts/verify/key-probe.ts 2> C:\Users\rexxa\Documents\trae_projects\github\kimi-planbar-tui\ts\key-probe.err.log"
