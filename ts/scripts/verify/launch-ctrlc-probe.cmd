@echo off
rem Launch scripts/verify/ctrlc-default-mode.ts in its own console window.
start "kpt-ctrlc" cmd /k "chcp 65001>nul && cd /d %~dp0..\.. && bun --use-system-ca run scripts/verify/ctrlc-default-mode.ts 2> %~dp0..\..\ctrlc-probe.err.log"
