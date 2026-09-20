import { describe, expect, test } from "./bun-shim.ts";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { goldenText } from "./goldens.ts";

const SRC = join(import.meta.dirname, "..", "src");
const REPO = join(import.meta.dirname, "..", "..");
const RUST_EXE = join(REPO, "rust", "target", "debug", "kimi-planbar-tui.exe");

const walk = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (path.endsWith(".ts")) out.push(path);
  }
  return out;
};

describe("layering (SPEC §22.5)", () => {
  test("no core module reaches into the render layer", () => {
    const offenders = walk(join(SRC, "core"))
      .filter((file) => /from "\.\.\/tui\//.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(SRC.length + 1));
    expect(offenders).toEqual([]);
  });

  test("core stays free of the terminal so --test-fetch runs headless", () => {
    const offenders = walk(join(SRC, "core"))
      .filter((file) => /from "(node:tty|node:readline)/.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(SRC.length + 1));
    expect(offenders).toEqual([]);
  });
});

/** chrono's nanoseconds cannot be reproduced from a millisecond clock, so the
 *  diff normalizes that one field; everything else compares byte for byte. */
const normalize = (text: string): string => text.replace(/"fetchedAt": "[^"]*"/, '"fetchedAt": "<NOW>"');

const selfCheck = (arg: string, useSystemCa = true): string => {
  const cmd = [process.execPath, ...(useSystemCa ? ["--use-system-ca"] : []), join(SRC, "main.ts"), arg];
  const proc = spawnSync(cmd[0]!, cmd.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
  expect(proc.status).toBe(0);
  return new TextDecoder("utf-8").decode(proc.stdout).replace(/\r\n/g, "\n");
};

describe("--test-fetch parity (SPEC 19)", () => {
  test("all five keys, serde text and a single trailing newline", () => {
    const out = selfCheck("--test-fetch");
    expect(out.endsWith("\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(false);
    const lines = out.split("\n");
    expect(lines[0]).toBe("{");
    expect(lines[lines.length - 2]).toBe("}");
    for (const key of ["fiveHour", "week", "extra", "fetchedAt", "error"]) {
      expect(out).toContain(`  "${key}": `);
    }
    expect(() => JSON.parse(out)).not.toThrow();
    const parsed = JSON.parse(out) as { error: string | null; percent?: unknown };
    expect(["no-token", null]).toContain(parsed.error);
  });

  test("the no-token document equals the Rust oracle golden", () => {
    const out = selfCheck("--test-fetch");
    if (!out.includes('"no-token"')) return; // a live token is on this machine
    expect(normalize(out.trimEnd())).toBe(normalize(goldenText("quota-error-no-token")));
  });

  test("the Rust debug build agrees field by field, when it exists", () => {
    if (!existsSync(RUST_EXE)) return;
    const ts = normalize(selfCheck("--test-fetch").trimEnd());
    const rust = normalize(
      new TextDecoder("utf-8")
        .decode(spawnSync(RUST_EXE, ["--test-fetch"], { stdio: ["ignore", "pipe", "ignore"] }).stdout)
        .replace(/\r\n/g, "\n")
        .trimEnd(),
    );
    expect(ts).toBe(rust);
  });
});

describe("--test-update parity (SPEC 19)", () => {
  test("one line, four fields, .NET-style booleans", () => {
    expect(selfCheck("--test-update")).toMatch(
      /^local=\S* latest=\S* updateAvailable=(True|False) checkFailed=(True|False)\n$/,
    );
  });

  test("the Rust debug build prints the same line, when it exists", () => {
    if (!existsSync(RUST_EXE)) return;
    const ts = selfCheck("--test-update");
    const rust = new TextDecoder("utf-8")
      .decode(spawnSync(RUST_EXE, ["--test-update"], { stdio: ["ignore", "pipe", "ignore"] }).stdout)
      .replace(/\r\n/g, "\n");
    expect(ts).toBe(rust);
  });
});
