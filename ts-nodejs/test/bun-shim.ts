// Minimal bun:test facade over node:test + node:assert/strict, so the test
// bodies ported from the Bun edition stay byte-identical. Only the API
// surface this suite actually uses is implemented; anything else fails at
// call time instead of silently misbehaving.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

export { afterEach, beforeEach, describe, test };

type Thunk = () => unknown;
type ErrorCtor = new (...args: never[]) => Error;

interface Expectation {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toBeNull(): void;
  toBeDefined(): void;
  toBeUndefined(): void;
  toBeGreaterThan(expected: number | bigint): void;
  toContain(expected: unknown): void;
  toMatch(expected: RegExp): void;
  toHaveLength(expected: number): void;
  toThrow(expected?: string | RegExp | ErrorCtor): void;
  not: Expectation;
}

function makeExpectation(actual: unknown, negated: boolean): Expectation {
  // `ok(pass)` asserts the positive or the negative form, depending on polarity.
  const ok = (pass: boolean, message: string): void => {
    if (negated ? pass : !pass) assert.fail(message);
  };
  // `not` is attached below via a lazy getter so the two polarities can
  // reference each other; the cast covers exactly that missing property.
  const self = {
    toBe: (expected: unknown) =>
      negated ? assert.notStrictEqual(actual, expected) : assert.strictEqual(actual, expected),
    toEqual: (expected: unknown) =>
      negated
        ? assert.notDeepStrictEqual(actual, expected)
        : assert.deepStrictEqual(actual, expected),
    toBeNull: () => self.toBe(null),
    toBeDefined: () => ok(actual !== undefined, "expected value not to be defined"),
    toBeUndefined: () => self.toBe(undefined),
    toBeGreaterThan: (expected: number | bigint) =>
      ok(
        (actual as number) > (expected as number),
        `expected ${String(actual)} not to be greater than ${String(expected)}`,
      ),
    toContain: (expected: unknown) =>
      ok(
        typeof actual === "string" && typeof expected === "string"
          ? actual.includes(expected)
          : Array.isArray(actual) && actual.some((item) => Object.is(item, expected)),
        `expected ${String(actual)} not to contain ${String(expected)}`,
      ),
    toMatch: (expected: RegExp) =>
      ok(
        typeof actual === "string" && expected.test(actual),
        `expected ${String(actual)} not to match ${String(expected)}`,
      ),
    toHaveLength: (expected: number) =>
      negated
        ? assert.notStrictEqual((actual as { length: number }).length, expected)
        : assert.strictEqual((actual as { length: number }).length, expected),
    toThrow: (expected?: string | RegExp | ErrorCtor) => {
      const fn = actual as Thunk;
      if (negated) {
        assert.doesNotThrow(fn);
      } else if (expected === undefined) {
        assert.throws(fn);
      } else if (typeof expected === "string") {
        assert.throws(
          fn,
          (err: unknown) => err instanceof Error && err.message.includes(expected),
        );
      } else if (expected instanceof RegExp) {
        assert.throws(fn, expected);
      } else {
        assert.throws(fn, expected);
      }
    },
  };
  // Lazy so the two polarities can reference each other without recursing.
  Object.defineProperty(self, "not", {
    get: () => makeExpectation(actual, !negated),
    enumerable: false,
  });
  return self as Expectation;
}

export function expect(actual: unknown): Expectation {
  return makeExpectation(actual, false);
}
