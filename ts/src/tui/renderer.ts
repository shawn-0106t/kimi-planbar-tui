// OpenTUI adapter: turns TuiLine rows into one Text handle per row and keeps
// them in sync in place. All four S0 probe constraints (TS-EDITION-PLAN §2.6)
// are honored here:
//  - text content is treated as write-once; changed rows are destroyed and
//    rebuilt (root.add(child, index) mid-mount verified to insert in order)
//  - no absolute positioning: rows flow top-to-bottom, the footer is just the
//    last row after the blank filler rows (the Min(0) spacer equivalent)
//  - every row arrives pre-padded to the full width by the caller, so the
//    window_bg reaches the right edge
//  - resize is handled by re-rendering at the new size; the test renderer's
//    resize() is not used in tests (it crashes), snapshots run on TuiLine[]

import {
  bg as sBg,
  bold as sBold,
  createCliRenderer,
  fg as sFg,
  StyledText,
  TextRenderable,
  type CliRenderer,
} from "@opentui/core";
import { lineKey, type TuiLine } from "./line.ts";

export interface KeyPress {
  name: string;
  ctrl: boolean;
  shift: boolean;
}

export interface TuiRenderer {
  readonly width: number;
  readonly height: number;
  /** rows must already be padded to `width` and number exactly `height`;
   *  baseBg is the palette's window_bg, applied to every run without its own bg */
  renderRows(rows: TuiLine[], baseBg: string): void;
  requestRender(): void;
  onKey(handler: (key: KeyPress) => void): void;
  onResize(handler: () => void): void;
  destroy(): void;
}

/** Per-span style application order follows the S0 probe's working recipe
 *  (nested helper calls compose fg + bg + bold on one chunk). baseBg is the
 *  row background (window_bg): ratatui paints every cell with the screen bg
 *  and lets spans sit on it, so an unstyled run must NOT fall through to the
 *  terminal default — the live WT check showed black stripes behind text. */
function toStyledText(line: TuiLine, baseBg: string): StyledText {
  const chunks = line.spans
    .filter((s) => s.text !== "")
    .map((s) => {
      let input: any = s.text;
      if (s.fg !== undefined) input = sFg(s.fg)(input);
      input = sBg(s.bg ?? baseBg)(input);
      if (s.bold) input = sBold(input);
      // Unstyled runs must still arrive as TextChunk objects, not raw strings.
      return typeof input === "string" ? { __isChunk: true as const, text: input } : input;
    });
  return new StyledText(chunks);
}

class OpenTuiRenderer implements TuiRenderer {
  private handles: (TextRenderable | null)[] = [];
  private keys: (string | null)[] = [];
  private baseBg: string | null = null;

  constructor(private readonly r: CliRenderer) {}

  get width(): number {
    return this.r.width;
  }

  get height(): number {
    return this.r.height;
  }

  renderRows(rows: TuiLine[], baseBg: string): void {
    const root = this.r.root;
    const bgChanged = this.baseBg !== baseBg;
    this.baseBg = baseBg;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const key = lineKey(row);
      if (!bgChanged && this.keys[i] === key) continue;
      const old = this.handles[i];
      if (old !== undefined && old !== null) {
        root.remove(old);
        old.destroy();
      }
      const child = new TextRenderable(this.r, {
        content: toStyledText(row, baseBg),
        height: 1,
        wrapMode: "none",
      } as any);
      root.add(child, i);
      this.handles[i] = child;
      this.keys[i] = key;
    }
    for (let i = rows.length; i < this.handles.length; i++) {
      const stale = this.handles[i];
      if (stale !== undefined && stale !== null) {
        root.remove(stale);
        stale.destroy();
      }
      this.handles[i] = null;
      this.keys[i] = null;
    }
    this.r.requestRender();
  }

  requestRender(): void {
    this.r.requestRender();
  }

  onKey(handler: (key: KeyPress) => void): void {
    // keypress arrives for press/repeat; releases are a separate keyrelease
    // event we deliberately never subscribe to (probe §2.6).
    this.r.keyInput.on("keypress", (k: any) =>
      handler({ name: k.name as string, ctrl: k.ctrl as boolean, shift: k.shift as boolean }),
    );
  }

  onResize(handler: () => void): void {
    this.r.on("resize", handler);
  }

  destroy(): void {
    this.r.destroy();
  }
}

export async function createTuiRenderer(): Promise<TuiRenderer> {
  // exitOnCtrlC off: the app owns every quit path so the terminal is always
  // restored through renderer.destroy() (SPEC 20).
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  return wrapCliRenderer(renderer);
}

/** Exposed for tests: wrap any CliRenderer (including createTestRenderer's). */
export function wrapCliRenderer(renderer: CliRenderer): TuiRenderer {
  return new OpenTuiRenderer(renderer);
}
