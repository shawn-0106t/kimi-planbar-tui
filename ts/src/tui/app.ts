// TUI bootstrap + event loop — the TS counterpart of rust/src/app.rs: the
// three-view state machine (SPEC 12/13/21), the full SPEC 12.7 key router and
// the SPEC 20 terminal discipline.
//
// Loop shape mirrors the tokio::select! (SPEC 3.2 / 20): every event
// (keypress, quota publish, update result, theme tick, resize) redraws
// immediately; a 250 ms heartbeat only wakes the idle loop so countdown text
// stays fresh — countdowns are recomputed per redraw, there is no 1 Hz timer.
//
// handleKey() is exported as a pure state transition over UiApp with its side
// effects behind RouterDeps, mirroring how the Rust handle_key takes &mut App
// plus the mpsc senders — that is what lets ts/test/appRouting.test.ts replay
// the Rust app.rs unit tests 1:1.
//
// Terminal discipline (SPEC 20): the renderer owns raw mode + alternate
// screen; EVERY exit path (q, ctrl+c, uncaughtException, unhandledRejection)
// goes through destroyRenderer() so the terminal is never stranded.

import { createPolling, type Polling } from "../core/polling.ts";
import { fetchQuota, type QuotaResult } from "../core/quota.ts";
import {
  applyAutoStart,
  loadSettings,
  saveSettings as writeSettings,
  type SettingsData,
} from "../core/settings.ts";
import { scanSkills, type SkillInfo } from "../core/skills.ts";
import { createAppState, type AppState } from "../core/state.ts";
import {
  effectiveTheme,
  palette,
  refreshSystemThemeCache,
  systemThemeSync,
  type Palette,
} from "../core/theme.ts";
import { checkUpdate, type UpdateStatus } from "../core/update.ts";
import { blankLine, padLineToWidth, type TuiLine } from "./line.ts";
import { footerLine, renderDashboardRows } from "./dashboard.ts";
import { renderSettingsRows, settingsFooterLine } from "./settingsView.ts";
import {
  buildSkillRows,
  firstItemIndex,
  moveSkillSel,
  renderSkillsRows,
  skillsFooterLine,
  type SkillRow,
} from "./skillsView.ts";
import { createTuiRenderer, type KeyPress, type TuiRenderer } from "./renderer.ts";
import { enterRawMode, ensureRawMode } from "./console.ts";
import { shrinkOwnedConsoleIfOwned } from "./shrink.ts";

/** SPEC 12.7: Console button URL. */
export const CONSOLE_URL = "https://www.kimi.com/code/console?from=kfc_overview_topbar";
/** SPEC 12.6: version row click target. */
export const RELEASES_URL = "https://github.com/MoonshotAI/kimi-code/releases";

/** SPEC 12.7: manual refresh debounce, ms. */
const MANUAL_REFRESH_DEBOUNCE_MS = 2_000;
const THEME_POLL_MS = 30_000;
const DRAW_HEARTBEAT_MS = 250;

/** rust/src/app.rs::View */
export type View = "dashboard" | "settings" | "skills";

/** rust/src/app.rs::App (the quota/update fields it carries live here too, so
 *  the views take one object). */
export interface UiApp {
  view: View;
  quota: QuotaResult | null;
  update: UpdateStatus | null;
  /** Draft copy edited in the settings form; committed on Save. */
  settingsDraft: SettingsData | null;
  /** Selected settings row: 0 Theme, 1 Interval, 2 AutoStart, 3 Save. */
  settingsSel: number;
  skillsRows: SkillRow[];
  skillsSel: number;
  skillsLoading: boolean;
  quit: boolean;
}

export function createUiApp(quota: QuotaResult | null = null): UiApp {
  return {
    view: "dashboard",
    quota,
    update: null,
    settingsDraft: null,
    settingsSel: 0,
    skillsRows: [],
    skillsSel: 0,
    skillsLoading: false,
    quit: false,
  };
}

/** Side effects the router delegates: the Rust equivalents are the mpsc
 *  senders and the settings/skills module calls. */
export interface RouterDeps {
  /** Committed settings, used to seed the draft when the form opens. */
  currentSettings(): SettingsData;
  manualRefresh(): void;
  openConsole(): void;
  openReleases(): void;
  requestSkills(refresh: boolean): void;
  /** SPEC 13.2 save order: JSON -> autostart -> theme -> reschedule. */
  saveSettings(draft: SettingsData): void;
}

const THEMES: readonly string[] = ["system", "light", "dark"];
const INTERVALS: readonly number[] = [1, 5, 10, 30];

