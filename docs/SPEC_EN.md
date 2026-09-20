# Kimi Planbar TUI — Technical Specification (SPEC)

> 中文版：[SPEC.md](SPEC.md)（identical chapter numbering for cross-reference）
>
> This document is the project's **single authoritative specification** (single source of truth), in two parts:
> - **Part 1 — Project specification** (chapters 1–9): goals, architecture, data flow, security, build & release, maintenance boundaries
> - **Part 2 — UI & behavior specification** (chapters 10–22): colors, layout, API parsing, persistence, and every numeric detail; chapter 22 registers the mechanisms where each TS edition is not equivalent to Rust
>
> Chapter numbering matches the tray edition's (kimi-planbar-tray) SPEC for cross-reference; **chapter 10 (window spec), chapter 14 (tray behavior), and chapter 15 (animations) do not apply to the TUI edition** and are short stubs explaining why. Where content is identical to the tray edition, the contract is restated in full — this document stands alone and does not depend on the tray edition's SPEC.
>
> `SPEC x.y` citations in code comments refer to chapter numbers in this document; check the corresponding Part 2 chapter before changing behavior, and update the chapter whenever behavior changes.
>
> TS-edition implementation deltas (Bun + OpenTUI in `ts/`, Node 24 + handwritten ANSI in `ts-nodejs/`) are registered in chapter 22 of this document, filed under its chapter numbers.

---

# Part 1 — Project specification

## 1. Overview

### 1.1 Goal

A terminal-resident dashboard for Windows (no tray, no windows, no animations) that keeps Kimi Code plan quota visible inside a terminal: 5-hour window and weekly usage rows, reset countdowns, Extra Usage (booster wallet) balance and monthly usage, plus Kimi Code CLI update notices, a read-only skills list, and browser jumps to Console / Releases.

### 1.2 Scope

- Read the local Kimi Code CLI credentials and call `GET https://api.kimi.com/coding/v1/usages`
- Three terminal views: main dashboard, settings form, read-only skills list
- Follow-system theming (Moonlit light / Moondark dark, terminal truecolor), configurable refresh interval, launch at Windows startup (HKCU), portable mode (portable.dat)
- CLI version check (official changelog first, GitHub API fallback)
- Headless self-check commands (`--test-fetch` / `--test-update`)

### 1.3 Non-goals

- **Unofficial community tool**, not affiliated with Moonshot AI (logo / branding copyright belongs to Moonshot AI)
- Never modifies any Kimi Code CLI file (credentials are read-only)
- No telemetry, no data reporting, no third-party analytics
- Windows 10/11 only; no macOS / Linux
- No tray residency and no desktop windows — that is the sibling project kimi-planbar-tray's domain; this repo is a pure terminal application

## 2. Terminology

| Term | Meaning |
|---|---|
| Moonlit / Moondark | Light / dark theme pair (color values in chapter 11) |
| Extra Usage / booster wallet | The booster wallet; balance unit trap in 16.3 |
| portable mode | When an empty `portable.dat` sits next to the exe, settings are stored beside the exe (see 18.1) |
| view | A full-screen terminal interface: dashboard / settings / skills — the TUI counterpart of a "window" |
| `SPEC x.y` | A code-comment reference to a chapter number of this document |

## 3. System architecture

### 3.1 Repository structure

