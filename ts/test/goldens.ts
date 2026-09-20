import { existsSync, readFileSync } from "node:fs";
import { localOffsetMinutes } from "../src/core/json.ts";

/** Goldens are produced by the Rust oracle (test/parity/make-oracle.ts). Because
 *  chrono prints `DateTime<Local>`, their text is only reproducible on a machine
 *  in the same zone as the one that generated them. */
export const GOLDEN_TZ_OFFSET_MINUTES = 480;

export function timezoneMatchesGolden(): boolean {
  return localOffsetMinutes(Date.now()) === GOLDEN_TZ_OFFSET_MINUTES;
}

export function goldenText(name: string): string {
  const path = `${import.meta.dir}/golden/${name}.txt`;
  if (!existsSync(path)) throw new Error(`missing golden ${name} (run test/parity/make-oracle.ts)`);
  // The goldens are byte fixtures, so a checkout that rewrites line endings
  // (core.autocrlf) must not be allowed to fail a comparison.
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

/** Pairs of `[label, rawNumberText]` from a pretty-printed Rust array of 2-tuples,
 *  with the number kept as text so ryu's formatting can be compared verbatim. */
export function goldenPairs(name: string): [string, string][] {
  const text = goldenText(name);
  const re = /\[\s*"([^"]+)",\s*(-?[^\]\n]+?)\s*\]/g;
  const out: [string, string][] = [];
  for (const m of text.matchAll(re)) out.push([m[1]!, m[2]!.trim()]);
  return out;
}

/** Pipe-separated golden rows: `field1|field2|...`, last field may contain pipes. */
export function goldenRows(name: string): string[][] {
  return goldenText(name)
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => l.split("|"));
}
