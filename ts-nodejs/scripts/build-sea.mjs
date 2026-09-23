// SEA packaging (SPEC §22.4 for the baked execArgv). This Node 24.19 has
// no `node --build-sea`, so the official multi-step flow runs here instead:
// esbuild bundle -> sea blob -> copy node.exe -> postject inject.
//
// Output: dist/kpt-tui-node.exe (~88.7 MB, embeds the Node runtime).
// --use-system-ca is baked into execArgv so the exe trusts the machine's
// ESET-style TLS re-signing roots (SPEC 17.2 / plan §7).

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "dist");
const EXE = join(DIST, "kpt-tui-node.exe");
const BLOB = join(DIST, "sea-prep.blob");
const CONFIG = join(DIST, "sea-config.json");

const run = (cmd, args) => {
  const proc = spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT });
  if (proc.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${proc.status}`);
};

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

// 1. Bundle. CJS because Node 24 runs a single executable's main as CommonJS
//    (sea-config has no mainFormat key until the Node 25.5 `--build-sea` era);
//    the source graph avoids import.meta and top-level await, so lowering is
//    transparent.
console.log("[sea] bundling src/main.ts");
buildSync({
  entryPoints: [join(ROOT, "src", "main.ts")],
  outfile: join(DIST, "bundle.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node24",
  logLevel: "warning",
});

// 2. Blob. execArgv bakes the TLS and warning flags into the exe.
writeFileSync(
  CONFIG,
  JSON.stringify(
    {
      main: join(DIST, "bundle.cjs"),
      output: BLOB,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
      execArgv: ["--use-system-ca", "--no-warnings"],
      execArgvExtension: "none",
    },
    null,
    2,
  ),
);
console.log("[sea] generating blob");
run(process.execPath, ["--experimental-sea-config", CONFIG]);

// 3. Copy the runtime, then 4. inject the blob (PE resource, postject
//    defaults; --macho-segment-name is macOS-only and not needed here).
console.log("[sea] copying node.exe");
copyFileSync(process.execPath, EXE);
console.log("[sea] injecting blob");
// postject's JS API: no npx shim involved (npx is a .cmd on Windows and does
// not spawn without a shell). The fuse sentinel hash differs across Node
// builds, so read it out of the runtime binary instead of hardcoding.
const sentinel = /NODE_SEA_FUSE_[a-f0-9]{32}/.exec(readFileSync(process.execPath, "latin1"))?.[0];
if (sentinel === undefined) throw new Error("NODE_SEA_FUSE sentinel not found in node.exe");
const { inject } = await import("postject/dist/api.js");
await inject(EXE, "NODE_SEA_BLOB", readFileSync(BLOB), { sentinelFuse: sentinel });

console.log(`[sea] done: ${EXE}`);
