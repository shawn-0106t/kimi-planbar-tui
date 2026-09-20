// Theme support: system detection + the Moonlit/Moondark palettes, a 1:1 port
// of rust/src/theme.rs. SPEC 11.1 lists ten brushes; the wireframe UI draws no
// card backgrounds, so the palette carries the nine that are actually used
// (card_bg stays spec-only, matching the Rust struct).

import { spawnSync } from "node:child_process";

/** SPEC 11.1, as terminal truecolor hex strings. */
export interface Palette {
  accent: string;
  windowBg: string;
  textPrimary: string;
  textSecondary: string;
  progressTrack: string;
  buttonBg: string;
  buttonHover: string;
  badgeBg: string;
  badgeFg: string;
}

export const MOONLIT: Palette = {
  accent: "#1A88FF",
  windowBg: "#F3F4F6",
  textPrimary: "#1F2329",
  textSecondary: "#6B7280",
  progressTrack: "#E5E7EB",
  buttonBg: "#E9ECF0",
  buttonHover: "#DCE2E9",
  badgeBg: "#FFF0E0",
  badgeFg: "#E06D00",
};

export const MOONDARK: Palette = {
  accent: "#1A88FF",
  windowBg: "#17191E",
  textPrimary: "#F2F3F5",
  textSecondary: "#9AA0A8",
  progressTrack: "#3A3E47",
  buttonBg: "#2C3039",
  buttonHover: "#3A404B",
  badgeBg: "#3D2E1A",
  badgeFg: "#F0A040",
};

/** `palette(effective)`: only the literal "dark" selects Moondark. */
export function palette(effectiveTheme: string): Palette {
  return effectiveTheme === "dark" ? MOONDARK : MOONLIT;
}

/** `effective(configured)`: an unknown value means "follow the OS", exactly
 *  like the Rust catch-all arm. The OS answer is injected as a thunk so a
 *  pinned light/dark theme never spawns the registry probe. */
export function effectiveTheme(
  configured: string,
  system: () => "light" | "dark",
): "light" | "dark" {
  if (configured === "light") return "light";
  if (configured === "dark") return "dark";
  return system();
}

const PERSONALIZE_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize";

/** `AppsUseLightTheme` as printed by reg.exe: 0 is dark, anything else light,
 *  and a missing or unreadable value defaults to light (the Rust `unwrap_or(1)`). */
export function parseLightThemeDword(queryOutput: string | null): "light" | "dark" {
  if (queryOutput === null) return "light";
  for (const line of queryOutput.split(/\r?\n/)) {
    if (!line.includes("AppsUseLightTheme")) continue;
    const cell = line.split(/\s+/).find((token, i) => i > 0 && /^(0x[0-9a-f]+|\d+)$/i.test(token));
    if (cell === undefined) return "light";
    const value = /^0x/i.test(cell) ? Number.parseInt(cell.slice(2), 16) : Number.parseInt(cell, 10);
    return Number.isNaN(value) ? "light" : value === 0 ? "dark" : "light";
  }
  return "light";
}

/** Registry reads go through reg.exe because the TS edition has no winreg.
 *  Chinese Windows prints GBK, which is why the bytes are decoded explicitly.
 *  Synchronous, like the Rust winreg call it replaces; the output is a couple
 *  of lines so there is no pipe-buffer to worry about. */
export function readSystemTheme(): "light" | "dark" {
  try {
    const proc = spawnSync(
      "reg.exe",
      ["query", PERSONALIZE_KEY, "/v", "AppsUseLightTheme"],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    if (proc.status !== 0) return "light";
    return parseLightThemeDword(new TextDecoder("gbk").decode(proc.stdout));
  } catch {
    return "light";
  }
}

/** The cached answer the 30 s poll in the event loop refreshes (SPEC 20), so a
 *  frame never has to read the registry. */
let cachedSystemTheme: "light" | "dark" | null = null;

export function systemThemeSync(): "light" | "dark" {
  if (cachedSystemTheme === null) cachedSystemTheme = readSystemTheme();
  return cachedSystemTheme;
}

export function refreshSystemThemeCache(): "light" | "dark" {
  cachedSystemTheme = readSystemTheme();
  return cachedSystemTheme;
}
