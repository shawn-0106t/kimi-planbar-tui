import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { goldenText } from "./goldens.ts";

const SRC = join(import.meta.dir, "..", "src");
const REPO = join(import.meta.dir, "..", "..");
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

describe("layering (SPEC 3.1)", () => {
  test("no core module reaches into the renderer", () => {
    const offenders = walk(join(SRC, "core"))
      .filter((file) => /@opentui/.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(SRC.length + 1));
    expect(offenders).toEqual([]);
  });

  test("core stays free of the terminal so --test-fetch runs headless", () => {
    const offenders = walk(join(SRC, "core"))
      .filter((file) => /from "(@opentui|node:tty)/.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(SRC.length + 1));
    expect(offenders).toEqual([]);
  });
});

/** chrono's nanoseconds cannot be reproduced from a millisecond clock, so the
 *  diff normalizes that one field; everything else compares byte for byte. */
const normalize = (text: string): string => text.replace(/"fetchedAt": "[^"]*"/, '"fetchedAt": "<NOW>"');

const selfCheckRun = (arg: string): { code: number | null; out: string } => {
  const cmd = [
    process.execPath,
    "run",
    "--use-system-ca",
    join(SRC, "main.ts"),
    arg,
  ];
  const proc = Bun.spawnSync({ cmd, stdout: "pipe", stderr: "pipe" });
  return {
    code: proc.exitCode,
    out: new TextDecoder("utf-8").decode(proc.stdout).replace(/\r\n/g, "\n"),
  };
};

const selfCheck = (arg: string): string => {
  const run = selfCheckRun(arg);
  expect(run.code).toBe(0);
  return run.out;
};

// Computed before the tests are declared so a precondition can become a real
// skip: a bare `return` inside the body reports green without ever asserting.
const FETCH = selfCheckRun("--test-fetch");
const hasLiveToken = !(FETCH.out ?? "").includes('"no-token"');
const rustBuilt = existsSync(RUST_EXE);
const testRust = rustBuilt ? test : test.skip;

describe("--test-fetch parity (SPEC 19)", () => {
  test("all five keys, serde text and a single trailing newline", () => {
    expect(FETCH.code).toBe(0);
    const out = FETCH.out;
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

  test.skipIf(hasLiveToken)("the no-token document equals the Rust oracle golden", () => {
    expect(FETCH.code).toBe(0);
    expect(normalize(FETCH.out.trimEnd())).toBe(normalize(goldenText("quota-error-no-token")));
  });

  testRust("the Rust debug build agrees field by field", () => {
    const ts = normalize(selfCheck("--test-fetch").trimEnd());
    const rust = normalize(
      new TextDecoder("utf-8")
        .decode(Bun.spawnSync({ cmd: [RUST_EXE, "--test-fetch"], stdout: "pipe" }).stdout)
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

  testRust("the Rust debug build prints the same line", () => {
    const ts = selfCheck("--test-update");
    const rust = new TextDecoder("utf-8")
      .decode(Bun.spawnSync({ cmd: [RUST_EXE, "--test-update"], stdout: "pipe" }).stdout)
      .replace(/\r\n/g, "\n");
    expect(ts).toBe(rust);
  });
});
