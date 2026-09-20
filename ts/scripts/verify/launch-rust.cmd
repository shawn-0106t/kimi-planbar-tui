@echo off
rem Launch the Rust reference edition in its own console window, to compare the
rem Ctrl+C behaviour the Bun edition is supposed to match (SPEC 20).
start "kpt-rust" cmd /k "chcp 65001>nul && C:\Users\rexxa\Documents\trae_projects\github\kimi-planbar-tui\rust\target\debug\kimi-planbar-tui.exe"
