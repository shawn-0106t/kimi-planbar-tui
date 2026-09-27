// Settings persistence + autostart, a 1:1 port of rust/src/settings.rs (SPEC 18).
// The on-disk file is shared with the Rust edition, so the byte shape matters:
// PascalCase keys, 2-space indent and no trailing newline.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
/** `Number(bigint)` lies beyond 2^53; clamp to the exactly-representable
 *  range so the value we keep (and re-serialize) is never silently rounded.
 *  Polling clamps the delay to the setTimeout ceiling anyway, so behavior is
 *  unchanged for every sane value. */
const SAFE_MAX = BigInt(Number.MAX_SAFE_INTEGER);
const SAFE_MIN = -SAFE_MAX;

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
    const clamped = value > SAFE_MAX ? SAFE_MAX : value < SAFE_MIN ? SAFE_MIN : value;
    refreshMinutes = Number(clamped);
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

/** Write settings.json and report success (SPEC 18.2, REVIEW-RUST Minor 2):
 *  the write is atomic-ish — a PID-suffixed temp file in the same directory,
 *  then rename over the target — so a crash mid-write can never leave a
 *  truncated settings.json behind (a truncated file would silently fall back
 *  to all defaults on next load). Every IO failure is swallowed and reported
 *  as `false`; the UI side decides what a failed save looks like (SPEC 13.2). */
export function saveSettings(data: SettingsData, dir: string = configDir()): boolean {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // every IO failure is swallowed and surfaced only through the UI (SPEC 20)
    return false;
  }
  const tmp = join(dir, `settings.json.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, settingsToJsonText(data));
  } catch {
    removeTemp(tmp); // drop a half-written temp, symmetric with the rename-failure path (REVIEW-RUST Suggestion 13)
    return false;
  }
  try {
    renameSync(tmp, settingsPath(dir));
  } catch {
    removeTemp(tmp); // best-effort cleanup, keep the dir tidy (REVIEW-RUST Suggestion 13)
    return false;
  }
  return true;
}

/** Best-effort `fs::remove_file` counterpart: cleanup must never turn a
 *  handled save failure into an unhandled throw. */
function removeTemp(tmp: string): void {
  try {
    rmSync(tmp, { force: true });
  } catch {
    // the half-written temp stays behind, exactly like `let _ = remove_file`
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

/** The reg.exe existence probe argv, kept separate so tests can pin the
 *  quoting without touching the real Run key. */
export function runValueQueryCommand(): string[] {
  return ["reg.exe", "query", RUN_KEY, "/v", RUN_VALUE];
}

/** Narrow spawnSync shape for the test seam: the probe's decision only reads
 *  `status` and `error` (the full SpawnSyncReturns and the overloaded
 *  signatures are irrelevant here and would make a fake unconstructible). */
type ProbeSpawn = (
  cmd: string,
  args: string[],
  opts: { stdio: ["ignore", "ignore", "ignore"]; windowsHide: boolean },
) => { status: number | null; error?: Error };

/** True when the HKCU Run value exists, judged by VALUE NAME (REVIEW-RUST
 *  Minor 2): `reg.exe query ... /v <name>` fails whenever the name is absent,
 *  whatever its type — a manually written REG_DWORD still counts as existing,
 *  so the reconcile delete below is not skipped. Null when the probe itself
 *  failed (reg.exe missing): a failed probe must leave the registry alone
 *  (same contract as the ts/ edition and the Rust oracle, whose reconcile
 *  returns early when the key cannot be opened). Note the Node trap the
 *  review round caught: `spawnSync` does NOT throw on ENOENT — it returns
 *  `status: null` with the failure in `.error` — so the failure check is on
 *  `probe.error`, not a try/catch (Bun.spawnSync is the one that throws).
 *  `spawnFn` is a test seam; production never passes it. */
export function runValueExists(spawnFn: ProbeSpawn = spawnSync): boolean | null {
  const cmd = runValueQueryCommand();
  const probe = spawnFn(cmd[0]!, cmd.slice(1), {
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
  });
  if (probe.error || probe.status === null) return null; // spawn failure or killed process: probe failed, not "value absent"
  return probe.status === 0;
}

/** The reconcile decision (REVIEW-RUST Minor 2), pure for tests: heal both
 *  directions; an in-sync pair — AutoStart=true with an existing value — is
 *  deliberately left alone (no repointing at every launch: a stale exe path
 *  self-corrects on the next explicit save, and repointing would let a dev
 *  build fight the installed one over the value). */
export function reconcileNeedsApply(autoStart: boolean, existing: boolean): boolean {
  // AutoStart=true but the value is missing -> write it
  // AutoStart=false but the value exists -> delete it
  return (autoStart && !existing) || (!autoStart && existing);
}

/** Startup reconciliation (REVIEW-RUST Minor 2): settings.json is the source
 *  of truth, the HKCU Run value the executed contract. A legacy non-atomic
 *  write (or a manual registry edit) could leave the two diverged — e.g. the
 *  value stuck on `true` while settings.json fell back to AutoStart=false, so
 *  the machine kept autostarting an app whose settings screen said off. A
 *  failed probe leaves the registry alone (a "value absent" misread would
 *  both re-point an existing value and create the whole Run key via
 *  `reg add`, which the Rust oracle never does). All errors silently
 *  swallowed (code-style baseline). */
export function reconcileAutoStart(data: SettingsData, exe: string = currentExe()): void {
  const existing = runValueExists();
  if (existing === null) return;
  if (reconcileNeedsApply(data.autoStart, existing)) {
    applyAutoStart(data, exe);
  }
}
