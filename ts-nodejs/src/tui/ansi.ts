// SGR sequence construction + the injection firewall for external strings
// (SPEC §22.5). The handwritten renderer has no
// widget-level escape immunity, so every external string (skill names, API
// error text) must pass through sanitize() before entering a frame (SPEC 20).

/** Strip ANSI escape sequences (CSI/OSC/ESC+char) first, then any remaining
 *  C0/DEL/C1 controls: anything that could move the cursor or change terminal
 *  state must not reach a frame, and a stripped sequence should not leave its
 *  parameter bytes behind as visible garbage either. */
export function sanitize(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

export const SGR_RESET = "\x1b[0m";

/** "#RRGGBB" (SPEC 11.1 palette format) -> [r, g, b]; anything else -> null. */
export function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex);
  if (m === null) return null;
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
}

export interface SgrStyle {
  fg?: string;
  bg?: string;
  bold?: boolean;
  underline?: boolean;
}

/** Opening SGR sequence for one span: reset first so no style state can leak
 *  from the previous span, then truecolor fg/bg and the attribute flags. */
export function sgrOpen(style: SgrStyle): string {
  let out = SGR_RESET;
  const fg = style.fg !== undefined ? hexToRgb(style.fg) : null;
  if (fg !== null) out += `\x1b[38;2;${fg[0]};${fg[1]};${fg[2]}m`;
  const bg = style.bg !== undefined ? hexToRgb(style.bg) : null;
  if (bg !== null) out += `\x1b[48;2;${bg[0]};${bg[1]};${bg[2]}m`;
  if (style.bold === true) out += "\x1b[1m";
  if (style.underline === true) out += "\x1b[4m";
  return out;
}
