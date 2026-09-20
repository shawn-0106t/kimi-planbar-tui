// M4.2 probe: which switch actually makes a *compiled* Bun executable trust the
// Windows system CA store? This machine runs ESET TLS interception, whose root
// is in the system store but not in Bun's bundled Mozilla set, so
// api.github.com is the natural canary (SPEC §22.4).
//
//   bun build --compile test/system-ca-probe.ts --outfile %TEMP%/ca-probe.exe
//   %TEMP%/ca-probe.exe                      # no switch
//   set NODE_USE_SYSTEM_CA=1 & %TEMP%/ca-probe.exe
//   set BUN_USE_SYSTEM_CA=1  & %TEMP%/ca-probe.exe
//
// Prints one line per endpoint: ok / the error text.

const URLS: [string, string][] = [
  ["github-api", "https://api.github.com/repos/MoonshotAI/kimi-code/releases/latest"],
  ["changelog", "https://moonshotai.github.io/kimi-code/en/release-notes/changelog.md"],
];

const env = (name: string): string => process.env[name] ?? "(unset)";
console.log(`execPath=${process.execPath}`);
console.log(`NODE_USE_SYSTEM_CA=${env("NODE_USE_SYSTEM_CA")} BUN_USE_SYSTEM_CA=${env("BUN_USE_SYSTEM_CA")}`);

for (const [label, url] of URLS) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "KimiPlanbarTui", "Accept-Encoding": "identity" } });
    const body = await res.text();
    console.log(`${label}: ok status=${res.status} bytes=${body.length}`);
  } catch (e) {
    console.log(`${label}: FAILED ${String(e).slice(0, 160)}`);
  }
}
