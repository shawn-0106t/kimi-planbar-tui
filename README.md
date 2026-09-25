# Kimi Planbar TUI

[中文](README_CN.md)

A terminal-resident dashboard that keeps your [Kimi Code](https://www.kimi.com/code/) plan quota in view — 5-hour window and weekly usage with reset countdowns, right in your terminal. No tray, no windows, no animations: just a fast TUI you can leave open in a terminal tab.

> **Editions.** The Rust edition (`rust/`) is the maintained, recommended build. The Node edition (`ts-nodejs/`) and the Bun edition (`ts/`) are supported alternatives with the same UI and behavior, each versioned independently (the Bun edition was frozen as experimental from 2026-09-19 to 2026-09-25 and was unfrozen to land its owned-console startup crash fix — see `HANDOFF.md`).

## Screenshot

The dashboard layout:

```
Kimi Planbar TUI                                    Updated 14:32

5-hour usage   21%  █████░░░░░░░░░░░░░░░  Resets in 4h 30m
Weekly usage   18%  ████░░░░░░░░░░░░░░░░  Resets in 5d 15h

Extra Usage    ¥12.34
  Used ¥45.67 this month / ¥100 limit

Kimi Code CLI  2.0.1   Update available

r Refresh · s Settings · k Skills · c Console · g Releases · q Quit
```

## Features

- **Terminal resident** — a full-screen TUI dashboard built with ratatui; runs in any modern terminal, multiple instances allowed (one per terminal tab is fine)
- **Quota at a glance** — 5-hour and weekly usage rows with text progress bars and reset countdowns, kimi CLI `/usage`-style wireframe; data comes from the same endpoint as the CLI's `/usage`
- **Light / dark themes** — "Moonlit" and "Moondark" palettes in truecolor that follow the Windows system theme (polled every 30 s), or pin one in Settings; accent color `#1A88FF`
- **Resilient refresh** — auto-refresh on a configurable interval (1/5/10/30 min); on failure the last good values stay visible and a fast retry kicks in after 30 s
- **CLI version check** — shows your local `kimi --version`; an orange badge appears when a newer release exists on [kimi-code Releases](https://github.com/MoonshotAI/kimi-code/releases) (press `g` to open the page). Version info comes from the official changelog (with GitHub API fallback), so it works even when GitHub is unreachable
- **Extra Usage row** — shows your booster wallet balance (¥) and monthly charge usage/limit; gracefully shows "Not activated / No data" when the wallet has never been topped up
- **Skills at a glance** — press `k` for a read-only list of your local Kimi Code skills, grouped by source (`~/.kimi-code/skills`, `~/.agents/skills`, managed plugins); scanned once on open and cached, zero background polling
- **Portable & UAC-free** — single static exe (~3–5 MB), per-user only (HKCU autostart, no admin rights, nothing written to HKLM or Program Files); drop an empty `portable.dat` next to the exe to store settings beside it instead of `%APPDATA%\KimiPlanbarTui\`

## Download

Get the latest `kimi-planbar-tui.exe` from [Releases](../../releases), or build from source (below). The same page also carries `kpt-tui-node.exe` (Node 24 + handwritten ANSI, ~88.7 MB embedding the Node runtime), with the same behavior and UI as the Rust edition. If you already have Node ≥ 24.6, you can skip the download and run from source instead.

> The Bun edition's exe (`kpt-tui.exe`) shipped only as a historical v0.1.1 asset and is published again starting with v0.1.2 (~90 MB — it embeds the Bun runtime).

> Windows SmartScreen may warn on first launch because the exe is not code-signed. Click "More info" → "Run anyway" — this is expected for unsigned personal builds.

## Requirements

- Windows 10 / 11
- A modern terminal — **Windows Terminal** or the **VS Code integrated terminal** are the baseline (truecolor + UTF-8). Legacy conhost works but needs `chcp 65001` first, or box-drawing glyphs and CJK text render garbled
- [Kimi Code](https://www.kimi.com/code/) CLI installed and signed in, with a **Kimi For Coding** plan (the app reads the CLI's local OAuth token from `~/.kimi-code/credentials/kimi-code.json`, falling back to a plain `api_key` in `~/.kimi-code/config.toml`; both honor the `KIMI_CODE_HOME` override)
- Network access to `api.kimi.com`

No credentials are stored or sent anywhere except the official `api.kimi.com/coding/v1/usages` endpoint.

## Usage

Launch `kimi-planbar-tui.exe` inside a terminal. Keys:

> Double-clicking the exe opens a fresh window sized to the minimal wireframe (72×13 cells). When launched from an existing terminal session (cmd / pwsh / Git Bash / another Windows Terminal tab), the console is shared and your window is left untouched.

| Key | Action |
|---|---|
| `r` | Refresh quota + version check now (2 s debounce) |
| `s` | Settings — theme (System default / Moonlit / Moondark), refresh interval, launch at login |
| `k` | Skills — read-only list of local Kimi Code skills |
| `c` | Open the [Kimi Code console](https://www.kimi.com/code/console) in your browser |
| `g` | Open the kimi-code [Releases](https://github.com/MoonshotAI/kimi-code/releases) page |
| `↑` / `↓` | Navigate lists and forms |
| `Enter` | Confirm |
| `Esc` | Back |
| `q` | Quit (the terminal is always restored on exit) |

## Portable mode

Drop an empty file named `portable.dat` next to the exe and `settings.json` will be stored beside the exe instead of `%APPDATA%\KimiPlanbarTui\`.

## Autostart

Enable "Launch at Windows startup" in Settings (`s`). It writes a single per-user registry value `KimiPlanbarTui` under `HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Run` — no admin rights, nothing in HKLM.

## Build from source

### Rust edition (default)

Requires Rust (stable, MSVC toolchain) on Windows. Nothing else — no Node.js, no WebView2.

```bash
cd rust
cargo build --release   # single static exe at rust/target/release/kimi-planbar-tui.exe
```

### TS edition (Node 24 + handwritten ANSI)

Requires Node.js ≥ 24.6 on Windows (the sources run directly on Node's native type stripping; `--use-system-ca` exists since 24.6). No Bun, no Cargo.

```bash
cd ts-nodejs
npm install
npm run dev             # run the TUI straight from src/main.ts
npm run build:exe       # SEA single-file exe → ts-nodejs/dist/kpt-tui-node.exe (~88.7 MB, embeds Node)
npm test                # node:test suite (scripts/run-tests.mjs pins TZ=Asia/Shanghai)
npm run parity          # diff --test-fetch / --test-update against the Rust exe
```

### TS edition (Bun + OpenTUI)

> Unfrozen on 2026-09-25 (it was experimental/frozen before that) and maintained again as a supported alternative; versioned independently.

Requires Bun ≥ 1.3 on Windows (install it with `npm install -g --allow-scripts=bun bun`; a plain global install gets its postinstall skipped by npm's allowScripts policy). No Cargo involved.

```bash
cd ts
bun install
bun run dev             # run the TUI straight from src/main.ts
bun run build:exe       # single-file exe at ts/dist/kpt-tui.exe (~90 MB, embeds Bun)
bun run test            # bun:test suite (the script pins TZ=Asia/Shanghai)
bun run parity          # diff --test-fetch / --test-update against the Rust exe
```

> **Quit the Bun edition with `q`**: whether Ctrl+C reaches the app drifts with the Bun runtime version (swallowed when measured on WT 1.24 / conhost, 2026-09-20; quitting normally again on Bun 1.4.2, re-measured 2026-09-25). `q` always works. See SPEC 22.6.

All three editions implement the same contract, `docs/SPEC.md`; the places where a TS edition is mechanically different are registered in SPEC chapter 22 (for example: behind TLS-inspecting security software a Bun script run needs `--use-system-ca` for the GitHub API version-check fallback, and the Bun exe cannot embed that flag — the quota and changelog paths are unaffected — while the Node SEA exe has it baked in via `execArgv`).

Headless self-checks (useful in CI or after changes):

```bash
kimi-planbar-tui.exe --test-fetch    # fetch quota once, print JSON, exit
kimi-planbar-tui.exe --test-update   # print local/latest version + updateAvailable, exit
```

`cargo test` runs the unit suite (skills frontmatter parser + quota JSON parsing).

## Install as a shell command

From the repo root:

```bash
cargo install --path rust   # installs the release exe to ~/.cargo/bin (already on PATH for Rust users)
```

After that, `kimi-planbar-tui` works in any terminal. Alternative: copy `rust/target/release/kimi-planbar-tui.exe` to any folder on `PATH`.

## Security & privacy

- The OAuth token / API key is read **read-only** from local Kimi Code CLI files and sent only as a Bearer token to `https://api.kimi.com/coding/v1/usages` — never logged, never persisted elsewhere, never sent anywhere else
- No telemetry, no analytics, no admin rights required

## Tech notes

- Single Rust crate in `rust/`: ratatui + crossterm (TUI), tokio + reqwest + serde (async/HTTP/JSON), winreg (registry), windows 0.61 (Win32 console), regex + chrono
- The Bun + OpenTUI TS edition in `ts/` — maintained again (unfrozen 2026-09-25; was experimental/frozen before): `@opentui/core` (imperative render API, no React), registry through `reg.exe` child processes, and the Win32 console pieces (raw mode, console-ownership check, window shrink) through `bun:ffi`
- The supported Node TS edition in `ts-nodejs/`: Node 24 with a handwritten ANSI render layer (no TUI library — line-level diff writes, an embedded wcwidth table, and a `sanitize()` firewall for external strings), registry through `reg.exe`, packaged as a Node SEA exe with `--use-system-ca` baked into `execArgv`
- The release exe embeds a Windows VERSIONINFO resource and the app icon via `rust/build.rs` (`winresource` build-dependency, `rust/assets/icon.ico`); FileVersion/ProductVersion derive automatically from `CARGO_PKG_VERSION`, and embedding failure only warns (machines without the Windows SDK rc.exe still compile)
- Backend modules are ported 1:1 from the sibling tray app [kimi-planbar-tray](https://github.com/shawn-0106t/kimi-planbar-tray) (Tauri edition) with Tauri removed; the shared behavior contract lives in `docs/SPEC.md`
- Quota logic adapted from [kimi-planbar](https://github.com/baigong-ai/kimi-planbar) (MIT) — same token sources, endpoint, and cache/retry strategy
- UI design lineage: [KimiCodeBar](https://github.com/xifandev/KimiCodeBar) (MIT) by [@xifandev](https://github.com/xifandev); skills feature referenced from [kimi-code-dashboard](https://github.com/perinchiang/kimi-code-dashboard) by [@perinchiang](https://github.com/perinchiang)
- Kimi logo and brand copyright belong to **Moonshot AI** — this is an unofficial community tool, not affiliated with Moonshot AI

## License

[MIT](LICENSE) © 2026 Shawn Qi (shawn-0106t), with portions © baigong-ai (kimi-planbar) — see [NOTICE](NOTICE)
