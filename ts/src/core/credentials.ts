// Credential chain, a 1:1 port of rust/src/credentials.rs (SPEC 16.2):
// 1) <kimi_home>/credentials/kimi-code.json -> access_token (expires_at > now+30s)
// 2) <kimi_home>/config.toml -> provider whose base_url contains api.kimi.com/coding
// 3) nothing -> the caller reports "no-token"
// The token is only ever read here and sent to the usages endpoint (SPEC 6).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  jAsStr,
  parseF64Strict,
  parseJsonValue,
  RUST_WS_REGEX_CLASS,
  rustLines,
  rustTrim,
  rustTrimMatchesAny,
} from "./json.ts";

/** `fs::read_to_string` also fails on invalid UTF-8, so a damaged file means
 *  "no data" rather than mojibake that the parser would then chew on. */
export function readTextStrict(path: string): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
  } catch {
    return null;
  }
}

/** Rust's `std::env::home_dir` shape used by the tray and TUI editions. */
export function homeDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const profile = env["USERPROFILE"];
  if (profile !== undefined && profile !== "") return profile;
  const drive = env["HOMEDRIVE"];
  const path = env["HOMEPATH"];
  if (drive !== undefined && path !== undefined) return `${drive}${path}`;
  return null;
}

/** `~/.kimi-code`, with the `KIMI_CODE_HOME` override (SPEC 16.2 / 21.2). */
export function kimiHome(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env["KIMI_CODE_HOME"];
  if (override !== undefined && override !== "") return override;
  return join(home, ".kimi-code");
}

/** JSON number-or-string -> f64 (the server models numbers as strings). */
function asF64(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  if (typeof value === "number") return value;
  return parseF64Strict(rustTrim(value));
}

function tokenFromCredentials(kimiDir: string, nowSec: number): string | null {
  const text = readTextStrict(join(kimiDir, "credentials", "kimi-code.json"));
  if (text === null) return null;
  let accessToken: string | undefined;
  let expiresAt: string | number | undefined;
  try {
    const root = parseJsonValue(text);
    if (root.kind !== "obj") return null;
    accessToken = jAsStr(root.members.get("access_token"));
    const exp = root.members.get("expires_at");
    expiresAt = exp?.kind === "num" ? exp.value : exp?.kind === "str" ? exp.value : undefined;
  } catch {
    return null; // a parse error is silently swallowed, as in Rust
  }
  if (accessToken === undefined) return null;
  const exp = asF64(expiresAt) ?? 0.0; // a missing or junk expiry reads as expired
  return exp > nowSec + 30.0 ? accessToken : null;
}

function matchProvider(
  section: string | null,
  baseUrl: string | null,
  apiKey: string | null,
): string | null {
  if (section === null || baseUrl === null || apiKey === null) return null;
  if (!section.startsWith("providers.")) return null;
  if (!baseUrl.includes("api.kimi.com/coding")) return null;
  return apiKey === "" ? null : apiKey;
}

const TOML_KV = new RegExp(`^(base_url|api_key)${RUST_WS_REGEX_CLASS}*=${RUST_WS_REGEX_CLASS}*"([^"]*)"`, "u");

/** The hand-rolled line parser behind SPEC 16.2 step 2: no TOML crate, the
 *  previous section is settled when a new one opens and once more at EOF. */
export function tokenFromConfigToml(text: string): string | null {
  let section: string | null = null;
  let baseUrl: string | null = null;
  let apiKey: string | null = null;
  for (const raw of rustLines(text)) {
    const line = rustTrim(raw);
    if (line.startsWith("[")) {
      const found = matchProvider(section, baseUrl, apiKey);
      if (found !== null) return found;
      section = rustTrimMatchesAny(line, ["[", "]"]);
      baseUrl = null;
      apiKey = null;
      continue;
    }
    const m = TOML_KV.exec(line);
    if (!m) continue;
    if (m[1] === "base_url") baseUrl = m[2] ?? "";
    else apiKey = m[2] ?? "";
  }
  return matchProvider(section, baseUrl, apiKey);
}

/** Testable half of the chain: everything except the home-dir lookup. */
export function loadTokenFrom(kimiDir: string, nowSec: number): string | null {
  const direct = tokenFromCredentials(kimiDir, nowSec);
  if (direct !== null) return direct;
  const text = readTextStrict(join(kimiDir, "config.toml"));
  if (text === null) return null;
  return tokenFromConfigToml(text);
}

export function loadToken(
  env: NodeJS.ProcessEnv = process.env,
  nowSec: number = Math.floor(Date.now() / 1000),
): string | null {
  const home = homeDir(env);
  if (home === null) return null;
  return loadTokenFrom(kimiHome(home, env), nowSec);
}
