import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  autoStartCommand,
  configDir,
  defaultSettings,
  loadSettings,
  parseSettingsJson,
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

  test("a number out of i64 range is a type error", () => {
    expect(parseSettingsJson('{"RefreshMinutes":9223372036854775808}')).toEqual(defaultSettings());
    expect(parseSettingsJson('{"RefreshMinutes":9223372036854775807}').refreshMinutes).toBe(
      9223372036854775807,
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
    saveSettings(data, dir);
    expect(loadSettings(dir)).toEqual(data);
    expect(readFileSync(join(dir, "settings.json"), "utf8")).toBe(settingsToJsonText(data));
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
