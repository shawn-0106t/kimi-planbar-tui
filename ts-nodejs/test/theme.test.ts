import { describe, expect, test } from "./bun-shim.ts";
import {
  MOONDARK,
  MOONLIT,
  effectiveTheme,
  parseLightThemeDword,
  systemThemeSync,
} from "../src/core/theme.ts";

describe("palette (SPEC 11.1)", () => {
  test("nine slots, both themes complete", () => {
    for (const palette of [MOONLIT, MOONDARK]) {
      expect(Object.keys(palette)).toHaveLength(9);
      for (const value of Object.values(palette)) expect(value).toMatch(/^#[0-9A-F]{6}$/);
    }
    expect(Object.keys(MOONLIT)).toEqual(Object.keys(MOONDARK));
  });

  test("the accent is identical in both themes and the rest are not", () => {
    expect(MOONLIT.accent).toBe("#1A88FF");
    expect(MOONDARK.accent).toBe("#1A88FF");
    expect(MOONLIT.windowBg).toBe("#F3F4F6");
    expect(MOONDARK.windowBg).toBe("#17191E");
    expect(MOONLIT.textPrimary).toBe("#1F2329");
    expect(MOONDARK.textPrimary).toBe("#F2F3F5");
    expect(MOONLIT.progressTrack).toBe("#E5E7EB");
    expect(MOONDARK.progressTrack).toBe("#3A3E47");
    expect(MOONLIT.badgeFg).toBe("#E06D00");
    expect(MOONDARK.badgeFg).toBe("#F0A040");
  });

  test("the spec-only card_bg is not part of the palette", () => {
    expect("cardBg" in MOONLIT).toBe(false);
  });
});

describe("effective theme (SPEC 11.1, 20)", () => {
  test("only the literal light/dark pin the theme; anything else follows the OS", () => {
    expect(effectiveTheme("light", () => "dark")).toBe("light");
    expect(effectiveTheme("dark", () => "light")).toBe("dark");
    expect(effectiveTheme("system", () => "dark")).toBe("dark");
    expect(effectiveTheme("garbage", () => "light")).toBe("light");
    expect(effectiveTheme("", () => "dark")).toBe("dark");
  });

  test("the OS probe is lazy: a pinned theme never calls it", () => {
    let probed = false;
    const probe = (): "light" | "dark" => {
      probed = true;
      return "dark";
    };
    expect(effectiveTheme("light", probe)).toBe("light");
    expect(effectiveTheme("dark", probe)).toBe("dark");
    expect(probed).toBe(false);
    expect(effectiveTheme("system", probe)).toBe("dark");
    expect(probed).toBe(true);
  });
});

describe("AppsUseLightTheme parsing (SPEC 20)", () => {
  const line = (value: string): string =>
    `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize\r\n    AppsUseLightTheme    REG_DWORD    ${value}\r\n\r\n`;

  test("0 is dark, 1 and anything else is light", () => {
    expect(parseLightThemeDword(line("0x0"))).toBe("dark");
    expect(parseLightThemeDword(line("0x1"))).toBe("light");
    expect(parseLightThemeDword(line("0x2"))).toBe("light");
    expect(parseLightThemeDword(line("0"))).toBe("dark");
    expect(parseLightThemeDword(line("1"))).toBe("light");
  });

  test("missing or unreadable falls back to light, like unwrap_or(1)", () => {
    expect(parseLightThemeDword(null)).toBe("light");
    expect(parseLightThemeDword("")).toBe("light");
    expect(parseLightThemeDword("ERROR: the system cannot find the file specified.")).toBe("light");
    expect(parseLightThemeDword("AppsUseLightTheme    REG_SZ    yes")).toBe("light");
  });

  test("the cached reader answers without throwing", () => {
    expect(["light", "dark"]).toContain(systemThemeSync());
  });
});
