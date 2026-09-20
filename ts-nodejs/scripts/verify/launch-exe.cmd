@echo off
rem Launch the packaged SEA exe in a new window (WT hosts it via default-terminal).
start "kpt-exe" cmd /k "chcp 65001>nul && C:\Users\rexxa\Documents\trae_projects\github\kimi-planbar-tui\ts-nodejs\dist\kpt-tui-node.exe"
