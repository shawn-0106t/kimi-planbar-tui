# AGENTS.md — Kimi Planbar TUI

Guidance for AI coding agents working in this repository. Read this first; it assumes no prior knowledge of the project.

## Project overview

Kimi Planbar TUI is a **terminal-resident dashboard** (no tray, no windows, no animations) that shows Kimi Code plan quota — 5-hour window + weekly usage with reset countdowns, Extra Usage booster wallet, Kimi Code CLI version check, and a read-only skills list — inside a terminal. It reads the local Kimi Code CLI OAuth token (read-only) and calls `GET https://api.kimi.com/coding/v1/usages`.

This is a **monorepo** (layout mirrors the sibling `kimi-planbar-tray`): `rust/` holds the Rust edition (maintained, recommended); `ts-nodejs/` holds the Node edition and `ts/` holds the Bun + OpenTUI edition — both supported alternatives with the same UI and behavior (`ts/` was frozen as experimental from 2026-09-19 to 2026-09-25 and was unfrozen to land the owned-console startup crash fix; see `HANDOFF.md`). Where a TS edition is not mechanically equivalent to Rust, the register is **SPEC chapter 22** (`docs/SPEC.md` / `docs/SPEC_EN.md`), filed by SPEC chapter number.

Current version: **0.1.1** in `rust/Cargo.toml` and `ts-nodejs/package.json`, **0.1.2** in `ts/package.json` (each edition bumps independently; versioning is **independent** of the sibling tray app `kimi-planbar-tray`).

Stack, Rust edition: Rust stable (MSVC) + **ratatui** (TUI framework) + **crossterm** (terminal backend/events) + tokio + reqwest + serde + winreg + windows 0.61 (Win32 console APIs, for minimal-window-on-launch) + regex + chrono. No Tauri, no WebView. Distribution is a single static release exe (~3–5 MB) via `cargo build --release` in `rust/`.

Stack, TS edition (Bun): **Bun** ≥ 1.3 (runtime + bundler + `bun:test`) + **@opentui/core** (imperative render API, no React) + `bun:ffi` (kernel32 console mode / console ownership / window resize) + `node:fs`/`node:path` + `reg.exe` via spawn for the registry. Distribution is a single-file exe (~90 MB, embeds the Bun runtime) via `bun run build:exe` in `ts/`, or `bun run dev` for users who already have Bun.

