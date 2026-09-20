// Entry point. The headless self-checks come first and print, then exit
// (SPEC 19); they never touch the terminal. `--test-fetch` is checked before
// `--test-update`, exactly like the Rust main, and the flags match at any
// position in the argument list.

import { fetchQuota, quotaResultToSerde } from "./core/quota.ts";
import { serdePrettyJson } from "./core/json.ts";
import { checkUpdate, dotnetBool } from "./core/update.ts";
import { runTui } from "./tui/app.ts";

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

  // SPEC 19: unrecognized arguments are ignored and the TUI starts normally.
  await runTui();
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
