// Cross-edition self-check diff (SPEC §22.1).
//
// Runs the headless self-checks of both editions back to back on this machine
// and compares the text. Only the `fetchedAt` *value* is normalized: the Rust
// build stamps nanoseconds from a 100 ns Windows clock, JS has milliseconds, so
// the two can never agree on that field. Everything else must be byte-identical.
//
//   bun run test/parity/diff.ts                     # both self-checks
//   bun run test/parity/diff.ts --ts-exe dist/kpt-tui.exe   # check a compiled build
import { existsSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..");
const RUST_EXE = process.env["KPT_RUST_EXE"] ?? join(REPO, "rust", "target", "debug", "kimi-planbar-tui.exe");
const args = process.argv.slice(2);
const tsExeAt = args.indexOf("--ts-exe");
const TS_EXE = tsExeAt >= 0 ? args[tsExeAt + 1] : null;

const tsCmd = TS_EXE
  ? [TS_EXE]
  : [process.execPath, "run", "--use-system-ca", join(REPO, "ts", "src", "main.ts")];

const normalize = (text: string): string =>
  text.replace(/\r\n/g, "\n").replace(/"fetchedAt": "[^"]*"/, '"fetchedAt": "<NOW>"');

const run = async (cmd: string[], flag: string): Promise<string> => {
  const proc = Bun.spawn({ cmd: [...cmd, flag], stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${cmd.join(" ")} ${flag} exited ${code}: ${err}`);
  return out;
};

const diff = (a: string, b: string): string[] => {
  const left = a.split("\n");
  const right = b.split("\n");
  const lines: string[] = [];
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] === right[i]) continue;
    lines.push(`line ${i + 1}:`);
    lines.push(`  - rust : ${left[i] ?? "<eof>"}`);
    lines.push(`  + ts   : ${right[i] ?? "<eof>"}`);
  }
  return lines;
};

let failures = 0;
for (const flag of ["--test-fetch", "--test-update"]) {
  if (!existsSync(RUST_EXE)) {
    console.error(`missing Rust build: ${RUST_EXE} (run \`cargo build\` in rust/)`);
    process.exit(2);
  }
  const rust = normalize(await run([RUST_EXE], flag));
  const ts = normalize(await run(tsCmd, flag));
  const lines = diff(rust, ts);
  if (lines.length === 0) {
    console.log(`${flag}: identical (${rust.trimEnd().split("\n").length} lines)`);
  } else {
    failures++;
    console.log(`${flag}: DIFFERS\n${lines.join("\n")}`);
  }
}

if (failures > 0) {
  console.error(`parity check failed (${failures} self-check(s) differ)`);
  process.exit(1);
}
console.log(TS_EXE ? "compiled exe matches the Rust edition" : "ts edition matches the Rust edition");
