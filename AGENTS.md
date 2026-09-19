# AGENTS.md — Kimi Planbar TUI

Guidance for AI coding agents working in this repository. Read this first; it assumes no prior knowledge of the project.

## Project overview

Kimi Planbar TUI is a **terminal-resident dashboard** (no tray, no windows, no animations) that shows Kimi Code plan quota — 5-hour window + weekly usage with reset countdowns, Extra Usage booster wallet, Kimi Code CLI version check, and a read-only skills list — inside a terminal. It reads the local Kimi Code CLI OAuth token (read-only) and calls `GET https://api.kimi.com/coding/v1/usages`.

This is a **monorepo** (layout mirrors the sibling `kimi-planbar-tray`): `rust/` holds the Rust edition; a TS edition (Bun + OpenTUI) is planned under `ts/`, sharing the same behavior contract.

Current version: **0.1.0** (kept in `rust/Cargo.toml`; versioning is **independent** of the sibling tray app `kimi-planbar-tray`).

Stack: Rust stable (MSVC) + **ratatui** (TUI framework) + **crossterm** (terminal backend/events) + tokio + reqwest + serde + winreg + windows 0.61 (Win32 console APIs, for minimal-window-on-launch) + regex + chrono. No Tauri, no WebView. Distribution is a single static release exe (~3–5 MB) via `cargo build --release` in `rust/`.

This repo is a standalone derivative of the tray app (`kimi-planbar-tray`): the backend modules were ported 1:1 from `rust/src-tauri/src/` with the Tauri dependencies removed. **The behavior contract is `docs/SPEC.md`** (Chinese; English translation at `docs/SPEC_EN.md`, identical chapter numbering) — it keeps the same chapter numbering as the tray edition's SPEC, with chapters 10 (window spec), 14 (tray behavior), and 15 (animations) explicitly marked not applicable. Consult it before changing behavior; any behavior change must update the corresponding SPEC chapter.

