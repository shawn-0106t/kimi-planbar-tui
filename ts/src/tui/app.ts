// TUI bootstrap + event loop for the M2 slice — the TS counterpart of
// rust/src/app.rs, restricted to the dashboard: no settings/skills routing
// and no window-shrink guard yet (both are M3 in TS-EDITION-PLAN §4).
//
// Loop shape mirrors the tokio::select! (SPEC 3.2 / 20): every event
// (keypress, quota publish, update result, theme tick, resize) redraws
// immediately; a 250 ms heartbeat only wakes the idle loop so countdown text
// stays fresh — countdowns are recomputed per redraw, there is no 1 Hz timer.
//
// Terminal discipline (SPEC 20): the renderer owns raw mode + alternate
// screen; EVERY exit path (q, ctrl+c, uncaughtException, unhandledRejection)
// goes through destroyRenderer() so the terminal is never stranded.

import { createPolling, type Polling } from "../core/polling.ts";
import { fetchQuota } from "../core/quota.ts";
import { loadSettings } from "../core/settings.ts";
import { createAppState, type AppState } from "../core/state.ts";
import { effectiveTheme, palette, refreshSystemThemeCache, systemThemeSync } from "../core/theme.ts";
import { checkUpdate, type UpdateStatus } from "../core/update.ts";
import { blankLine, padLineToWidth, type TuiLine } from "./line.ts";
import { footerLine, renderDashboardRows } from "./dashboard.ts";
import { createTuiRenderer, type KeyPress, type TuiRenderer } from "./renderer.ts";
import { enterRawMode, ensureRawMode } from "./console.ts";

/** SPEC 12.7: Console button URL. */
export const CONSOLE_URL = "https://www.kimi.com/code/console?from=kfc_overview_topbar";
/** SPEC 12.6: version row click target. */
export const RELEASES_URL = "https://github.com/MoonshotAI/kimi-code/releases";

/** SPEC 12.7: manual refresh debounce, ms. */
const MANUAL_REFRESH_DEBOUNCE_MS = 2_000;
const THEME_POLL_MS = 30_000;
const DRAW_HEARTBEAT_MS = 250;

/** SPEC 20 startup order: (window shrink is M3) -> load settings -> apply
 *  theme -> init terminal -> event loop -> 2 s first refresh -> update check. */
export async function runTui(makeRenderer: () => Promise<TuiRenderer> = createTuiRenderer): Promise<void> {
  const settings = loadSettings();
  const eff = effectiveTheme(settings.theme, systemThemeSync());
  const state: AppState = createAppState(settings, eff);

  const renderer = await makeRenderer();
  // OpenTUI's setupTerminal guards raw mode behind `if (stdin.setRawMode)`,
  // but Bun/Windows setRawMode is a no-op for the OS console mode, so the
  // console stays cooked and keys echo. Set raw mode ourselves AFTER the
  // renderer init so we are the last to touch the console mode (SPEC 20).
  const restoreConsole = enterRawMode();
  let destroyed = false;
  const destroyRenderer = (): void => {
    if (destroyed) return;
    destroyed = true;
    renderer.destroy();
    restoreConsole();
  };
  // A stranded terminal is the worst TUI bug (SPEC 20): restore before exit
  // on every path the loop does not control.
  process.on("uncaughtException", (err) => {
    destroyRenderer();
    console.error(err);
    process.exit(1);
  });
  process.on("unhandledRejection", (err) => {
    destroyRenderer();
    console.error(err);
    process.exit(1);
  });

  const app = {
    quota: null as Parameters<typeof renderDashboardRows>[0]["quota"],
    update: null as UpdateStatus | null,
  };

  const draw = (): void => {
    if (destroyed) return;
    ensureRawMode(); // Bun flips the console back to cooked on each stdin read
    const p = palette(state.effectiveTheme);
    const width = renderer.width;
    const height = renderer.height;
    const { rows } = renderDashboardRows({
      quota: app.quota,
      update: app.update,
      nowMs: Date.now(),
      width,
      palette: p,
    });
    const footer = footerLine(p, width);
    // Min(0) spacer equivalent: blank bg-filled rows between content and the
    // bottom-pinned footer; on too-short terminals the content clips from the
    // bottom and the footer stays visible.
    const body = rows.length + 1 <= height ? rows : rows.slice(0, Math.max(0, height - 1));
    const fillers = Array.from({ length: Math.max(0, height - body.length - 1) }, () =>
      padLineToWidth(blankLine(width, p.windowBg), width, p.windowBg),
    );
    const frame: TuiLine[] = height > 0 ? [...body, ...fillers, footer] : [];
    renderer.renderRows(frame, p.windowBg);
  };

  const polling: Polling = createPolling({
    state,
    fetchQuota,
    publish: () => {
      // The state already carries the keep-last-good fill (SPEC 16.5); the
      // view reads the newest result, error field included.
      app.quota = state.lastQuota;
      draw();
    },
  });
  polling.start(); // first refresh 2 s after start (SPEC 16.5)

  const spawnUpdateCheck = (): void => {
    void checkUpdate().then((status) => {
      app.update = status;
      state.update = status;
      draw();
    });
  };
  spawnUpdateCheck(); // SPEC 17.3: one background check at startup

  /** Manual refresh (SPEC 12.7): quota + version re-check, 2 s debounce. */
  const manualRefresh = (): void => {
    const last = state.lastManualRefreshMs;
    if (last !== null && Date.now() - last < MANUAL_REFRESH_DEBOUNCE_MS) return;
    state.lastManualRefreshMs = Date.now();
    void polling.safeRefresh();
    spawnUpdateCheck();
  };

  renderer.onKey((key: KeyPress) => {
    ensureRawMode(); // re-arm before the next keystroke so conhost never echoes
    if (key.name === "q" || (key.name === "c" && key.ctrl)) {
      destroyRenderer();
      process.exit(0);
    }
    if (key.ctrl) return;
    // Rust sees uppercase as a different code: shifted letters are ignored.
    if (key.shift && key.name.length === 1) return;
    switch (key.name) {
      case "r":
        manualRefresh();
        break;
      case "c":
        openUrl(CONSOLE_URL);
        break;
      case "g":
        openUrl(RELEASES_URL);
        break;
      // s/k (settings, skills views) and arrows are wired in M3.
    }
  });
  renderer.onResize(draw);

  const themeTimer = setInterval(() => {
    // SPEC 20: theme=system polls the registry every 30 s.
    if (state.settings.theme !== "system") return;
    const next = effectiveTheme(state.settings.theme, refreshSystemThemeCache());
    if (next !== state.effectiveTheme) state.effectiveTheme = next;
  }, THEME_POLL_MS);
  themeTimer.unref();

  const heartbeat = setInterval(draw, DRAW_HEARTBEAT_MS);
  heartbeat.unref();

  draw();
  await new Promise<never>(() => {}); // the loop lives in timers and handlers
}

/** Open a URL in the default browser; errors silently swallowed (SPEC 12.6/12.7). */
export function openUrl(url: string): void {
  try {
    Bun.spawn(["cmd", "/c", "start", "", url], { stdout: "ignore", stderr: "ignore", windowsHide: true });
  } catch {
    // as the Rust edition does: never surface a browser failure in the TUI
  }
}
