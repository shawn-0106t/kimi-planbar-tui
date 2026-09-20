import { describe, expect, test } from "./bun-shim.ts";
import {
  checkUpdate,
  detectLocalVersion,
  dotnetBool,
  fetchLatestFromChangelog,
  fetchLatestFromGithub,
  parseSemver,
} from "../src/core/update.ts";

const stubFetch = (
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: { url: string; init?: RequestInit }[] } => {
  const calls: { url: string; init?: RequestInit }[] = [];
  return {
    calls,
    fetch: (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return handler(String(url), init);
    }) as typeof fetch,
  };
};

describe("parseSemver (SPEC 17.3)", () => {
  test("exactly three numeric components", () => {
    expect(parseSemver("2.0.1")).toEqual([2n, 0n, 1n]);
    expect(parseSemver("01.0.0")).toEqual([1n, 0n, 0n]);
    expect(parseSemver("2.0.1-rc1")).toBeNull();
    expect(parseSemver("2.0")).toBeNull();
    expect(parseSemver("2.0.1.4")).toEqual([2n, 0n, 1n]); // extra parts ignored
    expect(parseSemver("")).toBeNull();
    expect(parseSemver("18446744073709551616.0.0")).toBeNull(); // u64 overflow
  });

  test("comparison is numeric, not lexical", () => {
    expect(parseSemver("1.10.0")![1]).toBeGreaterThan(parseSemver("1.9.9")![1]);
  });
});

describe("changelog primary path (SPEC 17.2)", () => {
  test("the Range request must not be gzipped", async () => {
    const stub = stubFetch(() => new Response("## 2.0.2\n", { status: 200 }));
    expect(await fetchLatestFromChangelog(stub.fetch)).toBe("2.0.2");
    const headers = new Headers(stub.calls[0]!.init?.headers);
    expect(headers.get("Range")).toBe("bytes=0-4095");
    expect(headers.get("Accept-Encoding")).toBe("identity");
  });

  test("the first heading wins, a 200 full body is as good as a 206", async () => {
    const stub = stubFetch(
      () => new Response("# Changelog\n\n## 2.0.3\n\n## 2.0.1\n", { status: 200 }),
    );
    expect(await fetchLatestFromChangelog(stub.fetch)).toBe("2.0.3");
  });

  test("no heading, a non-2xx or a throw all fall through", async () => {
    expect(await fetchLatestFromChangelog(stubFetch(() => new Response("nothing", { status: 200 })).fetch)).toBeNull();
    expect(await fetchLatestFromChangelog(stubFetch(() => new Response("x", { status: 404 })).fetch)).toBeNull();
    expect(
      await fetchLatestFromChangelog(
        stubFetch(() => {
          throw new Error("tls");
        }).fetch,
      ),
    ).toBeNull();
  });
});

describe("GitHub fallback (SPEC 17.2)", () => {
  test("the mandatory User-Agent is sent and the tag is mined", async () => {
    const stub = stubFetch(
      () => new Response(JSON.stringify({ tag_name: "@moonshot-ai/kimi-code@0.31.1" }), { status: 200 }),
    );
    expect(await fetchLatestFromGithub(stub.fetch)).toBe("0.31.1");
    expect(new Headers(stub.calls[0]!.init?.headers).get("User-Agent")).toBe("KimiPlanbarTui");
  });

  test("a missing tag_name or broken json yields nothing", async () => {
    expect(await fetchLatestFromGithub(stubFetch(() => new Response("{}", { status: 200 })).fetch)).toBeNull();
    expect(await fetchLatestFromGithub(stubFetch(() => new Response("<html>", { status: 200 })).fetch)).toBeNull();
  });
});

describe("local version (SPEC 17.1)", () => {
  test("the first x.y.z in stdout+stderr wins", async () => {
    const spawn = async () => ({ code: 0, output: "noise 1.2.3 and 4.5.6\n" });
    expect(await detectLocalVersion(spawn)).toBe("1.2.3");
    expect(await detectLocalVersion(async () => ({ code: 1, output: "no version" }))).toBeNull();
    expect(
      await detectLocalVersion(async () => {
        throw new Error("kimi not found");
      }),
    ).toBeNull();
  });

  test("PATH smoke: kimi --version yields null or an x.y.z triple", async () => {
    const version = await detectLocalVersion();
    expect(version === null || /^\d+\.\d+\.\d+$/.test(version)).toBe(true);
  });
});

describe("checkUpdate composition (SPEC 17.3)", () => {
  test("update_available only when both parse and latest is greater", async () => {
    const changelog = new Response("## 2.1.0\n", { status: 200 });
    const status = await checkUpdate({
      fetchImpl: (async () => changelog) as typeof fetch,
      spawnVersion: async () => ({ code: 0, output: "2.0.9\n" }),
    });
    expect(status).toEqual({
      localVersion: "2.0.9",
      latestVersion: "2.1.0",
      updateAvailable: true,
      checkFailed: false,
    });
  });

  test("the changelog is tried before the GitHub API", async () => {
    const seen: string[] = [];
    const status = await checkUpdate({
      fetchImpl: (async (url: unknown) => {
        seen.push(String(url));
        return String(url).includes("api.github.com")
          ? new Response(JSON.stringify({ tag_name: "v9.9.9" }), { status: 200 })
          : new Response("gone", { status: 500 });
      }) as typeof fetch,
      spawnVersion: async () => ({ code: 0, output: "1.0.0\n" }),
    });
    expect(seen).toHaveLength(2);
    expect(status.latestVersion).toBe("9.9.9");
    expect(status.updateAvailable).toBe(true);
  });

  test("both paths failing sets checkFailed and stays silent otherwise", async () => {
    const status = await checkUpdate({
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as typeof fetch,
      spawnVersion: async () => ({ code: 0, output: "3.0.0\n" }),
    });
    expect(status).toEqual({
      localVersion: "3.0.0",
      latestVersion: null,
      updateAvailable: false,
      checkFailed: true,
    });
  });
});

describe("dotnetBool (SPEC 19)", () => {
  test("True/False capitalization matches the WPF reference output", () => {
    expect(dotnetBool(true)).toBe("True");
    expect(dotnetBool(false)).toBe("False");
  });
});
