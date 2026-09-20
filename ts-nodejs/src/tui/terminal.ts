// Terminal lifecycle (SPEC §22.5): alternate screen,
// hidden cursor, DECAWM off on entry; full restore on destroy. destroy() is
// idempotent and must be called on EVERY exit path — normal quit, and via the
// process-level handlers in app.ts for exceptions and process exit (SPEC 20).
//
// Windows note: Node enables ENABLE_VIRTUAL_TERMINAL_PROCESSING on a TTY
// stdout and ENABLE_VIRTUAL_TERMINAL_INPUT in raw mode by itself; no Win32
// calls are needed here.

import readline from "node:readline";

/** Normalized keypress, the subset of Node's readline key object we route on. */
export interface KeyPress {
  name: string;
  ctrl: boolean;
  shift: boolean;
  sequence: string;
}

export interface Terminal {
  readonly width: number;
  readonly height: number;
  onKey(callback: (key: KeyPress) => void): void;
  onResize(callback: () => void): void;
  /** Restore the terminal: DECAWM back on, cursor visible, leave the
   *  alternate screen, raw mode off. Safe to call more than once. */
  destroy(): void;
}

/** Entry/exit sequences, exported so callers recovering from a failed
 *  createTerminal() restore the exact same state destroy() would. */
export const TERMINAL_ENTER = "\x1b[?1049h\x1b[?25l\x1b[?7l";
export const TERMINAL_LEAVE = "\x1b[?7h\x1b[?25h\x1b[?1049l";

export function createTerminal(
  stdout: NodeJS.WriteStream = process.stdout,
  stdin: NodeJS.ReadStream = process.stdin,
): Terminal {
  stdout.write(TERMINAL_ENTER);
  // Raw mode only exists on a TTY; the headless self-checks never get here,
  // and a piped stdin simply delivers no keypresses. Declared outside the try
  // so the catch can switch it back off — a failure after raw?.(true) must not
  // leave the console in raw mode (SPEC 20).
  const raw = stdin.isTTY ? stdin.setRawMode.bind(stdin) : null;
  try {
    raw?.(true);
    readline.emitKeypressEvents(stdin);

    let destroyed = false;
    let keyCallback: ((key: KeyPress) => void) | null = null;

    const keyListener = (_str: string, key: Partial<KeyPress> | undefined): void => {
      keyCallback?.({
        name: key?.name ?? "",
        ctrl: key?.ctrl ?? false,
        shift: key?.shift ?? false,
        sequence: key?.sequence ?? "",
      });
    };
    stdin.on("keypress", keyListener);

    return {
      get width(): number {
        return stdout.columns ?? 80;
      },
      get height(): number {
        return stdout.rows ?? 24;
      },
      onKey(callback) {
        keyCallback = callback;
      },
      onResize(callback) {
        stdout.on("resize", callback);
      },
      destroy(): void {
        if (destroyed) return;
        destroyed = true;
        stdin.removeListener("keypress", keyListener);
        // Both restore steps are best-effort: on a broken pipe or a dead
        // console a throw here would mask whatever error brought us down
        // this path (SPEC 20).
        try {
          raw?.(false);
        } catch {
          // nothing left to restore to
        }
        try {
          stdout.write(TERMINAL_LEAVE);
        } catch {
          // the console is gone either way
        }
      },
    };
  } catch (err) {
    // If setup fails after ENTER (e.g. setRawMode throws), the process-level
    // handlers in app.ts never saw a Terminal — restore the console here so
    // it is not stranded in the alternate screen (SPEC 20). Raw mode may
    // already be on at this point, so switch it off too; both restores are
    // best-effort and must not mask the original error.
    try {
      raw?.(false);
    } catch {
      // the original error below is the one that matters
    }
    try {
      stdout.write(TERMINAL_LEAVE);
    } catch {
      // ditto: restore is best-effort, the setup error is the one to throw
    }
    throw err;
  }
}