Data contract shared with the tray edition: same credential chain, same `settings.json` schema, same portable mode (`portable.dat`), same HKCU Run autostart mechanism — but with TUI-specific names: registry value `KimiPlanbarTui`, app-data dir `%APPDATA%\KimiPlanbarTui\`. Unlike the tray editions there is **no single-instance mutex** — multiple TUI instances may run side by side.

## Repository layout

```
├── rust/                       # Rust edition: single crate (package + binary name: kimi-planbar-tui)
│   ├── Cargo.toml / Cargo.lock
│   ├── build.rs                # embeds VERSIONINFO + app icon via winresource (warns, never fails the build)
│   ├── assets/icon.ico         # app icon (official Kimi logo © Moonshot AI; attribution in NOTICE)
│   └── src/
│       ├── main.rs             # entry; --test-fetch / --test-update self-checks, then TUI bootstrap
│       ├── credentials.rs      # token chain (KIMI_CODE_HOME-aware kimi_home): credentials/kimi-code.json -> config.toml fallback
│       ├── quota.rs            # HTTP fetch + defensive JSON parsing (see traps below)
│       ├── polling.rs          # refresh scheduling: 2 s first refresh, 30 s fast retry on failure, keep-last-good; mpsc -> UI
│       ├── settings.rs         # settings.json persistence, portable.dat detection, HKCU Run autostart
│       ├── skills.rs           # read-only scan of local Kimi Code skills (+ frontmatter parser unit tests)
│       ├── update.rs           # kimi --version + changelog Range request + GitHub API fallback
│       ├── theme.rs            # Moonlit/Moondark palettes as ratatui Color::Rgb; system theme via 30 s registry polling
│       ├── state.rs            # AppState shared state (last-good cache, skills cache, manual-refresh debounce)
│       ├── app.rs              # TUI bootstrap + event loop (tokio::select!; new code)
│       ├── format.rs           # FormatReset / FmtYuan / percent display helpers (ported from the tray edition's src/common.ts)
│       └── ui/                 # ratatui view layer (new code): dashboard.rs, settings_view.rs, skills_view.rs
├── ts/                         # (planned) TS edition: Bun + OpenTUI, same SPEC contract, independent version
├── docs/
│   ├── SPEC.md                 # authoritative behavior contract (Chinese), shared by both editions
│   ├── SPEC_EN.md              # English translation, identical chapter numbering
│   └── TS-EDITION-PLAN.md      # TS edition (Bun + OpenTUI) implementation plan: decisions, smoke-test findings, M1-M4 steps
├── AGENTS.md / README.md / README_CN.md
├── LICENSE                     # MIT © Shawn Qi
└── NOTICE                      # portions © baigong-ai / kimi-planbar
```

## Build and run

Prerequisites: Windows + Rust stable (MSVC toolchain). Nothing else — no Node.js, no WebView2.

```bash
cd rust
cargo build --release   # single static exe at rust/target/release/kimi-planbar-tui.exe (~3-5 MB)
cargo run               # dev run (debug build works fine — there is no embedded frontend)
```

For shell-command use: `cargo install --path rust` from the repo root installs the release exe to `~/.cargo/bin` (on PATH for Rust users), after which `kimi-planbar-tui` works in any terminal.

Run the exe inside a terminal: **Windows Terminal** or the **VS Code integrated terminal** are the baseline targets. Legacy conhost works but needs `chcp 65001` first (UTF-8 code page), or box-drawing glyphs and CJK text render garbled.

## Testing / self-checks

- `cargo test` (in `rust/`) — unit tests for the skills frontmatter parser (ported from the tray edition) and quota JSON parsing (string/number mixed fields, `isEnabled=false`, unit rounding, divide-by-zero). This is the first real parsing test suite in the project family.
- Headless self-check args (SPEC chapter 19), printed to stdout then exit:

```bash
kimi-planbar-tui.exe --test-fetch    # fetch quota once, print indented JSON, exit
kimi-planbar-tui.exe --test-update   # one line: local=... latest=... updateAvailable=... checkFailed=...
```

There is **no `--test-ui`** (no windows to construct) and **no single-instance check** — the self-checks work while other instances are running simply because nothing is locked. To verify behavioral parity with the tray edition, run both apps' `--test-fetch` back to back on the same machine and diff the JSON field by field.

After changes: `cargo build` + `cargo test` (in `rust/`), then run `--test-fetch` and `--test-update` against the built exe, and eyeball the TUI in Windows Terminal under both themes.

## Release process

1. Bump the version in `rust/Cargo.toml` — the **only** version bump location: the exe's VERSIONINFO FileVersion/ProductVersion derive from `CARGO_PKG_VERSION` automatically via `build.rs` (winresource). (Sync any packaging script if one is added later — keep it simple.)
2. `cd rust && cargo build --release`.
3. Distribute the single exe via GitHub Releases (manual upload). **Do not commit binaries**; release archives are gitignored.
4. The app is unsigned — SmartScreen warnings are expected and documented in the README.

## Code style and conventions

- **Code, comments, and commit messages are in English**; conversation with the user is in Chinese.
- Comments cite SPEC sections (e.g. `SPEC 16.5`); keep those citations accurate when you change behavior.
- Error-handling baseline: all IO, registry, process, and HTTP failures are **silently swallowed** and surfaced only via UI text ("Update failed", "Not detected") or state fields. Never panic the TUI on a data error.
- All external data (skill names/descriptions, API payloads) is rendered through ratatui text widgets, which are inherently injection-safe — keep it that way; never build terminal escape sequences from external strings.
- Backend modules (`credentials.rs`, `quota.rs`, `polling.rs`, `settings.rs`, `skills.rs`, `update.rs`) mirror the tray edition's `rust/src-tauri/src/` counterparts with Tauri removed — keep them behaviorally identical; `docs/SPEC.md` is the contract and the tray repo is the reference source.
- Async architecture: `tokio::select!` over crossterm `EventStream` (keyboard/resize), polling mpsc, update-check mpsc, skills mpsc, the 30 s theme tick, and a 250 ms draw heartbeat. Redraw is **event-driven** — every event redraws immediately at the top of the loop; the 250 ms heartbeat only wakes the loop when idle so countdowns stay fresh. Countdown text is recomputed on every redraw (`format_reset` input is `reset_at - now`) — no dedicated per-second timer.

## Critical behavioral traps (do not regress)

- **Extra Usage units**: `boosterWallet.balance.amountLeft` is in **1e-8 yuan**; convert to cents with `(raw + 500000) / 1000000`. `priceInCents` fields are already cents. All JSON numbers are modeled as **strings** (tolerate numeric fallback). (SPEC 16.3)
- **`isEnabled=false` trap**: when the booster wallet is not enabled, `amountLeft` is an estimate, not a real balance — the Extra Usage row must show "Not activated". (SPEC 16.3)
- **Credential chain**: `~/.kimi-code/credentials/kimi-code.json` `access_token` (valid only if `expires_at` > now + 30 s) → fallback to an `api_key` in `~/.kimi-code/config.toml` whose `[providers.*]` section has `base_url` containing `api.kimi.com/coding`. `KIMI_CODE_HOME` overrides the home dir. (SPEC 16.2)
- **Failure semantics**: on fetch failure keep the last good values on screen and retry after 30 s; on success return to the configured interval (1/5/10/30 min, default 5). First refresh fires 2 s after launch. Manual refresh (`r` key) has a **2 s debounce** — repeats within 2 s are silently ignored. (SPEC 16.5, 12.7)
- **Portable mode**: an empty `portable.dat` next to the exe redirects `settings.json` to the exe directory instead of `%APPDATA%\KimiPlanbarTui\`. (SPEC 18.1)
- **Terminal restore on exit**: the app enters raw mode + alternate screen on startup and **must** restore the terminal (leave alternate screen, disable raw mode, show cursor) on every exit path — normal quit (`q`), and panic via a panic hook. A stranded terminal is the worst possible bug for a TUI. (SPEC 20)
- **Never resize a shared console**: startup shrinks the window to the wireframe minimum (72×13) only when the process owns its console outright (`GetConsoleProcessList` returns exactly 1 attached process — a double-click / fresh-window launch). That guard must stay; launching from an existing terminal session must leave the user's window untouched. (SPEC 20)
- **Event-driven redraw + 250 ms heartbeat**: every event (keyboard/resize, mpsc messages, theme tick) redraws immediately — there is no coalescing throttle. A 250 ms heartbeat tick (`draw_tick`) wakes the loop when idle so countdown text stays fresh; countdowns are recomputed on each redraw, so there is no 1 Hz timer. (SPEC 20)
- **System theme polling**: crossterm has no system-event source, so `theme=system` is implemented as a **30 s registry poll** of `AppsUseLightTheme` (replaces the tray edition's `WM_SETTINGCHANGE` listener). Only applies when the theme setting is `system`. (SPEC 20)
- **No single-instance mutex**: unlike the tray/Qt/WPF editions (`KimiPlanbarTray.SingleInstance`), multiple TUI instances are allowed. Do not add a mutex. (SPEC 20)

## Security considerations

- The OAuth token / API key is **read-only** from local Kimi Code CLI files and is sent only to `https://api.kimi.com/coding/v1/usages` as a Bearer token. It must never be logged, persisted elsewhere, or sent to any other endpoint.
- No admin rights: autostart writes only `HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Run` (key `KimiPlanbarTui`); nothing touches HKLM or Program Files.
- The app is unsigned; SmartScreen warnings are expected and documented in the README.
- Logo/branding copyright belongs to Moonshot AI; this is an unofficial community tool — keep the non-affiliation notice in the README. Keep `LICENSE` (MIT © Shawn Qi) and `NOTICE` (portions © baigong-ai / kimi-planbar) attribution intact.
