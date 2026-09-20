// Entry point. The headless self-checks come first and print, then exit
// (SPEC 19); they never touch the terminal. `--test-fetch` is checked before
// `--test-update`, exactly like the Rust main, and the flags match at any
// position in the argument list.

import { fetchQuota, quotaResultToSerde } from "./core/quota.ts";
import { serdePrettyJson } from "./core/json.ts";
import { checkUpdate, dotnetBool } from "./core/update.ts";

async function main(args: string[]): Promise<number> {
  if (args.includes("--test-fetch")) {
    const result = await fetchQuota();
    console.log(serdePrettyJson(quotaResultToSerde(result)));
    return 0;
  }

  if (args.includes("--test-update")) {
    const status = await checkUpdate();
    console.log(
      `local=${status.localVersion ?? ""} latest=${status.latestVersion ?? ""} ` +
        `updateAvailable=${dotnetBool(status.updateAvailable)} checkFailed=${dotnetBool(status.checkFailed)}`,
    );
    return 0;
  }

  process.stderr.write(
    "kimi-planbar-tui-ts: the terminal UI is milestone M2 (see docs/TS-EDITION-PLAN.md).\n" +
      "Self-checks available: --test-fetch, --test-update\n",
  );
  return 1;
}

process.exitCode = await main(process.argv.slice(2));
