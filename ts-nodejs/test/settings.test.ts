import { describe, expect, test } from "./bun-shim.ts";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  autoStartCommand,
  configDir,
  defaultSettings,
  loadSettings,
  parseSettingsJson,
  reconcileNeedsApply,
  runValueExists,
  runValueQueryCommand,
  saveSettings,
  settingsToJsonText,
  type SettingsData,
} from "../src/core/settings.ts";
import { goldenText, timezoneMatchesGolden } from "./goldens.ts";

const tempDir = (label: string): string => {
  const dir = join(process.env["TMP"] ?? ".", `kpt-${label}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
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
    rmSync(dir, { recursive: true, force: true });
  });

  test("a missing file yields defaults, and saving reads back identically", () => {
    const dir = tempDir("roundtrip");
    expect(loadSettings(dir)).toEqual(defaultSettings());
    const data: SettingsData = { theme: "dark", refreshMinutes: 1, autoStart: false };
    expect(saveSettings(data, dir)).toBe(true);
    expect(loadSettings(dir)).toEqual(data);
    expect(readFileSync(join(dir, "settings.json"), "utf8")).toBe(settingsToJsonText(data));
    rmSync(dir, { recursive: true, force: true });
  });

  test("an atomic save leaves no temp file behind (SPEC 18.2)", () => {
    const dir = tempDir("atomic");
    saveSettings({ theme: "light", refreshMinutes: 10, autoStart: true }, dir);
    expect(readdirSync(dir)).toEqual(["settings.json"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("an unwritable config dir reports failure and writes nothing (SPEC 13.2)", () => {
    // The dir argument is an existing FILE: mkdirSync fails, saveSettings
    // must return false so the UI can keep the draft on the form.
    const parent = tempDir("fail-mkdir");
    const blocked = join(parent, "not-a-dir");
    writeFileSync(blocked, "x", "utf8");
    expect(saveSettings(defaultSettings(), blocked)).toBe(false);
    rmSync(parent, { recursive: true, force: true });
  });

  test("a failed temp write is cleaned up and the target stays untouched (REVIEW-RUST Suggestion 13)", () => {
    const dir = tempDir("fail-write");
    // A read-only file sits at the exact temp path the writer will use, so
    // writeFileSync fails after mkdir succeeded (Windows: chmod 0o444 maps to
    // FILE_ATTRIBUTE_READONLY).
    const tmp = join(dir, `settings.json.${process.pid}.tmp`);
    writeFileSync(tmp, "sentinel", "utf8");
    chmodSync(tmp, 0o444);
    expect(saveSettings({ theme: "dark", refreshMinutes: 5, autoStart: false }, dir)).toBe(false);
    // The symmetric cleanup removed the half-written temp; the target was
    // never touched.
    expect(existsSync(tmp)).toBe(false);
    expect(existsSync(join(dir, "settings.json"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a failed rename leaves no temp file behind (REVIEW-RUST Suggestion 13)", () => {
    const dir = tempDir("fail-rename");
    // A DIRECTORY at the target path blocks the rename but not the temp
    // write, so the rename-failure cleanup branch runs and must remove the
    // half-written temp.
    mkdirSync(join(dir, "settings.json"));
    expect(saveSettings({ theme: "dark", refreshMinutes: 5, autoStart: false }, dir)).toBe(false);
    expect(readdirSync(dir)).toEqual(["settings.json"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("saving over a corrupt file repairs it", () => {
    const dir = tempDir("corrupt");
    writeFileSync(join(dir, "settings.json"), "{oops", "utf8");
    expect(loadSettings(dir)).toEqual(defaultSettings());
    saveSettings({ theme: "system", refreshMinutes: 30, autoStart: false }, dir);
    expect(loadSettings(dir).refreshMinutes).toBe(30);
    rmSync(dir, { recursive: true, force: true });
  });

  test("re-serializing a parsed settings file is byte-stable", () => {
    // Fixture version of the old "the file the Rust edition wrote on this
    // machine" test — same semantics (parse -> serialize round-trips byte for
    // byte) without depending on the real %APPDATA% state.
    const dir = tempDir("roundtrip");
    const bytes = settingsToJsonText({ theme: "dark", refreshMinutes: 10, autoStart: true });
    writeFileSync(join(dir, "settings.json"), bytes, "utf8");
    const data = parseSettingsJson(readFileSync(join(dir, "settings.json"), "utf8"));
    expect(settingsToJsonText(data)).toBe(bytes);
    rmSync(dir, { recursive: true, force: true });
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

describe("startup reconcile decision (SPEC 18.3, REVIEW-RUST Minor 2)", () => {
  // The registry touchpoints (runValueExists / applyAutoStart) spawn the real
  // reg.exe, so only the pure decision and the argv are pinned here; the
  // wiring is one call after loadSettings() in app.ts.
  test("the existence probe queries the Run value by NAME", () => {
    expect(runValueQueryCommand()).toEqual([
      "reg.exe",
      "query",
      "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run",
      "/v",
      "KimiPlanbarTui",
    ]);
  });

  test("heals both directions, never repoints an existing value", () => {
    expect(reconcileNeedsApply(true, false)).toBe(true); // missing value -> write it
    expect(reconcileNeedsApply(false, true)).toBe(true); // stale value -> delete it
    expect(reconcileNeedsApply(true, true)).toBe(false); // in sync: leave alone
    expect(reconcileNeedsApply(false, false)).toBe(false); // in sync: leave alone
  });

  // Node trap the re-review caught: child_process.spawnSync does NOT throw on
  // a missing executable (Bun.spawnSync does) — it returns status: null with
  // the failure in .error. A try/catch-based null would be dead code and the
  // reconcile would misread reg.exe's absence as "value absent" and apply
  // (re-pointing an existing value, creating the whole Run key).
  test("a failed probe (ENOENT) is null, a missing value is false", () => {
    const enoent = {
      status: null,
      error: Object.assign(new Error("spawn reg.exe ENOENT"), { code: "ENOENT" }),
    };
    expect(runValueExists(() => enoent)).toBe(null);
    expect(runValueExists(() => ({ status: null }))).toBe(null); // killed process: no error, no result
    expect(runValueExists(() => ({ status: 0 }))).toBe(true); // value present
    expect(runValueExists(() => ({ status: 1 }))).toBe(false); // value absent
  });
});

test("golden timezone guard is live on this machine", () => {
  if (!timezoneMatchesGolden()) throw new Error("run tests through `npm test` (TZ=Asia/Shanghai)");
});