/** rust/src/app.rs::cycle — `rem_euclid` wrap, unknown current value starts at 0. */
function cycle<T extends string | number>(options: readonly T[], current: T, dir: number): T {
  const len = options.length;
  const at = options.indexOf(current);
  const idx = at < 0 ? 0 : at;
  return options[(((idx + dir) % len) + len) % len]!;
}

/** rust/src/app.rs::set_skills */
export function setSkills(app: UiApp, skills: SkillInfo[]): void {
  app.skillsLoading = false;
  app.skillsRows = buildSkillRows(skills);
  app.skillsSel = firstItemIndex(app.skillsRows) ?? 0;
}

/** SPEC 12.7 key table, dispatched per view (rust/src/app.rs::handle_key). */
export function handleKey(app: UiApp, key: KeyPress, deps: RouterDeps): void {
  // Global quit (any view): q, and Ctrl+C. Ctrl+<other> is ignored, and a
  // shifted letter is a different Rust KeyCode — Char('R') never matches the
  // Char('r') arms, so the router ignores it the same way.
  if (key.name === "q" || (key.name === "c" && key.ctrl)) {
    app.quit = true;
    return;
  }
  if (key.ctrl) return;
  if (key.shift && key.name.length === 1) return;

  switch (app.view) {
    case "dashboard":
      switch (key.name) {
        case "r":
          deps.manualRefresh();
          break;
        case "s":
          app.settingsDraft = { ...deps.currentSettings() };
          app.settingsSel = 0;
          app.view = "settings";
          break;
        case "k":
          app.view = "skills";
          deps.requestSkills(false);
          break;
        case "c":
          deps.openConsole();
          break;
        case "g":
          deps.openReleases();
          break;
      }
      return;

    case "settings": {
      const draft = app.settingsDraft;
      if (draft === null) {
        app.view = "dashboard";
        return;
      }
      switch (key.name) {
        case "escape":
          app.settingsDraft = null;
          app.view = "dashboard";
          return;
        case "up":
          app.settingsSel = Math.max(0, app.settingsSel - 1);
          return;
        case "down":
          app.settingsSel = Math.min(3, app.settingsSel + 1);
          return;
        case "left":
        case "right": {
          const dir = key.name === "left" ? -1 : 1;
          if (app.settingsSel === 0) {
            draft.theme = cycle(THEMES, draft.theme, dir);
          } else if (app.settingsSel === 1) {
            draft.refreshMinutes = cycle(INTERVALS, draft.refreshMinutes, dir);
          } else if (app.settingsSel === 2) {
            draft.autoStart = !draft.autoStart;
          }
          return;
        }
        case "return":
        case "space":
          if (app.settingsSel === 0) {
            draft.theme = cycle(THEMES, draft.theme, 1);
          } else if (app.settingsSel === 1) {
            draft.refreshMinutes = cycle(INTERVALS, draft.refreshMinutes, 1);
          } else if (app.settingsSel === 2) {
            draft.autoStart = !draft.autoStart;
          } else {
            deps.saveSettings(draft);
            app.settingsDraft = null;
            app.view = "dashboard";
          }
          return;
      }
      return;
    }

    case "skills":
      switch (key.name) {
        case "escape":
          app.view = "dashboard";
          break;
        case "up":
          app.skillsSel = moveSkillSel(app.skillsRows, app.skillsSel, -1);
          break;
        case "down":
          app.skillsSel = moveSkillSel(app.skillsRows, app.skillsSel, 1);
          break;
        case "r":
          deps.requestSkills(true);
          break;
      }
      return;
  }
}

/** One frame: the active view's rows, the Min(0) spacer equivalent, and the
 *  bottom-pinned footer. On too-short terminals the content clips from the
 *  bottom while the footer stays visible. */
export function composeFrame(
  rows: TuiLine[],
  footer: TuiLine,
  width: number,
  height: number,
  windowBg: string,
): TuiLine[] {
  if (height <= 0) return [];
  const body = rows.length + 1 <= height ? rows : rows.slice(0, Math.max(0, height - 1));
  const fillers = Array.from({ length: Math.max(0, height - body.length - 1) }, () =>
    padLineToWidth(blankLine(width, windowBg), width, windowBg),
  );
  return [...body, ...fillers, footer];
}

/** The frame for the current view — exported so the view switch is testable.
 *  `nowMs` is a seam: the countdown is recomputed per redraw from the wall
 *  clock (SPEC 12.3), which the dashboard view takes as an input. */
