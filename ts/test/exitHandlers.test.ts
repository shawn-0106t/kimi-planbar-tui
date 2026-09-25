// Exit-path wiring (SPEC 20 / 22.6). Whether Ctrl+C reaches the key router or
// these handlers drifts with the Bun runtime version (swallowed on 2026-09-20,
// delivered on Bun 1.4.2 per the 2026-09-25 re-measurement) — `q` stays the
// quit key for this edition. The handlers remain the teardown for whatever
// raises a signal here, and the guard keeps that path idempotent; a missed
// call would strand the terminal.

import { afterAll, describe, expect, test } from "bun:test";
import { registerExitHandlers } from "../src/tui/app.ts";

const listenersBefore = {
  SIGINT: process.listenerCount("SIGINT"),
  SIGBREAK: process.listenerCount("SIGBREAK"),
};
afterAll(() => {
  expect(process.listenerCount("SIGINT")).toBe(listenersBefore.SIGINT);
  expect(process.listenerCount("SIGBREAK")).toBe(listenersBefore.SIGBREAK);
});

describe("registerExitHandlers (SPEC 20)", () => {
  test("SIGINT and SIGBREAK both destroy then exit with 0", () => {
    for (const signal of ["SIGINT", "SIGBREAK"] as const) {
      const calls: string[] = [];
      const unregister = registerExitHandlers(
        () => void calls.push("destroy"),
        (code) => void calls.push(`exit(${code})`),
      );
      process.emit(signal, signal as never);
      expect(calls).toEqual(["destroy", "exit(0)"]);
      unregister();
    }
  });

  test("a second signal does not destroy or exit twice", () => {
    const calls: string[] = [];
    const unregister = registerExitHandlers(
      () => void calls.push("destroy"),
      () => void calls.push("exit"),
    );
    process.emit("SIGINT", "SIGINT" as never);
    process.emit("SIGBREAK", "SIGBREAK" as never);
    expect(calls).toEqual(["destroy", "exit"]);
    unregister();
  });

  test("unregistering leaves the teardown reachable by the key router only", () => {
    const calls: string[] = [];
    const unregister = registerExitHandlers(
      () => void calls.push("destroy"),
      () => void calls.push("exit"),
    );
    unregister();
    process.emit("SIGINT", "SIGINT" as never);
    expect(calls).toEqual([]);
  });
});
