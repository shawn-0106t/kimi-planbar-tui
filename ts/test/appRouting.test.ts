// Key router state machine — ts/test counterpart of the #[cfg(test)] module in
// rust/src/app.rs. handleKey() is pure over UiApp with side effects behind
// RouterDeps, so the Rust tests replay 1:1 and the SPEC 12.7 table is pinned
// without a renderer.

import { describe, expect, test } from "bun:test";
import type { SettingsData } from "../src/core/settings.ts";
import type { SkillInfo } from "../src/core/skills.ts";
import { createUiApp, handleKey, setSkills, type RouterDeps, type UiApp } from "../src/tui/app.ts";
import type { KeyPress } from "../src/tui/renderer.ts";

const key = (name: string, over: Partial<KeyPress> = {}): KeyPress => ({ name, ctrl: false, shift: false, ...over });

const committed = (over: Partial<SettingsData> = {}): SettingsData => ({
  theme: "system",
  refreshMinutes: 5,
  autoStart: false,
  ...over,
});

interface Recorded extends RouterDeps {
  calls: string[];
  saved: SettingsData[];
  rescan: boolean[];
}

function deps(settings: SettingsData = committed()): Recorded {
  const calls: string[] = [];
  const saved: SettingsData[] = [];
  const rescan: boolean[] = [];
  return {
    calls,
    saved,
    rescan,
    currentSettings: () => settings,
    manualRefresh: () => void calls.push("refresh"),
    openConsole: () => void calls.push("console"),
    openReleases: () => void calls.push("releases"),
    requestSkills: (refresh) => void (calls.push("skills"), rescan.push(refresh)),
    saveSettings: (draft) => void (calls.push("save"), saved.push({ ...draft })),
  };
}

const app = (): UiApp => createUiApp();

const skills: SkillInfo[] = [
  { id: "a", name: "a", description: "", source: "Agents" },
  { id: "b", name: "b", description: "", source: "Kimi Code" },
];

describe("global keys (SPEC 12.7)", () => {
  test("q quits and Ctrl+C quits, from every view", () => {
    for (const open of ["s", "k"] as const) {
      const a = app();
      const d = deps();
      handleKey(a, key(open), d);
      handleKey(a, key("q"), d);
      expect(a.quit).toBe(true);

      const b = app();
      handleKey(b, key("q"), deps());
      expect(b.quit).toBe(true);

      const c = app();
      handleKey(c, key("c", { ctrl: true }), deps());
      expect(c.quit).toBe(true);
    }
  });

  test("a shifted letter is a different Rust KeyCode and is ignored", () => {
    const a = app();
    const d = deps();
    handleKey(a, key("r", { shift: true }), d); // R: no refresh
    handleKey(a, key("s", { shift: true }), d); // S: no settings
    handleKey(a, key("c", { shift: true }), d); // C: no console
    expect([a.view, a.quit, d.calls]).toEqual(["dashboard", false, []]);
  });

  test("Ctrl with any other key is ignored, and so are unmapped keys", () => {
    const a = app();
    const d = deps();
    handleKey(a, key("g", { ctrl: true }), d);
    handleKey(a, key("x"), d);
    handleKey(a, key("f1"), d);
    expect([a.view, d.calls]).toEqual(["dashboard", []]);
  });
});

describe("dashboard keys (SPEC 12.7)", () => {
  test("r refreshes, c and g open their URLs", () => {
    const a = app();
    const d = deps();
    for (const k of ["r", "c", "g"]) handleKey(a, key(k), d);
    expect(d.calls).toEqual(["refresh", "console", "releases"]);
    expect(a.view).toBe("dashboard");
  });

  test("s seeds the draft from the committed settings and selects row 0", () => {
    const a = app();
    const d = deps(committed({ theme: "dark", refreshMinutes: 30, autoStart: true }));
    handleKey(a, key("down"), d); // ignored outside the form
    handleKey(a, key("s"), d);
    expect(a.view).toBe("settings");
    expect(a.settingsDraft).toEqual(committed({ theme: "dark", refreshMinutes: 30, autoStart: true }));
    expect(a.settingsSel).toBe(0);
    // the draft is a copy: editing it must not touch the committed object
    handleKey(a, key("right"), d);
    expect(a.settingsDraft!.theme).toBe("system"); // dark -> right wraps to system
    expect(d.currentSettings().theme).toBe("dark");
  });

  test("k enters skills and asks for the cached scan, not a rescan", () => {
    const a = app();
    const d = deps();
    handleKey(a, key("k"), d);
    expect([a.view, d.rescan]).toEqual(["skills", [false]]);
  });
});