export function renderFrame(
  app: UiApp,
  p: Palette,
  width: number,
  height: number,
  nowMs: number = Date.now(),
): TuiLine[] {
  switch (app.view) {
    case "settings":
      return composeFrame(
        renderSettingsRows({ draft: app.settingsDraft, sel: app.settingsSel, width, height, palette: p }),
        settingsFooterLine(p, width),
        width,
        height,
        p.windowBg,
      );
    case "skills":
      return composeFrame(
        renderSkillsRows({
          rows: app.skillsRows,
          sel: app.skillsSel,
          loading: app.skillsLoading,
          width,
          height,
          palette: p,
        }),
        skillsFooterLine(p, width),
        width,
        height,
        p.windowBg,
      );
    default:
      return composeFrame(
        renderDashboardRows({ quota: app.quota, update: app.update, nowMs, width, palette: p }).rows,
        footerLine(p, width),
        width,
        height,
        p.windowBg,
      );
  }
}

/** Exit-path wiring (SPEC 20). Kept as a second line of defence: Bun/Windows
 *  swallows the console control event, so Ctrl+C reaches neither this handler
 *  nor the key router (SPEC 22.6) — `q` is the quit key. The handlers still
 *  cover whatever does raise a signal here (Ctrl+Break, a future runtime fix),
 *  and the guard makes the path idempotent however many arrive.
 *  Exported for the unit test — `exit` is injectable so tests never exit. */
export function registerExitHandlers(
  destroy: () => void,
  exit: (code: number) => void = (code) => process.exit(code),
): () => void {
  let done = false;
  const teardown = (): void => {
    if (done) return;
    done = true;
    destroy();
    exit(0);
  };
  process.on("SIGINT", teardown);
  process.on("SIGBREAK", teardown);
  return () => {
    process.removeListener("SIGINT", teardown);
    process.removeListener("SIGBREAK", teardown);
  };
}

/** SPEC 20 startup order: shrink the owned window -> load settings -> apply
 *  theme -> init terminal -> event loop -> 2 s first refresh -> update check. */
export async function runTui(makeRenderer: () => Promise<TuiRenderer> = createTuiRenderer): Promise<void> {
  shrinkOwnedConsoleIfOwned();

  const settings = loadSettings();
  const eff = effectiveTheme(settings.theme, systemThemeSync());
  const state: AppState = createAppState(settings, eff);
  const app = createUiApp();

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
  registerExitHandlers(destroyRenderer);

  const draw = (): void => {
    if (destroyed) return;
    ensureRawMode(); // Bun flips the console back to cooked on each stdin read
    const p = palette(state.effectiveTheme);
    renderer.renderRows(renderFrame(app, p, renderer.width, renderer.height), p.windowBg);
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

  /** SPEC 21.2: scan once and cache; the rescan key forces a fresh scan. The
   *  scan runs on the next macrotask so the "Scanning..." frame is drawn
   *  first, standing in for the Rust spawn_blocking + mpsc round trip. */
  const requestSkills = (refresh: boolean): void => {
    if (!refresh && state.skillsCache !== null) {
      setSkills(app, state.skillsCache);
      draw();
      return;
    }
    if (app.skillsLoading) return;
    app.skillsLoading = true;
    draw();
    setTimeout(() => {
      const list = scanSkills();
      state.skillsCache = list;
      setSkills(app, list);
      draw();
    }, 0);
  };

  const deps: RouterDeps = {
    currentSettings: () => state.settings,
    manualRefresh,
    openConsole: () => openUrl(CONSOLE_URL),
    openReleases: () => openUrl(RELEASES_URL),
    requestSkills,
    saveSettings: (draft) => {
      // SPEC 13.2 order: write settings.json -> autostart -> theme -> timer.
      writeSettings(draft);
      applyAutoStart(draft);
      state.settings = draft;
      state.effectiveTheme = effectiveTheme(draft.theme, systemThemeSync());
      polling.reschedule();
    },
  };

  renderer.onKey((key: KeyPress) => {
    ensureRawMode(); // re-arm before the next keystroke so conhost never echoes
    handleKey(app, key, deps);
    if (app.quit) {
      destroyRenderer();
      process.exit(0);
    }
    draw(); // event-driven redraw, no coalescing (SPEC 20)
  });
  renderer.onResize(draw);

  const themeTimer = setInterval(() => {
    // SPEC 20: theme=system polls the registry every 30 s; a change redraws
    // immediately, like every other event.
    if (state.settings.theme !== "system") return;
    const next = effectiveTheme(state.settings.theme, refreshSystemThemeCache());
    if (next === state.effectiveTheme) return;
    state.effectiveTheme = next;
    draw();
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
