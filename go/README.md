# kimi-planbar-tui-go — Go edition (bubbletea v2 / lipgloss)

This directory holds the **Go edition** of Kimi Planbar TUI — the fourth implementation of the same behavior contract (`docs/SPEC.md`), built on **bubbletea v2 + lipgloss**. It is a supported alternative, versioned independently of the other editions (`go/VERSION` is the single version source, read via `go:embed`).

- Supported implementations: the Rust edition in [`../rust/`](../rust) (recommended), the Node edition in [`../ts-nodejs/`](../ts-nodejs), the Bun edition in [`../ts/`](../ts), and this Go edition
- User-facing docs: [`../README.md`](../README.md) / [`../README_CN.md`](../README_CN.md)
- Implementation deltas are registered in [`../docs/SPEC.md`](../docs/SPEC.md) chapter 22 (§22.7); the development plan and milestone ledger live in [`../docs/PLAN-GO.md`](../docs/PLAN-GO.md)

## Requirements

- Windows 10/11 + Go 1.27
- Dependencies: `golang.org/x/sys/windows` (registry + Win32 console), `mattn/go-runewidth` (East Asian cell widths); everything else is stdlib

## Build and run

```bash
go build -o dist/kpt-tui-go.exe .          # dev/local build (~12 MB, AOT — no embedded runtime)
CGO_ENABLED=0 go build -ldflags "-s -w" -o dist/kpt-tui-go.exe .   # release flags
go run .                                   # dev run
```

Headless self-checks (SPEC chapter 19): `dist/kpt-tui-go.exe --test-fetch` / `--test-update`.

## Tests and gates

```bash
go test ./...                    # unit suite (core + tui); TZ pinned to Asia/Shanghai with a guard test
go vet ./... && gofmt -l .       # must stay clean
go run ./scripts/parity          # byte-identical diff of both self-checks vs the Rust debug exe
```

## Real-console probe

`scripts/probe-owned-console` launches the built exe in a fresh console (CREATE_NEW_CONSOLE = double-click semantics), verifies the 72×13 startup shrink, injected-key reachability (`s` opens Settings) and the `q`/`ctrlc` exit paths; `-exit ctrlbreak` group-directs a CTRL_BREAK_EVENT in a shared console to exercise the ctrl-handler path (exit code + console-mode restore). Requires a real console — run it from a terminal, not a pipe.

## Layout

```
├── main.go                      # entry; --test-fetch / --test-update headless self-checks
├── VERSION                      # the single version source (go:embed)
├── internal/core/               # 10 UI-agnostic modules mirroring rust/src/*.rs (json, quota, settings, credentials, ...)
├── internal/tui/                # bubbletea render layer: line, app, dashboard, settingsview, skillsview, shrink, ctrlhandler
├── scripts/parity/              # byte-parity harness against the Rust exe
├── scripts/probe-owned-console/ # Go-native owned-console acceptance probe
└── testdata/golden/             # Rust-oracle goldens shared with the other editions
```
