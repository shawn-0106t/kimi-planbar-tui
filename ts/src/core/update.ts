// CLI version check, a 1:1 port of rust/src/update.rs (SPEC 17):
// local `kimi --version` (5 s, then kill) -> docs changelog (Range 0-4095)
// -> GitHub Releases API fallback. Every failure degrades silently.

const CHANGELOG_URL = "https://moonshotai.github.io/kimi-code/en/release-notes/changelog.md";
const GITHUB_LATEST_URL = "https://api.github.com/repos/MoonshotAI/kimi-code/releases/latest";
const HTTP_TIMEOUT_MS = 10_000;
const VERSION_TIMEOUT_MS = 5_000;

export interface UpdateStatus {
  localVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  checkFailed: boolean;
}

export const emptyUpdateStatus = (): UpdateStatus => ({
  localVersion: null,
  latestVersion: null,
  updateAvailable: false,
  checkFailed: false,
});

/** `x.y.z` as a comparable triple; anything else (a 4th component is ignored,
 *  a prerelease suffix is not) yields nothing. u64 bounds, so bigint parts. */
export function parseSemver(value: string): [bigint, bigint, bigint] | null {
  const parts = value.split(".");
  if (parts.length < 3) return null;
  const parsed: bigint[] = [];
  for (const part of parts.slice(0, 3)) {
    if (!/^\d+$/.test(part)) return null;
    const number = BigInt(part);
    if (number > 18446744073709551615n) return null;
    parsed.push(number);
  }
  return [parsed[0]!, parsed[1]!, parsed[2]!];
}

const greaterThan = (a: [bigint, bigint, bigint], b: [bigint, bigint, bigint]): boolean => {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return (a[i] ?? 0n) > (b[i] ?? 0n);
  }
  return false;
};

const VERSION_RE = /\d+\.\d+\.\d+/;
const CHANGELOG_HEADING_RE = /^## (\d+\.\d+\.\d+)/mu;
const TAG_RE = /\d+\.\d+\.\d+/;

export interface UpdateDeps {
  fetchImpl?: typeof fetch;
  spawnVersion?: () => Promise<{ code: number | null; output: string }>;
  timeoutMs?: number;
}

/** `kimi --version` without a shell; stdout and stderr are concatenated in
 *  that order and decoded lossily, then the first x.y.z wins (SPEC 17.1). */
export async function detectLocalVersion(
  spawn: UpdateDeps["spawnVersion"] = spawnKimiVersion,
): Promise<string | null> {
  try {
    const result = await spawn();
    const match = VERSION_RE.exec(result.output);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

async function spawnKimiVersion(): Promise<{ code: number | null; output: string }> {
  const proc = Bun.spawn({
    cmd: ["kimi", "--version"],
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      proc.kill();
      reject(new Error("kimi --version timed out"));
    }, VERSION_TIMEOUT_MS);
  });
  try {
    const [code, out, err] = await Promise.race([
      Promise.all([
        proc.exited,
        new Response(proc.stdout).arrayBuffer(),
        new Response(proc.stderr).arrayBuffer(),
      ]),
      guard,
    ]);
    const lossy = (bytes: ArrayBuffer): string =>
      new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    return { code, output: lossy(out) + lossy(err) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Changelog first: the Range header keeps the body at 4 KiB, and
 *  `Accept-Encoding: identity` is required because Bun cannot inflate a gzipped
 *  206 partial response (SPEC §22.4). */
export async function fetchLatestFromChangelog(doFetch: typeof fetch): Promise<string | null> {
  try {
    const response = await doFetch(CHANGELOG_URL, {
      method: "GET",
      headers: { Range: "bytes=0-4095", "Accept-Encoding": "identity" },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const text = await response.text();
    const match = CHANGELOG_HEADING_RE.exec(text);
    return match ? (match[1] ?? null) : null;
  } catch {
    return null;
  }
}

/** GitHub Releases API fallback; the User-Agent header is mandatory. */
export async function fetchLatestFromGithub(doFetch: typeof fetch): Promise<string | null> {
  try {
    const response = await doFetch(GITHUB_LATEST_URL, {
      method: "GET",
      headers: { "User-Agent": "KimiPlanbarTui" },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return null;
    }
    const tag = (body as { tag_name?: unknown } | null)?.tag_name;
    if (typeof tag !== "string") return null;
    const match = TAG_RE.exec(tag);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

export async function checkUpdate(deps: UpdateDeps = {}): Promise<UpdateStatus> {
  const doFetch = deps.fetchImpl ?? fetch;
  const local = await detectLocalVersion(deps.spawnVersion);
  const latest =
    (await fetchLatestFromChangelog(doFetch)) ?? (await fetchLatestFromGithub(doFetch));
  const updateAvailable =
    latest !== null && local !== null
      ? (() => {
          const l = parseSemver(latest);
          const c = parseSemver(local);
          return l !== null && c !== null && greaterThan(l, c);
        })()
      : false;
  return {
    localVersion: local,
    latestVersion: latest,
    updateAvailable,
    checkFailed: latest === null,
  };
}

/** `--test-update` prints .NET-style booleans so the two editions diff (SPEC 19). */
export const dotnetBool = (value: boolean): string => (value ? "True" : "False");
