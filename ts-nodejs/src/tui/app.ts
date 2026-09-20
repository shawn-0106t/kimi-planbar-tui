// TUI bootstrap + event loop — the Node counterpart of rust/src/app.rs:
// dashboard / settings / skills view routing, quota polling, background
// update check, 30 s system-theme poll, 250 ms draw heartbeat.
//
// Loop shape mirrors the tokio::select! (SPEC 20): every event (keypress,
// quota publish, update result, skills scan, theme tick, resize) redraws
// immediately; the heartbeat only wakes the idle loop so countdown text stays
// fresh — countdowns are recomputed per redraw, there is no 1 Hz timer.
//
// Terminal discipline (SPEC 20, highest priority): terminal.ts owns raw mode
// + the alternate screen; EVERY exit path (q, ctrl+c, uncaughtException,
// unhandledRejection, process exit) goes through terminal.destroy() so the
// terminal is never stranded.

import { spawn } from "node:child_process";
import { createPolling, type Polling } from "../core/polling.ts";
import { fetchQuota, type QuotaResult } from "../core/quota.ts";
import {
  applyAutoStart,
  loadSettings,
  saveSettings,
  type SettingsData,
} from "../core/settings.ts";
import { scanSkills, type SkillInfo } from "../core/skills.ts";
import { createAppState, type AppState } from "../core/state.ts";
import { effectiveTheme, palette, refreshSystemThemeCache, systemThemeSync } from "../core/theme.ts";
import { checkUpdate, type UpdateStatus } from "../core/update.ts";
import { blankLine, padLineToWidth, type TuiLine } from "./line.ts";
import { footerLine, renderDashboardRows } from "./dashboard.ts";
import {
  cycle,
  INTERVAL_OPTIONS,
  renderSettingsRows,
  SETTINGS_FIELD_COUNT,
  settingsFooterLine,
  THEME_OPTIONS,
} from "./settingsView.ts";
import {
  buildSkillsRows,
  firstItemRow,
  moveSkillsSel,
  renderSkillsRows,
  skillsFooterLine,
  type SkillsRow,
} from "./skillsView.ts";
import { Screen } from "./screen.ts";
import { createTerminal, type KeyPress, type Terminal } from "./terminal.ts";

/** SPEC 12.7: Console button URL. */
export const CONSOLE_URL = "https://www.kimi.com/code/console?from=kfc_overview_topbar";
/** SPEC 12.6: version row click target. */
export const RELEASES_URL = "https://github.com/MoonshotAI/kimi-code/releases";

/** SPEC 12.7: manual refresh debounce, ms. */
const MANUAL_REFRESH_DEBOUNCE_MS = 2_000;
const THEME_POLL_MS = 30_000;
const DRAW_HEARTBEAT_MS = 250;

/** SPEC 20 wireframe minimum (72x13), used by the fresh-window shrink below. */
const MIN_WIN_COLS = 72;
const MIN_WIN_ROWS = 13;

/** SPEC 20 (Node-edition difference, registered in SPEC §22.6): without a
 *  native binding there is no GetConsoleProcessList, so "did we launch into
 *  our own fresh window?" is answered environmentally — every terminal that
 *  hosts an existing session sets one of these variables; a double-clicked /
 *  fresh console window has none of them. Never resize a shared console.
 *  env/out are injectable so the heuristic is unit-testable. */
export function shrinkFreshWindow(
  env: NodeJS.ProcessEnv = process.env,
  out: { isTTY?: boolean; write(text: string): unknown } = process.stdout,
): void {
  try {
    if (!out.isTTY) return;
    if (
      env["WT_SESSION"] !== undefined ||
      env["TERM_PROGRAM"] !== undefined ||
      env["ConEmuPID"] !== undefined
    ) {
      return;
    }
    out.write(`\x1b[8;${MIN_WIN_ROWS};${MIN_WIN_COLS}t`);
  } catch {
    // a terminal that rejects CSI 8;h;w keeps its size — that is fine
  }
}

type View = "dashboard" | "settings" | "skills";

/** SPEC 20 startup order: window shrink -> load settings -> apply theme ->
 *  init terminal -> event loop -> 2 s first refresh -> update check. */