describe("settings keys (SPEC 13.1)", () => {
  const open = (): [UiApp, Recorded] => {
    const a = app();
    const d = deps();
    handleKey(a, key("s"), d);
    return [a, d];
  };

  test("up/down clamp to the four rows", () => {
    const [a, d] = open();
    for (let i = 0; i < 10; i++) handleKey(a, key("down"), d);
    expect(a.settingsSel).toBe(3);
    for (let i = 0; i < 10; i++) handleKey(a, key("up"), d);
    expect(a.settingsSel).toBe(0);
  });

  test("right cycles theme and left wraps it", () => {
    const [a, d] = open();
    handleKey(a, key("right"), d);
    expect(a.settingsDraft!.theme).toBe("light");
    handleKey(a, key("left"), d);
    handleKey(a, key("left"), d);
    expect(a.settingsDraft!.theme).toBe("dark");
  });

  test("an unknown committed theme still cycles from the first option", () => {
    const a = app();
    const d = deps(committed({ theme: "neon" }));
    handleKey(a, key("s"), d);
    handleKey(a, key("right"), d);
    expect(a.settingsDraft!.theme).toBe("light");
    handleKey(a, key("left"), d);
    handleKey(a, key("left"), d);
    expect(a.settingsDraft!.theme).toBe("dark");
  });

  test("the interval row moves 5 -> 10 -> 30 -> 1 -> 5", () => {
    const [a, d] = open();
    handleKey(a, key("down"), d);
    expect(a.settingsSel).toBe(1);
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      handleKey(a, key("right"), d);
      seen.push(a.settingsDraft!.refreshMinutes);
    }
    expect(seen).toEqual([10, 30, 1, 5]);
  });

  test("left and right both toggle autostart, and Enter/Space do too", () => {
    const [a, d] = open();
    handleKey(a, key("down"), d);
    handleKey(a, key("down"), d);
    handleKey(a, key("left"), d);
    expect(a.settingsDraft!.autoStart).toBe(true);
    handleKey(a, key("right"), d);
    expect(a.settingsDraft!.autoStart).toBe(false);
    handleKey(a, key("space"), d);
    expect(a.settingsDraft!.autoStart).toBe(true);
    handleKey(a, key("return"), d);
    expect(a.settingsDraft!.autoStart).toBe(false);
  });

  test("Enter on Save commits and returns to the dashboard", () => {
    const [a, d] = open();
    handleKey(a, key("right"), d); // theme -> light
    for (let i = 0; i < 3; i++) handleKey(a, key("down"), d);
    expect(a.settingsSel).toBe(3);
    handleKey(a, key("return"), d);
    expect(d.saved).toEqual([committed({ theme: "light" })]);
    expect([a.view, a.settingsDraft]).toEqual(["dashboard", null]);
  });

  test("Esc discards the draft", () => {
    const [a, d] = open();
    handleKey(a, key("right"), d);
    handleKey(a, key("escape"), d);
    expect([a.view, a.settingsDraft, d.saved]).toEqual(["dashboard", null, []]);
  });

  test("a lost draft falls back to the dashboard instead of throwing", () => {
    const a = app();
    a.view = "settings";
    a.settingsDraft = null;
    handleKey(a, key("down"), deps());
    expect(a.view).toBe("dashboard");
  });

  test("the form swallows dashboard keys", () => {
    const [a, d] = open();
    handleKey(a, key("r"), d);
    handleKey(a, key("k"), d);
    handleKey(a, key("g"), d);
    expect(a.view).toBe("settings");
    expect(d.calls).toEqual([]);
  });
});

describe("skills keys (SPEC 21.1/21.3)", () => {
  const open = (): [UiApp, Recorded] => {
    const a = app();
    const d = deps();
    handleKey(a, key("k"), d);
    setSkills(a, skills);
    return [a, d];
  };

  test("selection starts on the first item and skips the group header", () => {
    const [a, d] = open();
    // rows: [group Agents, item a, group Kimi Code, item b]
    expect(a.skillsRows.map((r) => r.kind)).toEqual(["group", "item", "group", "item"]);
    expect(a.skillsSel).toBe(1);
    handleKey(a, key("down"), d);
    expect(a.skillsSel).toBe(3);
    handleKey(a, key("down"), d);
    expect(a.skillsSel).toBe(1);
    handleKey(a, key("up"), d);
    expect(a.skillsSel).toBe(3);
  });

  test("r forces a rescan and Esc returns", () => {
    const [a, d] = open();
    handleKey(a, key("r"), d);
    expect(d.rescan).toEqual([false, true]);
    handleKey(a, key("escape"), d);
    expect(a.view).toBe("dashboard");
  });

  test("an empty list keeps the highlight at 0 and never throws", () => {
    const [a, d] = open();
    setSkills(a, []);
    expect([a.skillsSel, a.skillsRows.length]).toEqual([0, 0]);
    handleKey(a, key("down"), d);
    handleKey(a, key("up"), d);
    expect(a.skillsSel).toBe(0);
  });
});

describe("view transition bookkeeping", () => {
  test("setSkills clears the loading flag and re-seeds the selection", () => {
    const a = app();
    a.skillsLoading = true;
    a.skillsSel = 9;
    setSkills(a, skills);
    expect([a.skillsLoading, a.skillsSel]).toEqual([false, 1]);
  });
});