Monorepo layout (mirroring the tray edition's kimi-planbar-tray): the Rust crate lives in `rust/` (not a workspace); the TS edition has two parallel implementations — Bun + OpenTUI in `ts/`, Node 24 + handwritten ANSI in `ts-nodejs/` — and all three editions share this behavior contract:

- `rust/Cargo.toml` / `rust/Cargo.lock` — package and binary name are both `kimi-planbar-tui`
- `rust/src/` — backend core modules (ported from the tray edition's `rust/src-tauri/src/` with Tauri removed) + `rust/src/format.rs` (formatting helpers ported from the tray frontend's `src/common.ts`) + `rust/src/app.rs` and `rust/src/ui/` (all-new code: event loop and ratatui view layer)
- `ts/package.json` / `ts/tsconfig.json` — package name `kimi-planbar-tui-ts`, independent version starting at 0.1.0
- `ts/src/core/` — the ten core modules behaving 1:1 with the Rust core (credentials, quota, polling, settings, skills, update, format, theme, state, strict JSON); importing any `@opentui` symbol there is forbidden
- `ts/src/tui/` — the OpenTUI render layer (line / dashboard / settingsView / skillsView / renderer / app / console / shrink), strictly separated from core so it can be replaced wholesale
- `ts-nodejs/package.json` — package name `kimi-planbar-tui-ts-nodejs`, independent version starting at 0.1.0
- `ts-nodejs/src/core/` — the same ten modules ported from `ts/src/core/` (only three `Bun.*` call sites replaced with `node:child_process`; everything else byte-identical)
- `ts-nodejs/src/tui/` — the handwritten-ANSI render layer (ansi / wcwidth / screen / terminal) plus the views (dashboard / settingsView / skillsView / app); no TUI library at all
- `docs/` — this specification (`SPEC.md` / `SPEC_EN.md`), shared by all three editions; **the mechanisms where either TS edition is not equivalent to the Rust edition are registered in chapter 22**, filed by this document's chapter numbers
- Root: `AGENTS.md`, `README.md`, `README_CN.md`, `LICENSE`, `NOTICE`

### 3.2 Process and view model

Single process, single terminal. On startup the app enters terminal raw mode + alternate screen and runs one `tokio::select!` event loop; the three views (dashboard / settings / skills) are states of a full-screen-switching state machine — there are no window handles, no z-order, no show/hide concepts.

**No single-instance mutex**: unlike the three tray editions (which share `KimiPlanbarTray.SingleInstance`), the TUI edition allows multiple instances side by side (one per terminal window is a normal usage pattern) and creates no named mutex at all.

Event loop architecture:

```
tokio::select! {
    crossterm EventStream (keyboard/resize) → App state machine → ratatui redraw
    polling mpsc (quota result/failure)     → update state → redraw + footer timestamp
    update mpsc (version check result)      → version row badge
    theme polling tick (30 s)               → swap palette in system mode
}
```

Redraw is event-driven: every event triggers an immediate redraw at the top of the loop, and a 250 ms heartbeat tick wakes the loop when idle so countdown text stays fresh. Countdown text is recomputed on every redraw (`format_reset` input is `reset_at - now`); no dedicated per-second timer is needed (see chapter 20).

### 3.3 Backend modules (`rust/src/`)

| Module | Responsibility |
|---|---|
| `main.rs` | Entry; `--test-fetch` / `--test-update` self-checks print and exit; terminal setup/restore (raw mode + alternate screen + panic hook) |
| `credentials.rs` | Credential chain (credentials json → config.toml fallback), read-only |
| `quota.rs` | usages API fetch + defensive JSON parsing (+ parsing unit tests) |
| `polling.rs` | Refresh scheduling: first refresh 2 s after launch, 30 s fast retry on failure, back to normal interval on success, keep-last-good; notifies the UI via `tokio::sync::mpsc` |
| `settings.rs` | settings.json persistence, portable.dat detection, HKCU autostart |
| `skills.rs` | Read-only scan of local skills (scan once on first open, then cached; includes frontmatter parser unit tests) |
| `update.rs` | `kimi --version` + changelog Range request + GitHub API fallback |
| `theme.rs` | Moonlit/Moondark palettes (ratatui `Color::Rgb`); system theme = read registry once at startup + 30 s polling |
| `state.rs` | AppState shared state (last-good cache, skills cache, manual-refresh debounce) |
| `app.rs` | TUI bootstrap + event loop (`tokio::select!`; all-new code) |
| `format.rs` | Formatting helpers: `format_reset` (12.3), `fmt_yuan` (12.5), percent display rules (ported from the tray frontend's `src/common.ts`) |
| `ui/` | ratatui view layer (all-new code): dashboard, settings form, skills list |

### 3.4 Frontend/backend boundary

No IPC, no separate frontend process: core modules and the view layer share one process and communicate via mpsc messages and shared state. Counterparts of the tray edition's Tauri IPC commands:

| Tray-edition IPC | TUI counterpart |
|---|---|
| `get_state` / `refresh_now` | Read AppState directly / `r` key triggers refresh (2 s debounce) |
| `save_settings` | Settings form Save: write JSON → autostart → theme → reschedule timer |
| `get_skills(refresh)` | Skills view reads the cache on first open; rescan key forces a rescan |
| `open_releases` / `open_console` | `g` / `c` keys open the corresponding URL in the browser |
| `quit_app` | `q` key quits (restores the terminal, then exits the process) |

### 3.5 View layer

One file per view under `rust/src/ui/`. All colors come from the `theme.rs` palette (the single source of Moonlit/Moondark colors). External data (skill names/descriptions, API fields) is always rendered through ratatui text widgets — never splice external strings into terminal escape sequences.

## 4. Tech stack and key dependencies

- **ratatui** — TUI framework (layout, widgets, styling)
- **crossterm** — cross-platform terminal backend and event source (keyboard / resize)
- **tokio / reqwest / serde(_json)** — async runtime, HTTP, JSON
- **winreg** — registry (HKCU Run autostart, system theme `AppsUseLightTheme`)
- **windows 0.61** (Win32_Foundation + Win32_System_Console) — conhost sequence for the minimal-window-on-launch feature (see chapter 20)
- **regex / chrono** — version parsing, reset countdown math

No Tauri, no WebView, no YAML crate (frontmatter is parsed by hand, line-based). All dependencies come from the same ecosystem as the tray edition's `rust/src-tauri/Cargo.toml` — zero new ecosystem risk.

## 5. Data flow

```
~/.kimi-code credentials (read-only)
   → credentials.rs loads token
   → quota.rs fetches + parses (traps in 16.3)
   → AppState (keeps last good values)
   → polling mpsc notifies the UI
   → dashboard renders rows + footer timestamp
```

- Settings: settings form Save → `settings.rs` writes JSON (path in 18.1) → apply theme/autostart/reschedule timer
- Skills: entering the skills view → first scan of local directories cached in AppState; nothing is written back
- Version check: async in the background; result pushed to the version row via mpsc

## 6. Security and privacy

- The OAuth token / api_key is **read-only** from local Kimi Code CLI files and is sent only as a Bearer token to `https://api.kimi.com/coding/v1/usages`; it is never logged, never persisted elsewhere, never sent to any other endpoint
- No admin rights needed: autostart writes only `HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Run` (value `KimiPlanbarTui`); nothing touches HKLM / Program Files
- The exe is not code-signed; SmartScreen warnings are expected (documented in the README)
- Branding assets use the official Kimi logo (copyright Moonshot AI); keep `LICENSE` (MIT © Shawn Qi) and `NOTICE` (portions © baigong-ai / kimi-planbar) attribution intact — they must not be removed

## 7. Build, test, release

### 7.1 Build

Prerequisites: Windows + Rust stable (MSVC). No Node.js, no WebView2, no other runtime.

```bash
cd rust
cargo build --release   # single static exe → rust/target/release/kimi-planbar-tui.exe (~3-5 MB)
cargo run               # dev run (debug builds work fine — there is no embedded frontend)
```

Terminal requirements: **Windows Terminal / VS Code integrated terminal are the baseline**; legacy conhost needs `chcp 65001` first (switch to the UTF-8 code page) or box-drawing glyphs and CJK text render garbled.

The release exe embeds a Windows VERSIONINFO resource and the app icon via `rust/build.rs` (`winresource` build-dependency, `rust/assets/icon.ico` — the Kimi logo, attribution in NOTICE): FileDescription / ProductName / CompanyName / LegalCopyright / Comments are fixed strings, while FileVersion/ProductVersion are taken automatically from `CARGO_PKG_VERSION` — **`rust/Cargo.toml` stays the single version source**. An embedding failure only emits `cargo:warning` and never fails the build (machines without the Windows SDK rc.exe still compile; the exe simply lacks metadata).

The **TS edition** (prerequisites: Windows + Bun ≥ 1.3, no Cargo involved):

```bash
cd ts
bun install
bun run dev          # dev run (bun ... src/main.ts)
bun run build:exe    # single-file exe → ts/dist/kpt-tui.exe (embeds the Bun runtime, ~90 MB)
```

The same terminal baseline applies. `ts/dist/` is gitignored; binaries never enter the repository.

### 7.2 Testing

- `cargo test`: skills frontmatter parser unit tests (ported from the tray edition) + quota JSON parsing unit tests (mixed string/number fields, `isEnabled=false`, unit rounding, divide-by-zero) — the first real parsing test suite in the project family
- **TS edition (Bun)**: `cd ts && bun run test` (`bun:test`, cases ported 1:1 from the Rust unit tests plus exact-equality assertions against Rust oracle goldens; the script pins the timezone to `Asia/Shanghai` — plain `bun test` breaks the goldens). Cross-edition consistency: `bun run parity` diffs both headless self-checks against the local Rust exe back to back, and `bun run test/parity/diff.ts --ts-exe dist/kpt-tui.exe` does the same for the compiled build. Method and exemptions: §22.1
- **TS edition (Node)**: `cd ts-nodejs && npm test` (`node:test` plus the bundled `bun-shim`; same cases as the Bun edition; TZ pinned by `scripts/run-tests.mjs`). `npm run parity` and `node test/parity/diff.ts --ts-exe dist/kpt-tui-node.exe` mirror the above; `npm run typecheck` must stay at 0 errors. Same golden set and back-to-back method (§22.1)
- Headless self-checks (details in chapter 19): `--test-fetch` / `--test-update`; with no mutex they naturally coexist with running instances
- Consistency check: run `--test-fetch` back to back with the tray edition on the same machine and diff the JSON field by field
- Visual check: manually compare against chapters 11/12 in Windows Terminal under both themes
- Before delivery, dispatch an independent subagent for code review per the user's global rules

### 7.3 Release

1. Version bump: `rust/Cargo.toml` (currently the only version source; sync any packaging script if one is added later)
2. `cd rust && cargo build --release` produces the single exe
3. Upload to GitHub Releases manually; **do not commit binaries** (release artifacts are gitignored)
4. Versioning is independent of the tray edition (kimi-planbar-tray) and starts at 0.1.0

## 8. Runtime requirements

- Windows 10 / 11
- Terminal: Windows Terminal or VS Code integrated terminal (baseline); legacy conhost needs `chcp 65001`; truecolor support required (all of the above have it)
- Kimi Code CLI installed and signed in, with a Kimi For Coding plan
- Network access to `api.kimi.com`

## 9. Maintenance boundaries and document map

- This repo is maintained independently; it shares only the data contract with the tray edition (credential chain, settings.json schema, API parsing rules). When behavior is ambiguous, Part 2 of this document is the contract
- Core modules stay behaviorally identical to the tray edition's `rust/src-tauri/src/`; the tray repo is the reference implementation

| Document | Role |
|---|---|
| `README.md` / `README_CN.md` | User-facing: features, install, keys, build |
| `docs/SPEC.md` | The single authoritative spec: project-level + UI/behavior details (Chinese) |
| `docs/SPEC_EN.md` | This document — English version of the spec (identical chapter numbering) |
| `AGENTS.md` | Onboarding index for AI coding agents (structure, commands, trap summary) |

---

# Part 2 — UI & behavior specification

> All "coordinates/sizes" are terminal character cells (columns × rows), not pixels. All UI copy is in English (terminology aligned with the Kimi console: Weekly usage / 5-hour usage / Extra Usage).

---

## 10. Window specification

**This chapter does not apply to the TUI edition.** The TUI edition has no desktop windows: no frameless windows, transparent backgrounds, topmost flags, taskbar entries, DIP sizes, shadows, focus-loss auto-hide, or window singleton reuse. The terminal counterpart — the view-switching model — is described in 3.2; the dashboard layout is chapter 12, the settings form chapter 13, and the skills list chapter 21.

---

## 11. Color scheme

### 11.1 Palette (terminal truecolor mapping)

The ten brush colors of tray-edition SPEC 11.1 (alpha is always `FF`, simply stripped) map to ratatui `Color::Rgb` with unchanged values:

| Palette key | Light (Moonlit) | Dark (Moondark) |
|---|---|---|
| `accent` (accent / gauge fill) | `#1A88FF` | `#1A88FF` |
| `window_bg` (screen background) | `#F3F4F6` | `#17191E` |
| `card_bg` (card background — currently unused by the wireframe UI, which draws no card backgrounds; kept in the palette spec) | `#FFFFFF` | `#23262D` |
| `text_primary` | `#1F2329` | `#F2F3F5` |
| `text_secondary` | `#6B7280` | `#9AA0A8` |
| `progress_track` (gauge track) | `#E5E7EB` | `#3A3E47` |
| `button_bg` (button / focused-row background) | `#E9ECF0` | `#2C3039` |
| `button_hover` (hover / highlighted-row background) | `#DCE2E9` | `#3A404B` |
| `badge_bg` (new-version badge background) | `#FFF0E0` | `#3D2E1A` |
| `badge_fg` (new-version badge text) | `#E06D00` | `#F0A040` |

- The accent color (Moonshot blue) is identical in both themes: `#1A88FF`.
- Selected state (settings form cursor row, skills list highlight row): `text_primary` text on a `button_hover` background. Fixed white (`#FFFFFF`) text on an `accent` background marks the *current value* instead — the active refresh-interval pill and the focused Save action row — the counterpart of the tray edition's "selected radio/checkmark text is always White" rule.
- The terminal must support truecolor (Windows Terminal / VS Code terminal both do); appearance is not guaranteed on terminals without truecolor.

### 11.2 Bar colors

- **No usage-band coloring**: the bar fill is always `accent` (`#1A88FF`) and the track is always `progress_track`. There is no code that switches green/yellow/red by percentage.
- The bar is plain text spans: `█` (fill) + `░` (track); filled cells = `round(clamp(percent, 0, 100) / 100 × bar width)`, with the bar width adapting to the terminal (see 12.2).

---

## 12. Main dashboard UI structure (dashboard view)

The layout is a vertical `ratatui::Layout` of plain text lines: **no card borders, no card backgrounds** (the design goal is kimi CLI `/usage`-style wireframe simplicity — a user decision that replaced the original card-block design). Each data row is a fixed 1-cell-high constraint, so short terminals no longer squeeze content away; the full-screen background is still filled with `window_bg` (painted by the view layer). Copy and formatting rules are identical to tray-edition SPEC 12; only the carrier changes from WebView cards to terminal text lines.

```
Kimi Planbar TUI                                    Updated HH:mm

5-hour usage   21%  █████░░░░░░░░░░░░░░░  Resets in 4h 30m
Weekly usage   18%  ████░░░░░░░░░░░░░░░░  Resets in 5d 15h

Extra Usage    ¥12.34
  Used ¥45.67 this month / ¥100 limit       (only when monthly limit enabled)

Kimi Code CLI  2.0.1   Update available

r Refresh · s Settings · k Skills · c Console · g Releases · q Quit
```

### 12.1 Title row (1 row)

- Left: title `"Kimi Planbar TUI"`, `text_primary`, bold
- Right: last-updated time, `text_secondary`, right-aligned:
  - No data: empty string
  - Error: `"Update failed"`
  - Normal: `"Updated HH:mm"` (`fetched_at` local time, 24-hour)

### 12.2 Usage lines (two lines, 1 row each, fixed)

"5-hour usage" first, "Weekly usage" second; same structure:

- Label: fixed 14 cells wide, `text_secondary`
- Percent: default `"--"`, `text_primary`, bold; after data arrives `{percent:0}%` (display uses the raw unclamped percent; the bar uses the clamped value)
- Bar: plain text spans — `█` (fill, `accent`) + `░` (track, `progress_track`), see 11.2; width adapts to the terminal (whatever remains after label + percent + countdown text); the whole bar is dropped when fewer than 5 cells remain (very narrow terminals)
- Reset countdown: `text_secondary`, at the end of the line, format in 12.3; omitted when there is no `resetTime`, in which case the bar takes the full remaining width

### 12.3 Reset countdown format (`FormatReset`, `span = at - now`)

- `span < 0`: `"Resets soon"`
- `>= 1 day`: `"Resets in {int(TotalDays)}d {Hours}h"` (e.g. `Resets in 4d 3h`)
- `>= 1 hour`: `"Resets in {int(TotalHours)}h {Minutes}m"`
- `< 1 hour`: `"Resets in {max(1, Minutes)}m"` (always at least 1 minute)
- No `resetTime`: empty string
- Countdowns are recomputed on every redraw (redraw mechanism in chapter 20); there is no dedicated per-second timer

### 12.4 Extra Usage lines (1–2 rows)

- Line: label `"Extra Usage"` (14-cell label column, `text_secondary`) + balance (default `"--"`, bold, `text_primary`)
- Balance copy has three states (`ExtraState`):
  - `Ready`: show `FmtYuan` (see 12.5) when `balance_cents` is present, otherwise `"--"`
  - `NoData`: `"No data"`
  - Otherwise (`NotActivated`): `"Not activated"`
- Monthly sub-line (indented 2 spaces, `text_secondary`): shown only when `monthly_enabled && monthly_limit_cents > 0 && monthly_used_cents.is_some()`; a single plain-text line `"Used {FmtYuan(used)} this month / {FmtYuan(limit)} limit"` (the wireframe layout has no monthly bar)

### 12.5 Money formatting (`FmtYuan`, cents → yuan)

- Negative: `"-" + FmtYuan(-cents)`
- `¥{cents/100}`, appending `.{frac:00}` when the remainder is > 0; whole yuan omit the fraction. Examples: `1234 → "¥12.34"`, `10000 → "¥100"`

### 12.6 Version row (1 row)

- Label `"Kimi Code CLI"` (14-cell label column, `text_secondary`); after it:
  - Local version: default `"--"`, then the local version number or `"Not detected"`, `text_primary`
  - New-version badge: hidden by default; when an update exists shows `" Update available "` with `badge_bg` background and `badge_fg` text
- The `g` key opens the browser at `https://github.com/MoonshotAI/kimi-code/releases` (errors silently swallowed) — the counterpart of the tray edition's clickable row

### 12.7 Footer (1 row) and keys

- Fixed hint line: `"r Refresh · s Settings · k Skills · c Console · g Releases · q Quit"`, `text_secondary`
- Full key map:

| Key | Action |
|---|---|
| `r` | Manual quota + version refresh, **2 s debounce** (repeat triggers within 2 s of the last manual refresh are silently ignored) |
| `s` | Open the settings form (chapter 13) |
| `k` | Open the read-only skills list (chapter 21) |
| `c` | Open `https://www.kimi.com/code/console?from=kfc_overview_topbar` in the browser (errors silently swallowed) |
| `g` | Open the kimi-code Releases page in the browser (errors silently swallowed) |
| `q` | Restore the terminal and quit |
| `↑/↓` | Move within lists/forms |
| `Enter` | Confirm |
| `Esc` | Back to the previous view |

---

## 13. Settings form (settings view)

The tray edition's settings window is translated into a terminal form: options and defaults unchanged, control semantics mapped one-to-one (radio pills → option lists, checkbox → checkbox row, button → action row).

### 13.1 Form structure

Full-screen view, title `"Kimi Planbar TUI Settings"`; `↑/↓` move between fields, `←/→` or `Enter` change the focused field's value, `Esc` discards changes and returns to the dashboard.

### 13.2 Settings items (options and defaults identical to tray-edition SPEC 13.2)

| Setting | Control shape | Options | Default |
|---|---|---|---|
| Theme | three-option list | `"System default"`=system, `"Moonlit (light)"`=light, `"Moondark (dark)"`=dark | `"system"` |
| Refresh interval | four-option list | `"1 min"`, `"5 min"`, `"10 min"`, `"30 min"` | `5` |
| Launch at startup | checkbox row `"Launch at Windows startup"` | bool | `false` |
| Save | action row `"Save"` (triggered by `Enter`) | — | — |

- Save action order is unchanged: write `settings.json` → apply autostart (18.3) → apply theme → reschedule the refresh timer → return to the dashboard.
- Opening the form pre-fills selections from the current settings.

---

## 14. Tray behavior

**This chapter does not apply to the TUI edition.** The TUI edition has no system tray: no tray icon, tooltip, left-click toggle, right-click menu, or hover-to-refresh. The tray edition's "hover prefetches quota (10 s throttle)" has no counterpart here — quota freshness is guaranteed by fixed-interval polling (16.5) and the `r` manual refresh (12.7).

---

## 15. Animations

**This chapter does not apply to the TUI edition.** The TUI edition has no animations at all: no slide-in/out, no fades, no hover glow. Terminal view switches and focus highlights are instantaneous; bar width changes are set directly, without transitions.

---

## 16. Data & API (quota)

> This chapter is identical to tray-edition SPEC 16 and is restated in full below.

### 16.1 Request

- URL: `GET https://api.kimi.com/coding/v1/usages`
- Headers: `Authorization: Bearer {token}`, `Accept: application/json`
- HTTP timeout **10 seconds**; non-2xx → failure path

### 16.2 Credential loading priority chain (`load_token`)

- `<kimi_home>` defaults to `%USERPROFILE%/.kimi-code/` and honors the `KIMI_CODE_HOME` environment override (same convention as 21.2).
1. **`<kimi_home>/credentials/kimi-code.json`**:
   - Read `access_token` (string)
   - Validate `expires_at` (Unix seconds, number) > current UTC time + **30 s** margin; treat expired as invalid and continue
   - Parse errors silently swallowed
2. **Fallback `<kimi_home>/config.toml`** (hand-written line parser, not a full TOML parser):
   - Split into `[section]`s; regex `^(base_url|api_key)\s*=\s*"([^"]*)"` extracts key-values
   - Match condition: section name starts with `"providers."` **and** `base_url` contains `"api.kimi.com/coding"` **and** `api_key` is non-empty → return that `api_key`
   - Settle the previous section when a new section starts; settle the last section at EOF
3. Neither available → return a result with `error = "no-token"`

### 16.3 Response JSON parsing

- **5-hour segment**: `root.limits` (array, take element 0's `detail` object) → `parse_segment`
- **Weekly segment**: `root.usage` (object) → `parse_segment`
- `parse_segment`: `percent = used/limit*100` (`used`, `limit` accept numbers or numeric strings, missing treated as 0; `limit<=0` treated as 1 to avoid divide-by-zero); `resetTime` (string, RFC 3339 parse) → `reset_at`
- **Extra Usage**: `root.boosterWallet` (object):
  - Not an object / missing → `state = NotActivated` ("Not activated")
  - `isEnabled == false` → `NotActivated` (defense: when the booster is not enabled, `amountLeft` is a "monthly limit minus used" estimate, not a real balance — must be treated as not activated)
  - `balance.amountLeft` (numeric string, numeric fallback tolerated) parseable → `state = Ready`; unit is **1e-8 yuan**, convert to cents: `balance_cents = (raw + 500000) / 1000000` (round half up)
  - Otherwise → `state = NoData` ("No data")
  - `monthlyChargeLimitEnabled == true` → `monthly_enabled=true`, `monthlyUsed.priceInCents` → `monthly_used_cents`, `monthlyChargeLimit.priceInCents` → `monthly_limit_cents` (unit: cents, numeric strings)
- **Note: all server JSON numbers are modeled as strings**, with numeric fallback tolerated at parse time.
- These rules are covered by `quota.rs` unit tests (mixed strings/numbers, `isEnabled=false`, unit rounding, divide-by-zero).

### 16.4 Data model (Rust structs)

```rust
QuotaSegment { percent: f64, reset_at: Option<DateTime<Local>> }
ExtraState   { NotActivated, NoData, Ready }
ExtraInfo    { state, balance_cents: Option<i64>, monthly_enabled: bool,
               monthly_used_cents: Option<i64>, monthly_limit_cents: Option<i64> }
QuotaResult  { five_hour: Option<QuotaSegment>, week: Option<QuotaSegment>,
               extra: Option<ExtraInfo>, fetched_at: DateTime<Local>, error: Option<String> }
```

(On error, `error` is the exception type name; the reference implementation's .NET-style names are kept so `--test-fetch` output can be diffed across editions: `"HttpRequestException"` / `"TaskCanceledException"` (timeout) / `"JsonException"` / `"no-token"`)

### 16.5 Refresh scheduling and failure retry (polling)

- Period = `max(1, refresh_minutes)` minutes; the timer's first delay is **2 seconds** (first refresh 2 s after launch), then the period
- On each refresh:
  1. Fetch + parse
  2. **Keep last good data on failure**: if this result has a non-empty `error` and a previous good value exists, fill null fields of `five_hour`/`week`/`extra` from the previous values (the UI is never cleared; only the title row shows `"Update failed"`)
  3. **30 s fast retry after failure**: the next fire is moved to 30 s (on success it returns to the normal period); the configured period itself does not change
  4. Notify the UI to redraw via mpsc

---

## 17. CLI version check (update)

> This chapter matches tray-edition SPEC 17; only the UI-presentation subsection is adapted for the TUI (badge on the version row, `g` key instead of a clickable row).

### 17.1 Local version

- Spawn a subprocess: `kimi --version` (no shell, no window, stdout/stderr both redirected)
- Wait up to **5000 ms** for exit; on timeout kill and return None
- Wait for exit before reading output (a single output line cannot fill the pipe buffer)
- Regex the combined stdout+stderr text for the first `\d+\.\d+\.\d+`
- Any error → None (the version row shows `"Not detected"`)

### 17.2 Latest version (two-level fallback)

1. **Official docs-site changelog** (preferred; the English version is most up-to-date; bypasses GitHub API rate limits and hosts blocking):
   - `GET https://moonshotai.github.io/kimi-code/en/release-notes/changelog.md`
   - Request header `Range: bytes=0-4095` (first 4 KB only; GitHub Pages may ignore Range and return a full 200 — both responses are handled)
   - Regex `^## (\d+\.\d+\.\d+)` (Multiline), first match is the latest version
2. **GitHub Releases API fallback**:
   - `GET https://api.github.com/repos/MoonshotAI/kimi-code/releases/latest`
   - Header `User-Agent: KimiPlanbarTui` (required, otherwise GitHub rejects)
   - Take `tag_name` (shaped like `"@moonshot-ai/kimi-code@0.31.1"`), regex out `\d+\.\d+\.\d+`
- HTTP timeout 10 s; if both fail → `latest = None`

### 17.3 Comparison and status

- `update_available = latest.is_some() && both parse as semver && latest > local`
- `check_failed = latest.is_none()` (silently degrades when the network is unreachable; no UI complaint)
- On completion, push a version-row update via mpsc
- Trigger timing: once in the background at startup; the `r` manual refresh also triggers it

### 17.4 UI presentation

- The version row shows `local ?? "Not detected"`
- When `update_available == true`, show the orange badge `"Update available"` (colors in 11.1 badge_bg/badge_fg)
- The `g` key jumps to `https://github.com/MoonshotAI/kimi-code/releases`

---

## 18. Settings persistence (settings)

> The mechanism in this chapter is identical to tray-edition SPEC 18; only the directory name and registry value name are the TUI edition's own.

### 18.1 Config file path (portable mode logic)

- **Portable mode**: if a `portable.dat` file exists next to the exe (content irrelevant, only existence is checked) → config directory = the exe's directory
- **Otherwise**: `%APPDATA%\KimiPlanbarTui\`
- Config file: `<ConfigDir>\settings.json`

### 18.2 JSON schema (serialized with indentation)

```json
{
  "Theme": "system",
  "RefreshMinutes": 5,
  "AutoStart": false
}
```

- `Theme`: `"system" | "light" | "dark"`, default `"system"`
- `RefreshMinutes`: int, allowed values 1/5/10/30, default 5
- `AutoStart`: bool, default false
- Load: missing file or deserialization failure → fall back to all defaults (errors silently swallowed)
- Save: create the directory first, then overwrite the whole file (errors silently swallowed)

### 18.3 Launch at Windows startup

- Registry: `HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Run` (per-user, no UAC prompt)
- Value name: `KimiPlanbarTui`
- `AutoStart=true` → value = `"{full exe path}"` (quoted)
- `AutoStart=false` → delete the value (no error if absent)
- Errors silently swallowed

---

## 19. Test / self-check commands (command-line args)

Self-check modes print to stdout and exit. This edition has **no single-instance mutex**, so self-checks naturally coexist with running instances (the tray edition's "run before the mutex check" rule has no counterpart here).

| Arg | Behavior | Output |
|---|---|---|
| `--test-fetch` | Fetch quota once, print JSON | `QuotaResult` as JSON (indented, non-ASCII not escaped) |
| `--test-update` | Run one version check | Single line: `local={x} latest={y} updateAvailable={bool} checkFailed={bool}` |

- No `--test-ui` (there are no windows to construct; the view layer is verified manually in a terminal against chapters 11/12).
- Unrecognized args are ignored and the TUI starts normally.
- Consistency check: run `--test-fetch` back to back with the tray edition on the same machine; the JSON should match field by field.

---

## 20. Miscellaneous implementation details (TUI-specific)

- **Terminal restore (highest priority)**: startup enters raw mode + alternate screen and hides the cursor; **every exit path must restore the terminal** (leave alternate screen, disable raw mode, show the cursor) — both a normal `q` quit and a panic (via a panic hook that restores before printing). Leaving the user's terminal stuck in raw mode is the worst possible TUI accident. The TS editions' equivalent mechanisms (Bun: raw mode must be set explicitly through `bun:ffi SetConsoleMode` and re-asserted before every input event and redraw; Node: Node handles raw mode itself, but the restore handlers must be registered before terminal init) live in §22.5.
- **Minimal window on launch (72×13)**: at the start of `run()`, before terminal init, the window is shrunk to the wireframe's minimal size (72 columns × 13 rows, constants `MIN_WIN_COLS`/`MIN_WIN_ROWS`). **Guard**: this only happens when the process owns its console outright — `GetConsoleProcessList` returns exactly 1 attached process (a double-click / fresh-window launch); when launched from an existing terminal session (cmd / pwsh / Git Bash / another WT tab) the console is shared and the user's window is never touched. Two best-effort channels, errors silently swallowed: (a) the xterm window-manipulation escape `ESC [ 8 ; 13 ; 72 t` (honored by Windows Terminal 1.22+); (b) the conhost Win32 sequence: `SetConsoleWindowInfo` to a 1×1 viewport → `SetConsoleScreenBufferSize(72,13)` → `SetConsoleWindowInfo` to the full 72×13 rect. **TS edition (Bun) uses the same guard and both channels** — `GetConsoleProcessList` is reachable through `bun:ffi`; the by-value struct packing is noted in §22.6. **TS edition (Node)**: with no Win32 binding, the guard is an environment-variable heuristic only (`WT_SESSION`/`TERM_PROGRAM`/`ConEmuPID` all absent → shrink) and channel (a) alone — and measurements show current ConPTY does not forward that window-op escape, so it is a graceful no-op on this machine (§22.6).
- **Event-driven redraw + 250 ms heartbeat**: every event (keyboard, quota mpsc, version mpsc, skills mpsc, theme tick, resize) triggers an immediate redraw at the top of the event loop — there is no coalescing/throttling (any event produces a frame right away). A 250 ms heartbeat tick (`draw_tick`) additionally wakes the loop when idle so countdown text stays fresh; countdown text is recomputed on every redraw (input `reset_at - now`), so there is no 1 Hz timer.
- **System theme 30 s polling**: crossterm has no system-event source, so with `theme=system` the app polls the registry value `AppsUseLightTheme` under `HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize` (DWORD, 0=dark, 1=light, default 1 if missing) every 30 s — replacing the tray edition's real-time `WM_SETTINGCHANGE` listener; with `theme=light|dark` this polling does not affect the palette.
- **No single-instance mutex**: multiple instances are allowed (one per terminal); do not create `KimiPlanbarTray.SingleInstance` or any named mutex.
- **Startup order**: parse command line (self-check branches run first and exit) → shrink the owned window (only when the console is owned outright, see the previous bullet) → load settings → apply theme → initialize the terminal → start the event loop → first quota refresh after 2 s → background version check.
- **Error-handling baseline**: all IO, registry, subprocess, and HTTP failures are silently swallowed and surfaced only via UI text ("Update failed"/"Not detected") or state fields; never panic, never interrupt the TUI.
- **Money unit trap**: `amountLeft` is in 1e-8 yuan (convert to cents with `(raw + 500000) / 1000000`, round half up); `priceInCents` is already cents; JSON numbers are strings.
- **`isEnabled=false` trap**: when the booster is not enabled, `amountLeft` is not a real balance — the Extra Usage row must read "Not activated".
- **Terminal compatibility**: Windows Terminal / VS Code integrated terminal are the baseline (truecolor + UTF-8); legacy conhost needs `chcp 65001` or box-drawing glyphs and CJK text render garbled; appearance is not guaranteed on terminals without truecolor.

---

## 21. Skills read-only view

> The mechanism matches tray-edition SPEC 21 (read-only, zero background cost, scan once on first open and cache); presentation is translated into a terminal scrolling list.

### 21.1 View

- Full-screen view, title `"Kimi Skills"`; enter with `k`, return to the dashboard with `Esc`.
- Read-only: no enable/disable operations of any kind.

### 21.2 Data source and performance

- Three root directories: `<kimi_home>/skills` (label "Kimi Code"), `~/.agents/skills` ("Agents"), `<kimi_home>/plugins/managed/<plugin>/skills` ("Plugin: <name>"); `<kimi_home>` honors the `KIMI_CODE_HOME` override.
- Each `<dir>/<id>/SKILL.md` is read for at most the first 4 KiB to parse the YAML frontmatter's `name` / `description` (hand-written line parsing, surrounding quotes stripped, directory name as fallback; no YAML dependency). Bytes are decoded with `from_utf8_lossy`, tolerating multibyte characters cut at the 4 KiB boundary and mixed GBK bytes, and a UTF-8 BOM before `---` is stripped.
- No enabled/disabled state exists to display: Kimi Code does not persist per-skill disable state; `~/.agents/.skill-lock.json` is lark-cli's installer lock file (`{version, skills, dismissed}`, no `disabled` key) and is never read.
- **Zero background cost**: no polling, no file watching; scan once when the view is first opened and cache in AppState; the view's rescan key passes `refresh=true` to force a rescan.

### 21.3 Presentation

- Top summary line: `N skills` + rescan key hint.
- List grouped by source (sorted case-insensitively by name within each group), scrolled read-only with `↑/↓`; each item: name (bold) + description (truncated to the terminal width).
- All colors come from the `theme.rs` palette and follow Moonlit/Moondark automatically.
- External data (skill names/descriptions) is always rendered through ratatui text widgets — never spliced into terminal escape sequences.

---

## 22. TS-edition implementation deltas

> This chapter is the register of every mechanism where a TS edition — the Bun edition (`ts/`, Bun + OpenTUI) or the Node edition (`ts-nodejs/`, Node 24 + handwritten ANSI) — is not mechanically equivalent to the Rust edition, filed by this document's chapter numbers. The behavior contract in the preceding chapters is benchmarked on the Rust edition; every entry here is an implementation-level equivalence or a known deviation, all pinned by tests.

### 22.1 Verification method (maps to 7.2 / 19)

- **`--test-fetch` byte-parity contract**: the editions' outputs must be byte-identical except for the `fetchedAt` *value* — the single exemption, because Rust stamps nanoseconds from a 100 ns clock while JS `Date` has milliseconds. Both sides normalize it to `"fetchedAt": "<NOW>"` before diffing (`ts/test/parity/diff.ts`, `ts-nodejs/test/parity/diff.ts`).
- **Two bodies of evidence**:
  1. **Rust oracle goldens** (pure parsing and text formats): a throwaway cargo project reuses `rust/src/quota.rs` DTOs and parsers verbatim to produce `ts/test/golden/` (float text tables, chrono timestamp tables, the `from_str` matrix, 30 `QuotaResult` documents, a `settings.json` document; `ts-nodejs/test/golden/` is a copy of the same set). The TS tests assert **exact equality** against the goldens.
  2. **Same-machine back to back** (real network): `bun run parity` / `npm run parity` runs the Rust exe and the TS self-checks and diffs them. Measured: `--test-fetch` 19 lines identical, `--test-update` 1 line identical (success path, not the `no-token` branch); the compiled builds pass too (`--ts-exe`).
- Both TS editions pin the timezone to `Asia/Shanghai` for tests (Bun: `ts/package.json` script; Node: `ts-nodejs/scripts/run-tests.mjs`): the golden timestamps are `DateTime<Local>` and must be regenerated when the zone changes.

### 22.2 Data & API (maps to 16.2 / 16.3 / 16.4)

Both TS editions share one origin (the Node edition is ported from the Bun one), so their mechanisms are meant to match. **Current-state qualifier (2026-09-20)**: this round's M1 core fixes (JSON recursion limit, draining a non-2xx body, the resetTime ladder, the `RefreshMinutes` clamp, the polling clamp, the 4 KiB skills read) landed **in `ts/` only**; `ts-nodejs/` has not been ported yet and measures as the pre-fix version (including its 13-line `reset_time.txt`). The table below describes `ts/`; for the Node edition it only becomes true after the port. Until then, read the Node edition's deltas against this table and 22.6.

| Rust mechanism | TS equivalent | Pinned by |
|---|---|---|
| `str::parse::<f64/i64>()` | `parseF64Strict` / `parseI64Strict` (`core/json.ts`), whole-string match on Rust's grammar | `""`, `68abc`, `0x10`, `1_000`, `1 000` fail; `1.`, `.5`, `1e5`, `+68`, `inf`, `NaN` succeed; `i64` rejects fractions and exponents; out of range fails |
| `str::trim()` | `rustTrim`, the Unicode White_Space set: **includes U+0085, excludes U+FEFF** (JS's native `trim()` is exactly the opposite) | golden `parse_matrix` |
| `serde_json::Number::as_i64()` | `jAsI64`: only integer-shaped number tokens yield a value; `1.0` / `1e5` / `-0.0` yield none | golden `as_i64` |
| `i64` range | `bigint` throughout (`balanceCents`, `monthlyUsedCents`, `monthlyLimitCents`, `(raw+500000)/1000000`); truncating division and `saturating_add` are exact | quota tests |
| `f64` text | `formatF64`: serde_json/ryu shapes — always a decimal point or an exponent; fixed notation for decimal exponent ∈ [-5,15], otherwise `1e+16` / `1e-7` shapes; `-0.0` keeps its sign; non-finite values serialize as `null` | goldens `floats` + `float_grid` |
| `chrono`'s `DateTime<Local>` text | `RustDateTime{ms,nanos}` + `autoSiFraction`: the fraction is a 9-digit text with whole `000` groups stripped from the right (`.500000000`→`.500`), omitted entirely when zero; the offset is always `±HH:MM`, never `Z` | goldens `datetime` + `reset_time` |
| `resp.json()` failure | a strict in-house JSON parser (`parseJsonValue`): `1e400` raises `number out of range` → `JsonException`; a non-2xx response **drains** the body via `arrayBuffer()` before returning (Bun only returns a keep-alive connection to the pool once the body is consumed, whereas reqwest drops the connection — a mechanism difference, identical output); a body timeout after the headers is also a `JsonException` | quota tests |
| Numeric precision | JSON integer literals beyond 2^53: TS walks the token through `BigInt` and stays exact; the `as_f64` side is a double in both, no extra deviation | — |

### 22.3 Settings & system integration (maps to 18.1 / 18.2 / 18.3)

- **The `current_exe()` equivalent is `process.execPath`**: under `bun run src/main.ts` it is `bun.exe`, under `node src/main.ts` it is `node.exe`; only inside the compiled products (`bun build --compile`, SEA) is it the app exe. **Portable mode and autostart are therefore only meaningful for the compiled builds**; in dev mode `portable.dat` would be looked up next to the runtime binary and the autostart value would point at it. The Rust edition has no such ambiguity.
- `settings.json` writes are byte-identical to Rust: PascalCase keys, 2-space indent, **no trailing newline**; reads follow "a whole-document failure falls back to defaults; only a missing key falls back per key".
- **A `RefreshMinutes` beyond 2^53 clamps to `Number.MAX_SAFE_INTEGER`**: the i64 bound is checked entirely in `BigInt` (outside i64 → whole-document fallback, matching Rust's type error), but `Number(bigint)` would round past 2^53, so the value kept is clamped to the exactly-representable range; Rust preserves the i64 verbatim. The difference carries into polling: Rust uses `saturating_mul(60)`, so an extreme value means "effectively never refreshes again", while the TS delay is clamped a second time by the 32-bit `setTimeout` ceiling (`2_147_483_647` ms ≈ 24.8 days). Both editions agree for every sane value (1/5/10/30).
- The registry is only ever touched through spawned `reg.exe` with **GBK** decoding; autostart writes/deletes and never reads back. `AppsUseLightTheme` is read as the `REG_DWORD` text (`0x0`/`0x1`); any failure means light, the same as Rust's `unwrap_or(1)`.
- Theme resolution stays a pure function: `effectiveTheme(configured, system)`; the system value is cached by the 30 s poll and read synchronously on the render path (Rust polls in its event loop too).

### 22.4 Version check (maps to 17.1 / 17.2)

- The changelog Range request must carry **`Accept-Encoding: identity`**: Bun throws `ZlibError` when GitHub Pages answers 206 + gzip; the Node edition keeps the same header as a defensive parity measure. Rust's reqwest is unaffected.
- TLS trust: this machine's ESET used to intercept TLS, and its root is not in the runtimes' bundled CA stores.
  - **Bun edition**: the script paths pass `--use-system-ca`; `bun build --compile` cannot bake the flag into the binary, so under TLS interception the compiled exe's GitHub API fallback degrades silently to `checkFailed` (quota and the changelog path are unaffected). M4 re-measurement (2026-09-20): the interception does not currently reproduce.
  - **Node edition**: `--use-system-ca` needs Node ≥ 24.6 (`engines` pins `>=24.6.0`); `NODE_USE_SYSTEM_CA=1` works too. The SEA build **bakes `--use-system-ca` into the exe via `execArgv`** (no Bun-style degradation).
- `kimi --version` is spawned without a shell, killed after 5 s; stdout+stderr are concatenated in that order, decoded lossily, and the first `\d+\.\d+\.\d+` wins.

### 22.5 Palette & render layer (maps to 11.1 / 20)

**Shared by both TS editions**:

- SPEC 11.1 lists ten brushes; the `Palette` implementations carry nine (`card_bg` exists only in the spec).
- Cell widths follow East Asian Width: CJK/fullwidth/Hangul/emoji count 2 cells, combining marks and variation selectors 0, Ambiguous (`█ ░ · ¥ ● →`) 1. Clipping iterates codepoints and drops a 2-cell glyph that does not fit the remaining cell (matching ratatui's buffer behavior); surrogate pairs are never split. Rust gets this from unicode-width for free.
- Underline: for the selected interval row (SPEC 13.2) Rust adds `Modifier::UNDERLINED`; the Bun edition uses OpenTUI's `underline()` style, the Node edition emits SGR 4 directly.
- The skills scan runs on the next macrotask: a `Scanning...` frame paints first, then the scan runs — the counterpart of Rust's `spawn_blocking` + mpsc; a synchronous scan would stall redraws. The settings-save `reg.exe` autostart write stays synchronous (SPEC 13.2's save order requires it to finish first).

**Bun edition (OpenTUI render layer)**:

- Selection text: Rust goes through crossterm `Color::White` → SGR `37` (terminal-palette white), while OpenTUI's `"white"` resolves to `#FFFFFF`. The difference is only visible with a customized terminal palette.
- The screen background is composed per span: OpenTUI has no equivalent of ratatui's whole-screen `Block::bg`, and a text run without an explicit bg falls through to the terminal default. The adapter therefore merges `window_bg` as the base bg into every span without its own, pads each row to full width with a `window_bg` run, and fills vertical gaps with full-width blank rows.
- Measured OpenTUI constraints: text content is write-once per frame (changed rows are rebuilt), the test renderer ignores absolute positioning (stream rows top to bottom), `resize()` crashes the test renderer (snapshot `TuiLine[]` instead), and key events hang off `renderer.keyInput` (`renderer.on("keypress")` never fires).
- **raw mode difference (important)**: Bun's `process.stdin.setRawMode()` does not change the OS console mode on Windows, and Bun flips the console back to cooked on every stdin read. The countermeasure: `ts/src/tui/console.ts` calls `SetConsoleMode` through `bun:ffi` (clearing `ENABLE_PROCESSED_INPUT|ENABLE_LINE_INPUT|ENABLE_ECHO_INPUT`, setting `ENABLE_WINDOW_INPUT`; the `PROCESSED_INPUT` clear exists only for crossterm parity and does **not** make Ctrl+C work — see 22.6) and re-asserts raw mode before every input event and redraw; exit paths restore the original mode. Note the input handle is `(HANDLE)-10` = `0xfffffff6` (`0xfffffff5` is the output handle — M2 had this wrong); `bun:ffi` returns `bigint` for `i64`, so normalize with `Number()` before comparing.

**Node edition (handwritten ANSI render layer)**:

- The render layer is handwritten ANSI (`tui/ansi.ts`, `wcwidth.ts`, `screen.ts`, `terminal.ts`) with no third-party TUI library. The frame model is `TuiLine[]`; writes are **line-level diffs**: each row is compared with the previous frame and only changed rows emit `\x1b[{row};1H` + content; the first frame clears with `\x1b[2J\x1b[H`; frames are wrapped in DEC 2026 synchronized output (terminals that do not know the mode ignore it); the bottom row never fills its last cell (filling the bottom-right cell scrolls the whole screen — together with DECAWM off `\x1b[?7l` at entry, belt and suspenders).
- **`sanitize()` is the only injection firewall**: with no widget-level immunity, every external string (skill names/descriptions, API error text) passes through `sanitize()` before entering a frame (whole ANSI sequences — CSI/OSC — are stripped first, then leftover control characters); the tests include injection cases.
- The wcwidth table is an embedded codepoint interval table (`tui/wcwidth.ts`); no npm package.
- raw mode and the VT input/output modes are enabled by Node itself on a TTY (`ENABLE_VIRTUAL_TERMINAL_PROCESSING` / `ENABLE_VIRTUAL_TERMINAL_INPUT`) — no Win32 calls; but the restore handlers must be registered **before** terminal init (mirroring the Rust panic hook preceding terminal init), and `createTerminal()` itself wraps every step after ENTER in try/catch — on failure it writes LEAVE before rethrowing.
- **The 250 ms heartbeat timer must not be `unref`'d**: a pending promise does not keep Node's event loop alive, and a non-TTY stdin holds no handle — the heartbeat is the loop's keep-alive anchor and is cleared by the unified teardown path. The Rust/Bun editions have no such constraint.
- TS execution relies on Node's native type stripping, so only erasable syntax is allowed (no enum/namespace/parameter properties); `tsc --noEmit` must stay at 0 errors.

### 22.6 No single-instance mutex & minimal window on launch (maps to 20)

- **No single-instance mutex**: all three editions agree — multiple instances may run side by side, no named mutex exists.
- **Bun-edition shrink uses the same criteria as Rust**: `kernel32!GetConsoleProcessList` is reachable through `bun:ffi`, so ownership means exactly 1 attached process; the environment-variable heuristic is only a fallback when the FFI is unavailable; a non-TTY `stdout` never shrinks. Both shrink channels match Rust; only the argument passing differs — `COORD`/`SMALL_RECT` are by-value struct parameters and bun:ffi has no struct support, so they are hand-packed into integer registers per the x64 calling convention (`COORD = (y<<16)|x`; `SMALL_RECT`'s four i16 fields occupy bits 0/16/32/48).
- **Node-edition shrink is an environment-variable heuristic**: with no Win32 binding, any of `WT_SESSION`/`TERM_PROGRAM`/`ConEmuPID` present means a shared console and no resize ever; all three absent means `ESC[8;13;72t` is written to stdout before entering the alternate screen (errors silently swallowed). **Measured conclusion (2026-09-20, WT 1.24 / conhost, probed via a Start-Process'd fresh window and re-reading `stdout.columns`)**: current ConPTY does not forward window-manipulation escapes — CSI 8, CSI 4 (pixels) and `mode con` all fail to resize, so the sequence is a graceful no-op on this machine and the window keeps its default size; if a future ConPTY forwards window ops, it starts working by itself.
- **Ctrl+C cannot quit the Bun edition (measured 2026-09-20, WT 1.24 / conhost)**: `ts/src/tui/console.ts` clears `ENABLE_PROCESSED_INPUT` for crossterm parity (which also keeps Ctrl+B/Ctrl+H arriving as bytes), but under the Bun runtime Ctrl+C reaches the app **neither as a keypress nor as a JS SIGINT**, and both flag settings were measured: a bare bun process (console mode untouched, no handler installed, stdin unread) ignores Ctrl+C; the Rust edition (crossterm) quits from the same window under the same injected keystroke; and OpenTUI's parser does turn `0x03` into `{name:"c",ctrl:true}` (`ts/scripts/verify/parse-ctrlc.ts`). The event is swallowed inside the Bun runtime. **`q` is therefore the quit key for the Bun edition**; the SIGINT/SIGBREAK handlers and the `ctrl+c` router branch in `app.ts` stay (no behavior change today — they start working if a future runtime fixes this). Reproduction scripts: `ts/scripts/verify/`.