export async function runTui(): Promise<void> {
  shrinkFreshWindow();
  const settings = loadSettings();
  const eff = effectiveTheme(settings.theme, () => systemThemeSync());
  const state: AppState = createAppState(settings, eff);

  // Late-binding holders so destroyAll() is safe to call before the terminal
  // and the timers exist (a createTerminal throw must not strand the console).
  let terminalRef: Terminal | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let themeTimer: ReturnType<typeof setInterval> | null = null;
  let pollingRef: Polling | null = null;

  let destroyed = false;
  const destroyAll = (): void => {
    if (destroyed) return;
    destroyed = true;
    if (heartbeat !== null) clearInterval(heartbeat);
    if (themeTimer !== null) clearInterval(themeTimer);
    pollingRef?.stop();
    terminalRef?.destroy();
  };
  // A stranded terminal is the worst TUI bug (SPEC 20): the process-level
  // handlers are registered BEFORE createTerminal() — exactly like the Rust
  // panic hook preceding terminal init — so every exit path restores.
  process.on("uncaughtException", (err) => {
    destroyAll();
    console.error(err);
    process.exit(1);
  });
  process.on("unhandledRejection", (err) => {
    destroyAll();
    console.error(err);
    process.exit(1);
  });
  process.on("exit", () => terminalRef?.destroy());

  const terminal: Terminal = createTerminal();
  terminalRef = terminal;
  const screen = new Screen(terminal.width, terminal.height, (text) => {
    process.stdout.write(text);
  });

  const app = {
    view: "dashboard" as View,
    quota: null as QuotaResult | null,
    update: null as UpdateStatus | null,
    settingsDraft: null as SettingsData | null,
    settingsSel: 0,
    skillsRows: [] as SkillsRow[],
    skillsSel: 0,
    skillsLoading: false,
  };

  const draw = (): void => {
    if (destroyed) return;
    const p = palette(state.effectiveTheme);
    const width = terminal.width;
    const height = terminal.height;

    let content: TuiLine[];
    let footer: TuiLine;
    if (app.view === "settings" && app.settingsDraft !== null) {
      content = renderSettingsRows({ draft: app.settingsDraft, sel: app.settingsSel, width, palette: p });
      footer = settingsFooterLine(p, width);
    } else if (app.view === "skills") {
      content = renderSkillsRows({
        rows: app.skillsRows,
        sel: app.skillsSel,
        loading: app.skillsLoading,
        width,
        height,
        palette: p,
      });
      footer = skillsFooterLine(p, width);
    } else {
      content = renderDashboardRows({
        quota: app.quota,
        update: app.update,
        nowMs: Date.now(),
        width,
        palette: p,
      }).rows;
      footer = footerLine(p, width);
    }

    // Min(0) spacer equivalent: blank bg-filled rows between content and the
    // bottom-pinned footer; on too-short terminals the content clips from the
    // bottom and the footer stays visible.
    const body = content.length + 1 <= height ? content : content.slice(0, Math.max(0, height - 1));
    const fillers = Array.from({ length: Math.max(0, height - body.length - 1) }, () =>
      padLineToWidth(blankLine(width, p.windowBg), width, p.windowBg),
    );
    const frame: TuiLine[] = height > 0 ? [...body, ...fillers, footer] : [];
    screen.writeFrame(frame, p.windowBg);
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
  pollingRef = polling;
  polling.start(); // first refresh 2 s after start (SPEC 16.5)

  const spawnUpdateCheck = (): void => {
    void checkUpdate().then((status) => {
      app.update = status;
      state.update = status;
      draw();
    });
  };
  spawnUpdateCheck(); // SPEC 17.3: one background check at startup

  /** Manual refresh (SPEC 12.7): quota + version re-check, 2 s debounce on a
   *  monotonic clock (performance.now mirrors Rust's Instant). */
  const manualRefresh = (): void => {
    const last = state.lastManualRefreshMs;
    if (last !== null && performance.now() - last < MANUAL_REFRESH_DEBOUNCE_MS) return;
    state.lastManualRefreshMs = performance.now();
    void polling.safeRefresh();
    spawnUpdateCheck();
  };

  /** rust set_skills: replace the rows, reset the highlight to the first item. */
  const setSkills = (list: SkillInfo[]): void => {
    app.skillsLoading = false;
    app.skillsRows = buildSkillsRows(list);
    app.skillsSel = firstItemRow(app.skillsRows);
  };

  /** SPEC 21.2: scan once on first open and cache in AppState; an explicit
   *  rescan key bypasses and overwrites the cache. The scan is synchronous
   *  local IO, deferred one tick so the "Scanning..." frame can paint. */
  const requestSkills = (refresh: boolean): void => {
    if (!refresh && state.skillsCache !== null) {
      setSkills(state.skillsCache);
      return;
    }
    if (app.skillsLoading) return;
    app.skillsLoading = true;
    draw();
    setImmediate(() => {
      try {
        const list = scanSkills();
        state.skillsCache = list;
        setSkills(list);
      } catch {
        app.skillsLoading = false; // IO failures surface as an empty list
      }
      draw();
    });
  };

  /** Settings save action order (SPEC 13.2): write settings.json ->
   *  applyAutoStart -> apply theme -> reschedule the polling timer -> back. */
  const saveDraft = (): void => {
    const draft = app.settingsDraft;
    if (draft === null) return;
    saveSettings(draft);
    applyAutoStart(draft);
    state.settings = draft;
    state.effectiveTheme = effectiveTheme(draft.theme, () => systemThemeSync());
    polling.reschedule();
    app.settingsDraft = null;
    app.view = "dashboard";
  };

  const handleDashboardKey = (name: string): void => {
    switch (name) {
      case "r":
        manualRefresh();
        break;
      case "s":
        // SPEC 13.2: the form opens with the current settings backfilled.
        app.settingsDraft = { ...state.settings };
        app.settingsSel = 0;
        app.view = "settings";
        break;
      case "k":
        app.view = "skills";
        requestSkills(false);
        break;
      case "c":
        openUrl(CONSOLE_URL);
        break;
      case "g":
        openUrl(RELEASES_URL);
        break;
    }
  };

  const handleSettingsKey = (key: KeyPress): void => {
    const draft = app.settingsDraft;
    if (draft === null) {
      app.view = "dashboard";
      return;
    }
    switch (key.name) {
      case "escape":
        app.settingsDraft = null; // discarded, not saved
        app.view = "dashboard";
        break;
      case "up":
        app.settingsSel = Math.max(0, app.settingsSel - 1);
        break;
      case "down":
        app.settingsSel = Math.min(SETTINGS_FIELD_COUNT - 1, app.settingsSel + 1);
        break;
      case "left":
      case "right": {
        const dir = key.name === "left" ? -1 : 1;
        if (app.settingsSel === 0)
          draft.theme = cycle(THEME_OPTIONS.map((o) => o[0]), draft.theme, dir);
        else if (app.settingsSel === 1)
          draft.refreshMinutes = cycle(INTERVAL_OPTIONS.map((o) => o[0]), draft.refreshMinutes, dir);
        else if (app.settingsSel === 2) draft.autoStart = !draft.autoStart;
        break;
      }
      case "return":
      case "space":
        if (app.settingsSel === 0)
          draft.theme = cycle(THEME_OPTIONS.map((o) => o[0]), draft.theme, 1);
        else if (app.settingsSel === 1)
          draft.refreshMinutes = cycle(INTERVAL_OPTIONS.map((o) => o[0]), draft.refreshMinutes, 1);
        else if (app.settingsSel === 2) draft.autoStart = !draft.autoStart;
        else saveDraft();
        break;
    }
  };

  const handleSkillsKey = (key: KeyPress): void => {
    switch (key.name) {
      case "escape":
        app.view = "dashboard";
        break;
      case "up":
        app.skillsSel = moveSkillsSel(app.skillsRows, app.skillsSel, -1);
        break;
      case "down":
        app.skillsSel = moveSkillsSel(app.skillsRows, app.skillsSel, 1);
        break;
      case "r":
        requestSkills(true);
        break;
    }
  };

  terminal.onKey((key: KeyPress) => {
    // Ctrl+C quits from every view, before any other guard (SPEC 12.7).
    if (key.name === "c" && key.ctrl) {
      destroyAll();
      process.exit(0);
    }
    // Rust sees uppercase as a different code: shifted letters are ignored,
    // and this guard precedes the quit check so Shift+Q does NOT exit.
    if (key.shift && key.name.length === 1) return;
    if (key.name === "q") {
      destroyAll();
      process.exit(0);
    }
    if (key.ctrl) return;
    if (app.view === "settings") handleSettingsKey(key);
    else if (app.view === "skills") handleSkillsKey(key);
    else handleDashboardKey(key.name);
    draw(); // event-driven redraw: every key paints immediately (SPEC 20)
  });
  terminal.onResize(() => {
    screen.setSize(terminal.width, terminal.height);
    draw();
  });

  themeTimer = setInterval(() => {
    // SPEC 20: theme=system polls the registry every 30 s; a change redraws
    // immediately, like every other event.
    if (state.settings.theme !== "system") return;
    const next = effectiveTheme(state.settings.theme, () => refreshSystemThemeCache());
    if (next === state.effectiveTheme) return;
    state.effectiveTheme = next;
    draw();
  }, THEME_POLL_MS);
  themeTimer.unref();

  // NOT unref'd: a pending promise alone does not keep Node's event loop
  // alive, and a piped (non-TTY) stdin holds no handle either — this timer is
  // the loop's anchor and destroyAll() clears it on the way out.
  heartbeat = setInterval(draw, DRAW_HEARTBEAT_MS);

  draw();
  await new Promise<never>(() => {}); // the loop lives in timers and handlers
}

/** Open a URL in the default browser; errors silently swallowed (SPEC 12.6/12.7). */
export function openUrl(url: string): void {
  try {
    const child = spawn("cmd", ["/c", "start", "", url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // as the Rust edition does: never surface a browser failure in the TUI
  }
}
