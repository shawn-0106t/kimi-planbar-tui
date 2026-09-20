// Settings persistence + autostart, a 1:1 port of rust/src/settings.rs (SPEC 18).
// The on-disk file is shared with the Rust edition, so the byte shape matters:
// PascalCase keys, 2-space indent and no trailing newline.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  jAsBool,
  jAsStr,
  parseJsonValue,
  serBool,
  serI64,
  serObj,
  serStr,
  serdePrettyJson,
  type SerNode,
} from "./json.ts";
import { readTextStrict } from "./credentials.ts";

export interface SettingsData {
  theme: string; // system | light | dark
  refreshMinutes: number; // 1 | 5 | 10 | 30
  autoStart: boolean;
}

export const defaultSettings = (): SettingsData => ({
  theme: "system",
  refreshMinutes: 5,
  autoStart: false,
});

/** `std::env::current_exe()`: under `node src/main.ts` that is node.exe, and
 *  under a SEA single-file exe it is that exe — so portable.dat and the
 *  autostart value follow whichever binary is actually running (SPEC 18.1, 18.3). */
export function currentExe(): string {
  return process.execPath;
}

export function configDir(
  exe: string = currentExe(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const exeDir = dirname(exe);
  if (existsSync(join(exeDir, "portable.dat"))) return exeDir;
  const appdata = env["APPDATA"];
  if (appdata !== undefined && appdata !== "") return join(appdata, "KimiPlanbarTui");
  return exeDir;
}

export const settingsPath = (dir: string): string => join(dir, "settings.json");

const I64_MAX = 9223372036854775807n;
const I64_MIN = -(1n << 63n);

/** serde's `#[serde(default)]` plus a whole-document failure: a type mismatch
 *  on any single key discards all three values, while a missing key alone
 *  falls back to that key's default. */
export function parseSettingsJson(text: string): SettingsData {
  const fallback = defaultSettings();
  let root;
  try {
    root = parseJsonValue(text);
  } catch {
    return fallback;
  }
  if (root.kind !== "obj") return fallback;

  const themeNode = root.members.get("Theme");
  const refreshNode = root.members.get("RefreshMinutes");
  const autoStartNode = root.members.get("AutoStart");

  let theme = fallback.theme;
  if (themeNode !== undefined) {
    const value = jAsStr(themeNode);
    if (value === undefined) return fallback;
    theme = value;
  }
  let refreshMinutes = fallback.refreshMinutes;
  if (refreshNode !== undefined) {
    if (refreshNode.kind !== "num" || !/^-?\d+$/.test(refreshNode.token)) return fallback;
    const value = BigInt(refreshNode.token);
    if (value < I64_MIN || value > I64_MAX) return fallback;
    refreshMinutes = Number(value);
  }
  let autoStart = fallback.autoStart;
  if (autoStartNode !== undefined) {
    const value = jAsBool(autoStartNode);
    if (value === undefined) return fallback;
    autoStart = value;
  }
  return { theme, refreshMinutes, autoStart };
}

export const settingsToSerde = (data: SettingsData): SerNode =>
  serObj([
    ["Theme", serStr(data.theme)],
    ["RefreshMinutes", serI64(data.refreshMinutes)],
    ["AutoStart", serBool(data.autoStart)],
  ]);

/** The exact bytes Rust's `to_string_pretty` writes: no trailing newline. */
export const settingsToJsonText = (data: SettingsData): string => serdePrettyJson(settingsToSerde(data));

export function loadSettings(dir: string = configDir()): SettingsData {
  const text = readTextStrict(settingsPath(dir));
  if (text === null) return defaultSettings();
  return parseSettingsJson(text);
}

export function saveSettings(data: SettingsData, dir: string = configDir()): void {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(settingsPath(dir), settingsToJsonText(data));
  } catch {
    // every IO failure is swallowed and surfaced only through the UI (SPEC 20)
  }
}

const RUN_KEY = "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE = "KimiPlanbarTui";

/** The reg.exe argv, kept separate so tests can pin the quoting without
 *  touching the real Run key. */
export function autoStartCommand(data: SettingsData, exe: string): string[] {
  return data.autoStart
    ? ["reg.exe", "add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", `"${exe}"`, "/f"]
    : ["reg.exe", "delete", RUN_KEY, "/v", RUN_VALUE, "/f"];
}

/** HKCU Run autostart through reg.exe (SPEC 18.3): write or delete only, never
 *  read back, and swallow every failure. */
export function applyAutoStart(data: SettingsData, exe: string = currentExe()): void {
  try {
    const cmd = autoStartCommand(data, exe);
    spawnSync(cmd[0]!, cmd.slice(1), { stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
  } catch {
    // reg.exe missing or the key unavailable: the setting simply does not apply
  }
}
