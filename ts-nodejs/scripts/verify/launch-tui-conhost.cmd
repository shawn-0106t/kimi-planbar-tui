@echo off
rem Launch the ts-nodejs TUI in a plain conhost window (WT CLI handoff is broken
rem on this machine: it tries to execute the literal string "new-window").
rem chcp 65001 first per the README baseline for legacy conhost.
start "kpt-nodejs" cmd /k "chcp 65001>nul && cd /d C:\Users\rexxa\Documents\trae_projects\github\kimi-planbar-tui\ts-nodejs && node --use-system-ca src/main.ts 2> C:\Users\rexxa\Documents\trae_projects\github\kimi-planbar-tui\ts-nodejs\tui-launch.err.log"
