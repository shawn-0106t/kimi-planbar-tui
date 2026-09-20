// Read-only Kimi Code skill scanner, a 1:1 port of rust/src/skills.rs (SPEC 21.2).
// No writes, no watchers, no polling: the caller scans once and caches.

import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homeDir, kimiHome } from "./credentials.ts";
import {
  rustLines,
  rustStripLeadingBoms,
  rustTrim,
  rustTrimEnd,
  rustTrimMatchesChar,
} from "./json.ts";

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  /** Group label: "Kimi Code" | "Agents" | "Plugin: <name>" */
  source: string;
}

const FRONTMATTER_BYTES = 4096;

/** `str::split_once(':')` — split at the first colon. */
function splitOnce(input: string, sep: string): [string, string] | null {
  const at = input.indexOf(sep);
  return at < 0 ? null : [input.slice(0, at), input.slice(at + sep.length)];
}

/** name/description out of the YAML frontmatter, read as bytes so a multi-byte
 *  character cut at the 4 KiB boundary degrades to U+FFFD instead of failing. */
export function parseFrontmatterFromBytes(bytes: Uint8Array): [string | null, string | null] {
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, FRONTMATTER_BYTES));
  const lines = rustLines(head);
  const first = lines.shift();
  if (first === undefined) return [null, null];
  if (rustStripLeadingBoms(rustTrim(first)) !== "---") return [null, null];

  let name: string | null = null;
  let description: string | null = null;
  for (const raw of lines) {
    const line = rustTrimEnd(raw);
    if (rustTrim(line) === "---") break;
    const pair = splitOnce(line, ":");
    if (pair === null) continue;
    const value = rustTrimMatchesChar(rustTrimMatchesChar(rustTrim(pair[1]), '"'), "'");
    const key = rustTrim(pair[0]);
    if (key === "name" && name === null) name = value;
    else if (key === "description" && description === null) description = value;
  }
  return [name, description];
}

export function parseFrontmatter(path: string): [string | null, string | null] {
  const bytes = readFileBytes(path);
  if (bytes === null) return [null, null];
  return parseFrontmatterFromBytes(bytes);
}

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory(); // follows symlinks, like Rust's is_dir
  } catch {
    return false;
  }
};

/** `<dir>/<id>/SKILL.md`: the same shape as the Rust `collect`, driven by real
 *  IO because the ported tests use a temp-directory fixture like Rust does. */
export function collectSkills(dir: string, source: string): SkillInfo[] {
  const out: SkillInfo[] = [];
  for (const entry of listDir(dir)) {
    if (!isDirectory(entry.path)) continue;
    const skillMd = join(entry.path, "SKILL.md");
    const bytes = readFileBytes(skillMd);
    if (bytes === null) continue; // no SKILL.md, or unreadable
    const [parsedName, parsedDescription] = parseFrontmatterFromBytes(bytes);
    out.push({
      id: entry.name,
      name: parsedName ?? entry.name, // a missing name falls back to the directory name
      description: parsedDescription ?? "",
      source,
    });
  }
  return out;
}

/** Group label order is by code point ("Agents" < "Kimi Code" < "Plugin: …"),
 *  then a case-insensitive name order — deliberately not localeCompare. */
export function sortSkills(list: SkillInfo[]): SkillInfo[] {
  const compare = (a: string, b: string): number => (a === b ? 0 : a < b ? -1 : 1);
  return list.sort(
    (a, b) =>
      compare(a.source, b.source) || compare(a.name.toLowerCase(), b.name.toLowerCase()),
  );
}

const listDir = (dir: string): { name: string; path: string }[] => {
  try {
    return readdirSync(dir, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      path: join(dir, entry.name),
    }));
  } catch {
    return [];
  }
};

/** Physically reads at most the first 4 KiB (mirrors Rust's
 *  `File::take(4096)`): a hostile multi-hundred-MB SKILL.md under a managed
 *  plugin directory must not be slurped whole. */
const readFileBytes = (path: string): Uint8Array | null => {
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(FRONTMATTER_BYTES);
      const read = readSync(fd, buf, 0, FRONTMATTER_BYTES, 0);
      return new Uint8Array(buf.subarray(0, read));
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
};

/** The three skill roots, sorted by source then name (SPEC 21.2). */
export function scanSkills(env: NodeJS.ProcessEnv = process.env): SkillInfo[] {
  const out: SkillInfo[] = [];
  const home = homeDir(env);
  if (home === null) return out;
  const kimi = kimiHome(home, env);

  out.push(...collectSkills(join(kimi, "skills"), "Kimi Code"));
  out.push(...collectSkills(join(home, ".agents", "skills"), "Agents"));

  for (const plugin of listDir(join(kimi, "plugins", "managed"))) {
    if (!isDirectory(plugin.path)) continue;
    out.push(...collectSkills(join(plugin.path, "skills"), `Plugin: ${plugin.name}`));
  }
  return sortSkills(out);
}
