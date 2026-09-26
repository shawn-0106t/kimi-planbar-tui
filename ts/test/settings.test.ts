import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  autoStartCommand,
  configDir,
  defaultSettings,
  loadSettings,
  parseSettingsJson,
  reconcileNeedsApply,
  regQueryRunValueCommand,
  saveSettings,
  settingsToJsonText,
  writeSettingsAtomic,
  type SettingsData,
} from "../src/core/settings.ts";
import { goldenText, timezoneMatchesGolden } from "./goldens.ts";

const cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tempDir = (label: string): string => {
  const dir = join(process.env["TMP"] ?? ".", `kpt-${label}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  cleanup.push(dir);
  return dir;
};

describe("settings.json text (SPEC 18.2)", () => {
  test("the default document matches the Rust oracle byte for byte", () => {
    expect(settingsToJsonText(defaultSettings())).toBe(goldenText("settings-default"));
  });

  test("PascalCase keys, 2-space indent and no trailing newline", () => {
    const text = settingsToJsonText({ theme: "dark", refreshMinutes: 30, autoStart: true });
    expect(text).toBe('{\n  "Theme": "dark",\n  "RefreshMinutes": 30,\n  "AutoStart": true\n}');
    expect(text.endsWith("\n")).toBe(false);
  });

  test("it round-trips through the loader", () => {
    const data: SettingsData = { theme: "light", refreshMinutes: 10, autoStart: true };
    expect(parseSettingsJson(settingsToJsonText(data))).toEqual(data);
  });
});

describe("parseSettingsJson load rules (SPEC 18.2)", () => {
  test("a missing key takes its own default", () => {
    expect(parseSettingsJson('{"Theme":"dark"}')).toEqual({
      theme: "dark",
      refreshMinutes: 5,
      autoStart: false,
    });
  });

  test("a type mismatch discards the whole file", () => {
    const fallback = defaultSettings();
    for (const body of [
      '{"Theme":5,"RefreshMinutes":5,"AutoStart":false}',
      '{"Theme":"system","RefreshMinutes":"5","AutoStart":false}',
      '{"Theme":"system","RefreshMinutes":5.0,"AutoStart":false}',
      '{"Theme":"system","RefreshMinutes":5,"AutoStart":"true"}',
      '{"Theme":null}',
      '{"Theme":"system"} junk',
      'not json',
      "[]",
    ]) {
      expect(parseSettingsJson(body)).toEqual(fallback);
    }
  });

  test("beyond i64 is a type error; beyond 2^53 clamps to the exact range", () => {
    expect(parseSettingsJson('{"RefreshMinutes":9223372036854775808}')).toEqual(defaultSettings());
    expect(parseSettingsJson('{"RefreshMinutes":-9223372036854775809}')).toEqual(defaultSettings());
    // i64 max is still a valid i64, but Number() would round it, so the value
    // is clamped to the exactly-representable range instead (SPEC 22.3).
    expect(parseSettingsJson('{"RefreshMinutes":9223372036854775807}').refreshMinutes).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(parseSettingsJson('{"RefreshMinutes":-9223372036854775808}').refreshMinutes).toBe(
      -Number.MAX_SAFE_INTEGER,
    );
    expect(parseSettingsJson('{"RefreshMinutes":9007199254740991}').refreshMinutes).toBe(
      9007199254740991,
    );
  });

  test("unknown extra keys are ignored and duplicate keys keep the last", () => {
    expect(parseSettingsJson('{"Theme":"dark","Future":"x"}').theme).toBe("dark");
    expect(parseSettingsJson('{"Theme":"dark","Theme":"light"}').theme).toBe("light");
  });

  test("an empty document takes all defaults", () => {
    expect(parseSettingsJson("{}")).toEqual(defaultSettings());
  });
});

describe("config dir + read/write (SPEC 18.1)", () => {
  test("portable.dat next to the exe pins the config dir to the exe dir", () => {
    const dir = tempDir("portable");
    writeFileSync(join(dir, "portable.dat"), "");
    const exe = join(dir, "kpt-tui.exe");
    expect(configDir(exe, { APPDATA: "C:/roaming" })).toBe(dir);
    rmSync(join(dir, "portable.dat"));
    expect(configDir(exe, { APPDATA: "C:/roaming" })).toBe(join("C:/roaming", "KimiPlanbarTui"));
    expect(configDir(exe, { APPDATA: "" })).toBe(dir);
    expect(configDir(exe, {})).toBe(dir);
  });

  test("a missing file yields defaults, and saving reads back identically", () => {
    const dir = tempDir("roundtrip");
    expect(loadSettings(dir)).toEqual(defaultSettings());
    const data: SettingsData = { theme: "dark", refreshMinutes: 1, autoStart: false };
    saveSettings(data, dir);
    expect(loadSettings(dir)).toEqual(data);
    expect(readFileSync(join(dir, "settings.json"), "utf8")).toBe(settingsToJsonText(data));
  });

  test("saving over a corrupt file repairs it", () => {
    const dir = tempDir("corrupt");
    writeFileSync(join(dir, "settings.json"), "{oops", "utf8");
    expect(loadSettings(dir)).toEqual(defaultSettings());
    saveSettings({ theme: "system", refreshMinutes: 30, autoStart: false }, dir);
    expect(loadSettings(dir).refreshMinutes).toBe(30);
  });

  test("the file the Rust edition wrote on this machine is still parseable and byte-stable", () => {
    const dir = configDir(process.execPath, process.env);
    const path = join(dir, "settings.json");
    if (!existsSync(path)) return;
    const bytes = readFileSync(path, "utf8");
    const data = parseSettingsJson(bytes);
    // Rewriting what we loaded must produce the same bytes, or the two editions
    // would leave different files behind.
    expect(settingsToJsonText(data)).toBe(bytes);
  });
});

describe("atomic save (SPEC 18.2, REVIEW-RUST Minor 2 / Suggestion 13)", () => {
  test("saving renames a temp file over the target and leaves no temp behind", () => {
    const dir = tempDir("atomic");
    const data: SettingsData = { theme: "dark", refreshMinutes: 10, autoStart: true };
    expect(saveSettings(data, dir)).toBe(true);
    expect(readFileSync(join(dir, "settings.json"), "utf8")).toBe(settingsToJsonText(data));
    expect(existsSync(join(dir, `settings.json.${process.pid}.tmp`))).toBe(false);
  });

  test("the temp file is PID-suffixed in the target directory, like the Rust oracle", () => {
    const dir = tempDir("atomic-name");
    let written: string | null = null;
    const ok = writeSettingsAtomic('{"Theme":"dark"}', dir, 424242, (path, text) => {
      written = path;
      writeFileSync(path, text, "utf8");
    });
    expect(ok).toBe(true);
    expect(written).toBe(join(dir, "settings.json.424242.tmp"));
    // the rename moved it onto the target
    expect(existsSync(written!)).toBe(false);
    expect(readFileSync(join(dir, "settings.json"), "utf8")).toBe('{"Theme":"dark"}');
  });

  test("a failing write removes the half-written temp (Suggestion 13) and reports failure", () => {
    const dir = tempDir("atomic-write-fail");
    const boom = (path: string, text: string): void => {
      expect(text).toBe("{}");
      writeFileSync(path, "{", "utf8"); // a half-written temp, then the crash
      throw new Error("disk on fire");
    };
    expect(writeSettingsAtomic("{}", dir, 777, boom)).toBe(false);
    expect(existsSync(join(dir, "settings.json.777.tmp"))).toBe(false);
    expect(existsSync(join(dir, "settings.json"))).toBe(false);
  });

  test("a failing rename cleans the temp up and reports failure too", () => {
    const dir = tempDir("atomic-rename-fail");
    // the target is occupied by a directory, so the rename cannot succeed
    mkdirSync(join(dir, "settings.json"), { recursive: true });
    expect(writeSettingsAtomic("{}", dir, 778)).toBe(false);
    expect(existsSync(join(dir, "settings.json.778.tmp"))).toBe(false);
  });

  test("an unwritable config dir reports failure instead of throwing", () => {
    const occupied = join(tempDir("atomic-dir-fail"), "occupied");
    writeFileSync(occupied, "", "utf8");
    expect(saveSettings(defaultSettings(), occupied)).toBe(false);
  });
});

describe("autostart reconcile (SPEC 18.3, REVIEW-RUST Minor 2)", () => {
  test("the decision matrix heals both directions but never repoints an existing value", () => {
    expect(reconcileNeedsApply(true, false)).toBe(true); // missing value -> write it
    expect(reconcileNeedsApply(false, true)).toBe(true); // stale value -> delete it
    expect(reconcileNeedsApply(true, true)).toBe(false); // in sync; no repointing at launch
    expect(reconcileNeedsApply(false, false)).toBe(false); // in sync
  });

  test("the existence probe queries the Run value by NAME, whatever its type", () => {
    // get_raw_value(..).is_ok() in Rust: a hand-written REG_DWORD must count
    // as existing, not be misread as "missing" and skip the delete.
    expect(regQueryRunValueCommand()).toEqual([
      "reg.exe",
      "query",
      "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run",
      "/v",
      "KimiPlanbarTui",
    ]);
  });
});

describe("autostart argv (SPEC 18.3)", () => {
  test("on writes the quoted exe path, off deletes the value", () => {
    const on = autoStartCommand({ theme: "system", refreshMinutes: 5, autoStart: true }, "C:\\a b\\k.exe");
    expect(on.slice(0, 4)).toEqual(["reg.exe", "add", "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run", "/v"]);
    expect(on).toContain("KimiPlanbarTui");
    expect(on[on.length - 2]).toBe('"C:\\a b\\k.exe"');
    expect(autoStartCommand({ theme: "system", refreshMinutes: 5, autoStart: false }, "x")).toEqual([
      "reg.exe",
      "delete",
      "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run",
      "/v",
      "KimiPlanbarTui",
      "/f",
    ]);
  });
});

test("golden timezone guard is live on this machine", () => {
  if (!timezoneMatchesGolden()) throw new Error("run tests through `bun run test` (TZ=Asia/Shanghai)");
});
