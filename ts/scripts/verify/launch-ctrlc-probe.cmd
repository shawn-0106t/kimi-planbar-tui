@echo off
rem Launch scripts/verify/ctrlc-default-mode.ts in its own console window.
start "kpt-ctrlc" cmd /k "chcp 65001>nul && cd /d C:\Users\rexxa\Documents\trae_projects\github\kimi-planbar-tui\ts && bun --use-system-ca run scripts/verify/ctrlc-default-mode.ts 2> C:\Users\rexxa\Documents\trae_projects\github\kimi-planbar-tui\ts\ctrlc-probe.err.log"
