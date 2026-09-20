// Frame assembly across the three views (SPEC 12/13/21 + the Min(0) spacer of
// SPEC 20): renderFrame() is what the adapter receives on every redraw, so the
// view switch, the footer swap and the short-terminal clip are pinned here.

import { describe, expect, test } from "bun:test";
import { dtFromParts } from "../src/core/json.ts";
import type { QuotaResult } from "../src/core/quota.ts";
import { MOONDARK, MOONLIT } from "../src/core/theme.ts";
import { FOOTER, footerLine } from "../src/tui/dashboard.ts";
import { lineText, lineWidth } from "../src/tui/line.ts";
import { composeFrame, createUiApp, renderFrame, setSkills, type UiApp } from "../src/tui/app.ts";
import { SETTINGS_FOOTER } from "../src/tui/settingsView.ts";
import { SKILLS_FOOTER } from "../src/tui/skillsView.ts";

const NOW = Date.UTC(2026, 8, 19, 6, 35, 0);
const dt = (ms: number) => dtFromParts(ms, 0);

const quota: QuotaResult = {
  fiveHour: { percent: 21, resetAt: dt(NOW + 4 * 3_600_000) },
  week: null,
  extra: null,
  fetchedAt: dt(NOW - 60_000),
  error: null,
};

const text = (app: UiApp, width: number, height: number) =>
  renderFrame(app, MOONLIT, width, height, NOW).map((l) => lineText(l).replace(/\s+$/, ""));

describe("frame per view (SPEC 12.7 view set)", () => {
  test("the dashboard frame keeps the quota rows and the dashboard footer", () => {
    const app = createUiApp(quota);
    const g = text(app, 72, 14);
    expect(g.length).toBe(14);
    expect(g[0]).toContain("Kimi Planbar TUI");
    expect(g[0]!.trimEnd().endsWith("Updated 14:34")).toBe(true);
    expect(g[2]!.trim()).toContain("Resets in 4h 0m");
    expect(g[13]).toBe(FOOTER);
  });

  test("the settings frame swaps in the form and its own footer", () => {
    const app = createUiApp(quota);
    app.view = "settings";
    app.settingsDraft = { theme: "dark", refreshMinutes: 10, autoStart: true };
    const g = text(app, 72, 14);
    expect(g[1]).toBe("  Kimi Planbar TUI Settings");
    expect(g[4]).toBe("Theme");
    expect(g[8]).toBe("(●) Moondark (dark)");
    expect(g[13]).toBe(SETTINGS_FOOTER);
  });

  test("the skills frame shows the grouped list and its footer", () => {
    const app = createUiApp(quota);
    app.view = "skills";
    setSkills(app, [{ id: "x", name: "x", description: "十、九、八", source: "Kimi Code" }]);
    const g = text(app, 72, 14);
    expect(g[1]).toBe("  Kimi Skills   1 skills");
    expect(g[4]).toBe("Kimi Code");
    expect(g[5]).toBe("  x");
    expect(g[6]).toBe("    十、九、八");
    expect(g[13]).toBe(SKILLS_FOOTER);
  });

  test("every frame is exactly height rows of exactly width cells", () => {
    for (const view of ["dashboard", "settings", "skills"] as const) {
      for (const [w, h] of [[72, 13], [120, 30], [40, 8]] as const) {
        const app = createUiApp(quota);
        app.view = view;
        app.settingsDraft = view === "settings" ? { theme: "system", refreshMinutes: 5, autoStart: false } : null;
        const rows = renderFrame(app, MOONDARK, w, h);
        expect(rows.length).toBe(h);
        for (const l of rows) expect(lineWidth(l)).toBe(w);
      }
    }
  });
});

describe("short terminals (SPEC 20 layout)", () => {
  test("content clips from the bottom while the footer stays on the last row", () => {
    const app = createUiApp(quota);
    app.view = "settings";
    app.settingsDraft = { theme: "system", refreshMinutes: 5, autoStart: false };
    const rows = renderFrame(app, MOONLIT, 60, 6);
    expect(lineText(rows[5]!)).toBe(SETTINGS_FOOTER.padEnd(60));
    expect(rows.map(lineText).join("\n")).toContain("Kimi Planbar TUI Settings");
  });

  test("a one-row terminal still renders the footer, clipped to the width", () => {
    const app = createUiApp(null);
    expect(renderFrame(app, MOONLIT, 20, 1).map(lineText)).toEqual([FOOTER.slice(0, 20).padEnd(20)]);
  });

  test("zero height renders no rows at all (the adapter is never handed NaN)", () => {
    expect(renderFrame(createUiApp(null), MOONLIT, 20, 0)).toEqual([]);
  });

  test("composeFrame pads the gap with window_bg filler rows", () => {
    const frame = composeFrame([], footerLine(MOONLIT, 10), 10, 4, MOONLIT.windowBg);
    expect(frame.length).toBe(4);
    for (const filler of frame.slice(0, 3)) {
      expect(lineText(filler)).toBe(" ".repeat(10));
      expect(filler.spans.every((s) => s.bg === MOONLIT.windowBg)).toBe(true);
    }
    expect(lineText(frame[3]!)).toBe(FOOTER.slice(0, 10));
  });
});
