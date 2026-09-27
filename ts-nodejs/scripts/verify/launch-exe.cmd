@echo off
rem Launch the packaged SEA exe in a new window (WT hosts it via default-terminal).
start "kpt-exe" cmd /k "chcp 65001>nul && %~dp0..\..\dist\kpt-tui-node.exe"
