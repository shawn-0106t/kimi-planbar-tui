// Shared application state, the TS counterpart of rust/src/state.rs. JS is
// single-threaded, so the Rust locks simply disappear; the field set and the
// ownership choices (notably the manual-refresh stamp living here, not on the
// UI object) are kept identical.

import type { QuotaResult } from "./quota.ts";
import type { SettingsData } from "./settings.ts";
import type { SkillInfo } from "./skills.ts";
import type { UpdateStatus } from "./update.ts";
import { emptyUpdateStatus } from "./update.ts";

export interface AppState {
  settings: SettingsData;
  /** last-good quota for the keep-last-good fill (SPEC 16.5 step 2) */
  lastQuota: QuotaResult | null;
  update: UpdateStatus;
  /** "light" | "dark" after resolving "system" */
  effectiveTheme: "light" | "dark";
  /** ms timestamp of the last manual refresh, for the 2 s debounce (SPEC 12.7) */
  lastManualRefreshMs: number | null;
  /** one-shot lazy cache for the skills view (SPEC 21.2) */
  skillsCache: SkillInfo[] | null;
}

export function createAppState(
  settings: SettingsData,
  effectiveTheme: "light" | "dark",
): AppState {
  return {
    settings,
    lastQuota: null,
    update: emptyUpdateStatus(),
    effectiveTheme,
    lastManualRefreshMs: null,
    skillsCache: null,
  };
}
