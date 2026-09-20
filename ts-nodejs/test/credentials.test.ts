import { afterEach, beforeEach, describe, expect, test } from "./bun-shim.ts";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  homeDir,
  kimiHome,
  loadToken,
  loadTokenFrom,
  readTextStrict,
  tokenFromConfigToml,
} from "../src/core/credentials.ts";

const NOW = 1_800_000_000; // epoch seconds, fixed
let dir = "";

const writeCredential = (body: string): void => {
  mkdirSync(join(dir, "credentials"), { recursive: true });
  writeFileSync(join(dir, "credentials", "kimi-code.json"), body, "utf8");
};
const writeConfig = (body: string): void => {
  writeFileSync(join(dir, "config.toml"), body, "utf8");
};

beforeEach(() => {
  dir = join(process.env["TMP"] ?? process.env["TEMP"] ?? ".", `kpt-cred-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("home dir chain (SPEC 16.2)", () => {
  test("USERPROFILE wins when non-empty", () => {
    expect(homeDir({ USERPROFILE: "C:/u", HOMEDRIVE: "C:", HOMEPATH: "/w" })).toBe("C:/u");
  });
  test("an empty USERPROFILE falls through to HOMEDRIVE+HOMEPATH", () => {
    expect(homeDir({ USERPROFILE: "", HOMEDRIVE: "C:", HOMEPATH: "/Users/x" })).toBe("C:/Users/x");
  });
  test("neither set yields nothing", () => {
    expect(homeDir({})).toBeNull();
  });
  test("KIMI_CODE_HOME overrides, but only when non-empty", () => {
    expect(kimiHome("C:/u", { KIMI_CODE_HOME: "D:/kc" })).toBe("D:/kc");
    expect(kimiHome("C:/u", { KIMI_CODE_HOME: "" })).toBe(join("C:/u", ".kimi-code"));
    expect(kimiHome("C:/u", {})).toBe(join("C:/u", ".kimi-code"));
  });
});

describe("credentials json (SPEC 16.2 step 1)", () => {
  test("a live token is returned", () => {
    writeCredential(`{"access_token":"tok","expires_at":${NOW + 3600}}`);
    expect(loadTokenFrom(dir, NOW)).toBe("tok");
  });

  test("the expiry needs 30 seconds of headroom", () => {
    writeCredential(`{"access_token":"tok","expires_at":${NOW + 30}}`);
    expect(loadTokenFrom(dir, NOW)).toBeNull(); // not > now+30
    writeCredential(`{"access_token":"tok","expires_at":${NOW + 31}}`);
    expect(loadTokenFrom(dir, NOW)).toBe("tok");
  });

  test("expires_at may be a string, and junk or a missing one reads as expired", () => {
    writeCredential(`{"access_token":"tok","expires_at":"${NOW + 3600}"}`);
    expect(loadTokenFrom(dir, NOW)).toBe("tok");
    for (const body of [
      `{"access_token":"tok"}`,
      `{"access_token":"tok","expires_at":null}`,
      `{"access_token":"tok","expires_at":"soon"}`,
    ]) {
      writeCredential(body);
      expect(loadTokenFrom(dir, NOW)).toBeNull();
    }
  });

  test("a non-string access_token is ignored, an empty one is not", () => {
    writeCredential(`{"access_token":42,"expires_at":${NOW + 3600}}`);
    expect(loadTokenFrom(dir, NOW)).toBeNull();
    writeCredential(`{"access_token":"","expires_at":${NOW + 3600}}`);
    expect(loadTokenFrom(dir, NOW)).toBe("");
  });

  test("broken json is swallowed", () => {
    writeCredential("{ not json");
    expect(loadTokenFrom(dir, NOW)).toBeNull();
  });
});

describe("config.toml fallback (SPEC 16.2 step 2)", () => {
  const provider = (name: string, baseUrl: string, key: string): string =>
    `[providers.${name}]\nbase_url = "${baseUrl}"\napi_key = "${key}"\n`;

  test("a matching provider answers", () => {
    expect(tokenFromConfigToml(provider("kimi", "https://api.kimi.com/coding/v1", "kk")))
      .toBe("kk");
  });

  test("section name, base_url and a non-empty key are all required", () => {
    // A kimi-shaped base_url under a non-provider section (as on a real machine)
    // must not match, unlike a provider section whose key is empty.
    expect(
      tokenFromConfigToml(
        '[services.moonshot_search]\nbase_url = "https://api.kimi.com/coding/v1/search"\napi_key = "kk"\n',
      ),
    ).toBeNull();
    expect(tokenFromConfigToml(provider("kimi", "https://example.com/v1", "kk"))).toBeNull();
    expect(tokenFromConfigToml(provider("kimi", "https://api.kimi.com/coding/v1", ""))).toBeNull();
  });

  test("the first match wins, later sections are not scanned", () => {
    const text = provider("a", "https://api.kimi.com/coding", "first") +
      provider("b", "https://api.kimi.com/coding", "second");
    expect(tokenFromConfigToml(text)).toBe("first");
  });

  test("a section is settled when the next one opens, and again at EOF", () => {
    const twoProviders =
      "# comment\n" +
      provider("deep", "https://api.deepseek.com", "d-key") +
      "\n" +
      provider("kimi", "https://api.kimi.com/coding/v1", "k-key");
    expect(tokenFromConfigToml(twoProviders)).toBe("k-key");
    // the deepseek section settled (and missed) before kimi opened
    const kimiFirst = twoProviders.replace("api.deepseek.com", "api.kimi.com/coding/x");
    expect(tokenFromConfigToml(kimiFirst)).toBe("d-key");
  });

  test("quoted subsection names keep their brackets stripped", () => {
    const text = '[providers."managed:kimi-code"]\nbase_url = "https://api.kimi.com/coding/v1"\napi_key = "mk"\n';
    expect(tokenFromConfigToml(text)).toBe("mk");
    const arrayTable = '[[providers.kimi]]\nbase_url="https://api.kimi.com/coding"\napi_key = "at"\n';
    expect(tokenFromConfigToml(arrayTable)).toBe("at");
  });

  test("within a section the last base_url and api_key win", () => {
    const text =
      '[providers.k]\nbase_url = "https://nope.example"\nbase_url = "https://api.kimi.com/coding"\napi_key = "one"\napi_key = "two"\n';
    expect(tokenFromConfigToml(text)).toBe("two");
  });

  test("keys before any section never match, and single-quoted values are skipped", () => {
    expect(tokenFromConfigToml('base_url = "https://api.kimi.com/coding"\napi_key = "x"\n')).toBeNull();
    expect(tokenFromConfigToml('[providers.k]\nbase_url = \'https://api.kimi.com/coding\'\napi_key = "x"\n')).toBeNull();
  });

  test("the fallback only runs when the credential store cannot answer", () => {
    writeCredential(`{"access_token":"tok","expires_at":1}`); // expired
    writeConfig(provider("kimi", "https://api.kimi.com/coding/v1", "fallback"));
    expect(loadTokenFrom(dir, NOW)).toBe("fallback");
  });

  test("no credential file and no config.toml yields nothing", () => {
    expect(loadTokenFrom(dir, NOW)).toBeNull();
  });

  test("the real machine chain is reachable through loadToken", () => {
    // Not an assertion about the user's data: whatever comes back must be a
    // string or null, and it must not throw.
    const token = loadToken(process.env, NOW);
    expect(token === null || typeof token === "string").toBe(true);
  });
});

describe("readTextStrict (fs::read_to_string parity)", () => {
  test("invalid UTF-8 is a read failure, not mojibake", () => {
    const path = join(dir, "bad.toml");
    writeFileSync(path, Uint8Array.from([0xff, 0xfe, 0x41]));
    expect(readTextStrict(path)).toBeNull();
    writeFileSync(join(dir, "ok.toml"), "plain", "utf8");
    expect(readTextStrict(join(dir, "ok.toml"))).toBe("plain");
    expect(readTextStrict(join(dir, "missing.toml"))).toBeNull();
  });
});
