@echo off
rem Launch scripts/verify/key-probe.ts in its own console window (same WT-hosted
rem conhost path as launch-ts-bun.cmd; see that file for why the window is
rem started from a batch file).
start "kpt-keyprobe" cmd /k "chcp 65001>nul && cd /d %~dp0..\.. && bun --use-system-ca run scripts/verify/key-probe.ts 2> %~dp0..\..\key-probe.err.log"