Stack, TS edition (Node): **Node.js ≥ 24.6** (native type stripping; no build step for dev) + a handwritten ANSI render layer (no TUI library) + `node:test` + `node:child_process` (`reg.exe` for the registry, `kimi --version` for the update check). Distribution is a SEA single-file exe (~88.7 MB, embeds the Node runtime, `--use-system-ca` baked via `execArgv`) via `npm run build:exe` in `ts-nodejs/`, or `npm run dev` for users who already have Node.

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
├── ts/                         # TS edition (Bun): unfrozen 2026-09-25 (was experimental/frozen), independent version
│   ├── package.json            # scripts: dev / test / parity / selfcheck:* / build:exe; name kimi-planbar-tui-ts
│   ├── README.md               # directory notice (unfrozen 2026-09-25, maintained again)
│   ├── src/core/               # 10 UI-agnostic modules mirroring rust/src/*.rs (no @opentui imports allowed)
│   ├── src/tui/                # OpenTUI render layer: line, dashboard, settingsView, skillsView, renderer, app, console, shrink
│   ├── src/main.ts             # entry; --test-fetch / --test-update before anything else
│   ├── scripts/verify/         # SPEC 20 real-terminal probes: console/Ctrl+C key-capture launchers + parse-ctrlc (headless)
│   └── test/                   # bun:test suites + test/parity/ (Rust oracle goldens, diff.ts) + console/system-ca probes
├── ts-nodejs/                  # TS edition (Node): Node 24 + handwritten ANSI, same SPEC contract, independent version
│   ├── package.json            # scripts: dev / test / typecheck / parity / selfcheck:* / build:exe; name kimi-planbar-tui-ts-nodejs
│   ├── src/core/               # the same 10 modules, ported from ts/src/core (only 3 Bun.* call sites de-Bun'd);
│   │                           # the 2026-09-20 M1 core fixes are now ported too (see SPEC 22.2's status note)
│   ├── src/tui/                # handwritten ANSI layer: ansi, wcwidth, screen, terminal + views (dashboard, settingsView, skillsView, app)
│   ├── src/main.ts             # entry; --test-fetch / --test-update before anything else
│   ├── scripts/                # run-tests.mjs (TZ pin), run-parity.mjs, build-sea.mjs, verify/ (WT window probing helpers)
│   └── test/                   # node:test suites via test/bun-shim.ts + golden/ + parity/ (same oracle set as ts/)
├── docs/
│   ├── SPEC.md                 # authoritative behavior contract (Chinese), shared by the Rust and TS editions
│   │                           # chapter 22 registers where each TS edition is NOT equivalent to Rust
│   ├── SPEC_EN.md              # English translation, identical chapter numbering
│   ├── REVIEW-M1.md            # M1 core-layer audit ledger: 5 Major + 7 Minor, plus a measured
│   │                           # status table (file:line per item, incl. what is deliberately untested)
│   └── REVIEW-RUST.md          # 2026-09-25 full audit of the Rust edition: 1 Major (fmt_yuan i64::MIN
│                               # recursion → terminal stranding) + 5 Minor + 3 Suggestion, test-coverage
│                               # gaps, and a backfill table (all unfixed, pending maintainer decision)
├── HANDOFF.md                  # 2026-09-25 incident record: Bun edition "unusable" root cause
│                               # (shrink.ts FFI pointer bug → segfault on owned-console launch), evidence chain, fixes
├── AGENTS.md / README.md / README_CN.md
├── LICENSE                     # MIT © Shawn Qi
└── NOTICE                      # portions © baigong-ai / kimi-planbar
```

## Build and run

Rust edition — prerequisites: Windows + Rust stable (MSVC toolchain). Nothing else — no Node.js, no WebView2.

```bash
cd rust
cargo build --release   # single static exe at rust/target/release/kimi-planbar-tui.exe (~3-5 MB)
cargo run               # dev run (debug build works fine — there is no embedded frontend)
```

For shell-command use: `cargo install --path rust` from the repo root installs the release exe to `~/.cargo/bin` (on PATH for Rust users), after which `kimi-planbar-tui` works in any terminal.

TS edition (Bun) — prerequisites: Windows + Bun ≥ 1.3 (no Cargo). `npm i -g --allow-scripts=bun bun` on this machine: the plain `npm i -g bun` is blocked by the npm allowScripts policy and skips Bun's postinstall.

```bash
cd ts
bun install
bun run dev             # run the TUI from src/main.ts (passes --use-system-ca, see traps)
bun run build:exe       # single-file exe at ts/dist/kpt-tui.exe (~90 MB; dist is gitignored)
```

TS edition (Node) — prerequisites: Windows + Node.js ≥ 24.6 (native type stripping runs the .ts sources directly; `--use-system-ca` exists since 24.6). No Bun, no Cargo.

```bash
cd ts-nodejs
npm install
npm run dev             # run the TUI from src/main.ts
npm run build:exe       # SEA single-file exe at ts-nodejs/dist/kpt-tui-node.exe (~88.7 MB; dist is gitignored)
```

Run the exe inside a terminal: **Windows Terminal** or the **VS Code integrated terminal** are the baseline targets. Legacy conhost works but needs `chcp 65001` first (UTF-8 code page), or box-drawing glyphs and CJK text render garbled.

## Testing / self-checks

Rust edition:

- `cargo test` (in `rust/`) — unit tests for the skills frontmatter parser (ported from the tray edition) and quota JSON parsing (string/number mixed fields, `isEnabled=false`, unit rounding, divide-by-zero). This is the first real parsing test suite in the project family.
- Headless self-check args (SPEC chapter 19), printed to stdout then exit:

```bash
kimi-planbar-tui.exe --test-fetch    # fetch quota once, print indented JSON, exit
kimi-planbar-tui.exe --test-update   # one line: local=... latest=... updateAvailable=... checkFailed=...
```

TS edition (Bun) — same two self-checks, plus a byte-parity harness:

```bash
cd ts
bun run test                              # bun:test suite; the script pins TZ=Asia/Shanghai
bun run parity                            # TS vs rust/target/debug exe, back to back
bun run test/parity/diff.ts --ts-exe dist/kpt-tui.exe   # same diff against the compiled build
bun run selfcheck:fetch                   # one self-check, like the Rust exe
bun test/console-probe.ts [--shrink]      # SPEC 20 terminal checks (run in a REAL terminal)
```

`bun test` without the script's TZ pin breaks the Rust-oracle goldens (they are `DateTime<Local>` stamps). The compiled exe is what `--use-system-ca` cannot be baked into — see the traps below.

TS edition (Node) — same two self-checks, same parity harness, plus a type check:

```bash
cd ts-nodejs
npm test                                    # node:test via test/bun-shim.ts; scripts/run-tests.mjs pins TZ=Asia/Shanghai
npm run typecheck                           # tsc --noEmit must stay at 0 errors
npm run parity                              # diff both self-checks against rust/target/debug exe
node test/parity/diff.ts --ts-exe dist/kpt-tui-node.exe   # same diff against the SEA build
npm run selfcheck:fetch                     # one self-check, like the Rust exe
```

There is **no `--test-ui`** (no windows to construct) and **no single-instance check** — the self-checks work while other instances are running simply because nothing is locked. To verify behavioral parity with the tray edition, run both apps' `--test-fetch` back to back on the same machine and diff the JSON field by field.

After changes: `cargo build` + `cargo test` (in `rust/`), then run `--test-fetch` and `--test-update` against the built exe, and eyeball the TUI in Windows Terminal under both themes. For `ts-nodejs/`, `npm test` + `npm run typecheck` + `npm run parity` must stay green. For `ts/`, `bun run test` must stay green, and any change to the startup-shrink path needs a real owned-console launch check (double-click or `start` the built exe — automated tests cannot reach that branch; this gap hid the 2026-09-25 segfault).

## Release process

1. Rust version bump: `rust/Cargo.toml` is the only place for the Rust exe — its VERSIONINFO FileVersion/ProductVersion derive from `CARGO_PKG_VERSION` automatically via `build.rs` (winresource). The Node edition bumps independently in `ts-nodejs/package.json`; the Bun edition bumps independently in `ts/package.json`.
2. `cd rust && cargo build --release`; `cd ts-nodejs && npm install && npm test && npm run typecheck && npm run build:exe`; `cd ts && bun install && bun run test && bun run build:exe` (`bun run test`, not bare `bun test` — the script pins TZ, see the testing section).
3. Distribute the exes via GitHub Releases (manual upload). **Do not commit binaries**; `rust/target/`, `ts/dist/`, `ts-nodejs/dist/` and `*.exe` are gitignored. Say in the release notes that the Node SEA build is ~88.7 MB and the Bun build ~90 MB because they embed their runtimes.
4. Both shipped exes are unsigned — SmartScreen warnings are expected and documented in the README. (postject prints a "signature seems corrupted" warning while injecting the SEA blob: expected — injection invalidates the stock node.exe Authenticode signature and the result ships unsigned.)

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
- **Chinese IME swallows letter keys (all editions, user environment — not a code defect)**: with the input method in Chinese mode, `r`/`s`/`k`/`c`/`g`/`q` enter pinyin composition and never reach the app, which reads as "dead keys". Before hunting an input-routing bug, have the user switch the IME to English (Shift). Measured 2026-09-25 on the Bun edition — Rust behaves identically. Documented in both READMEs and SPEC 12.7.

TS-edition traps (full register: SPEC chapter 22). **Cross-edition rules (East Asian Width cell widths, the changelog Range header / `--use-system-ca`, `process.execPath` semantics) apply to both `ts/` and `ts-nodejs/`.**

- **`SetConsoleWindowInfo` takes a `const SMALL_RECT *`, not a by-value struct**: `shrink.ts` must pass an 8-byte Buffer (four little-endian i16: left/top/right/bottom) through `ptr()`; packing the struct bits by value into the pointer slot segfaults natively (the 2026-09-25 fixed bug — every owned-console launch died with exit code 3, invisible because shared-console/non-TTY runs skip the shrink branch). `SetConsoleScreenBufferSize`'s `COORD` genuinely is by-value (`(y<<16)|x`). `bun:ffi` has no guard against native crashes — a signature error kills the process with no JS catch. (`ts/src/tui/shrink.ts`, SPEC §22.6, HANDOFF.md)
- **OpenTUI's mouse tracking must be disabled explicitly**: `createCliRenderer` defaults `useMouse = true` (emits `?1000h ?1002h ?1003h ?1006h`), hijacking the mouse in real terminals; pass `useMouse: false` — the dashboard defines no mouse interaction. (SPEC §22.5)
- **Restore handlers must be installed before `makeRenderer()`**, tolerant of an absent renderer/raw-mode restore — same discipline as the Rust panic hook and the Node edition. (SPEC §22.5)
- **The 30 s theme poll must be the async `reg.exe` spawn, not `spawnSync`**: a synchronous registry read blocks the event loop for tens of ms every 30 s (theme=system), stalling redraws and keys. Only the startup probe and a saveSettings cache-miss may stay synchronous (the latter matches the Rust oracle's sync registry read). `refreshSystemThemeCache()` returns a promise; the flip redraws from it. (SPEC §22.3)
- **Neither the 250 ms heartbeat nor the theme timer may be `unref`'d**: these timers keep the Bun loop alive — the former `unref` left it alive only through an OpenTUI-internal 60 s tick, an undocumented dependency (removed 2026-09-25). (SPEC §22.5)
- **The keypress handler chain needs its own try/catch**: an uncaught throw would bubble into OpenTUI's handler, which drops that draw; catch silently (console.error would paint over the live frame). (SPEC §22.5)
- **Bun/Windows raw mode is not a no-op safety net**: `process.stdin.setRawMode()` does not change the OS console mode, so `ts/src/tui/console.ts` sets it through `bun:ffi SetConsoleMode` — on the **input** handle `(HANDLE)-10` = `0xfffffff6` (`0xfffffff5` is the output handle and rejects those flags; M2 had this wrong) — and re-asserts it before every input event and redraw because Bun flips the console back to cooked on each stdin read. (SPEC 20)
- **Ctrl+C delivery on the Bun edition drifts with the Bun version**: measured 2026-09-20 (Bun of that date) as fully swallowed; re-measured 2026-09-25 on Bun 1.4.2 — Ctrl+C now quits cleanly. `q` remains the primary quit key; keep both the SIGINT/SIGBREAK handlers and the `ctrl+c` router branch, and re-verify on any Bun upgrade instead of assuming either path. Reproduction scripts live in `ts/scripts/verify/`. (SPEC 22.6)
- **Cell width must come from East Asian Width**, not `string.length`: the skills view renders CJK, and ratatui/OpenTUI count a Hanja glyph as 2 cells. Clipping must drop a wide glyph that straddles the edge rather than split the code point. (`ts/src/tui/line.ts`, SPEC 21.3)
- **`bun:ffi` returns `bigint` for `i64`**: handle comparisons like `=== 0` silently fail; normalize with `Number()`. (`console.ts`, `shrink.ts`)
- **OpenTUI render constraints**: text content is write-once per frame in practice (rebuild changed row handles), no absolute positioning in the test renderer (stream rows top-to-bottom), no whole-screen bg fill (pad every row to full width with a `window_bg` run), and `resize()` on the test renderer crashes — snapshot `TuiLine[]` instead. (SPEC §22.5)
- **The changelog Range request needs `Accept-Encoding: identity`** on both TS editions (Bun throws `ZlibError` on a gzipped 206; the Node edition keeps the header as a defensive parity measure). (SPEC 17.2, §22.4)
- *(historical, condition-dependent)* `--use-system-ca` can only be passed to `bun run` — not baked into the compiled exe — so on machines where AV re-signs TLS that build degrades silently to `checkFailed`; the Node SEA build bakes the flag in via `execArgv` and is unaffected. M4 re-measurement (2026-09-20): the interception does not currently reproduce on this machine. (SPEC §22.4)
- **`process.execPath` is the TS `current_exe()`**: under `bun run dev` / `npm run dev` that is the runtime binary (`bun.exe` / `node.exe`), so portable mode and the autostart value only make sense for the compiled exe. (SPEC §22.3)

Node-edition-only traps (`ts-nodejs/`; SPEC §22.5/§22.6):

- **The 250 ms draw heartbeat is the event loop's keep-alive anchor — never `unref` it**: a pending promise does not hold Node's loop open and a piped stdin holds no handle; the heartbeat is cleared by the unified teardown path on quit. (SPEC §22.5)
- **Erasable-syntax-only TypeScript**: Node type stripping rejects enums, namespaces and constructor parameter properties at load time (M2-N hit this with a parameter property in `screen.ts`). `npm run typecheck` must stay at 0 errors. (SPEC §22.5)
- **`--use-system-ca` needs Node ≥ 24.6** (`engines` pins it) and — unlike the Bun build — the SEA exe gets it baked in via `execArgv`, so the GitHub API fallback works in the compiled build too. (SPEC §22.4)
- **`sanitize()` is the only injection firewall**: with a handwritten renderer there is no widget-level escape immunity; every external string passes `sanitize()` before entering a frame, and the tests pin an injection case. (SPEC §22.5)
- **The startup shrink is a graceful no-op today**: the env-var heuristic (any of `WT_SESSION`/`TERM_PROGRAM`/`ConEmuPID` → shared console, never resize) is correct, but current ConPTY forwards no window-op escapes, so `ESC[8;13;72t` does nothing on WT 1.24/conhost (measured 2026-09-20). (SPEC §22.6)
- **Terminal restore is registered before terminal init**, and `createTerminal()` itself writes LEAVE before rethrowing a setup failure (a thrown `setRawMode` must not strand the alternate screen). (SPEC §22.5)

## Security considerations

- The OAuth token / API key is **read-only** from local Kimi Code CLI files and is sent only to `https://api.kimi.com/coding/v1/usages` as a Bearer token. It must never be logged, persisted elsewhere, or sent to any other endpoint.
- No admin rights: autostart writes only `HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Run` (key `KimiPlanbarTui`); nothing touches HKLM or Program Files.
- The app is unsigned; SmartScreen warnings are expected and documented in the README.
- Logo/branding copyright belongs to Moonshot AI; this is an unofficial community tool — keep the non-affiliation notice in the README. Keep `LICENSE` (MIT © Shawn Qi) and `NOTICE` (portions © baigong-ai / kimi-planbar) attribution intact.
