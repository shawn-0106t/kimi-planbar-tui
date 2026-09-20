// Headless answer to the question the real-terminal round raised: when the
// Ctrl+C byte (0x03) goes through OpenTUI's key parser, does the app's adapter
// see { name: "c", ctrl: true } — which is what src/tui/app.ts quits on?
//
//   cd ts && bun run scripts/verify/parse-ctrlc.ts
//
// Uses the test renderer's mock input, which emits the same legacy byte
// sequences a non-kitty terminal sends, so a null here is a parser gap and not a
// console-mode artifact.
import { createTestRenderer } from "@opentui/core/testing";
import { wrapCliRenderer } from "../../src/tui/renderer.ts";

const setup = await createTestRenderer({ width: 40, height: 6 });
const adapter = wrapCliRenderer(setup.renderer);
const got: Record<string, unknown>[] = [];
adapter.onKey((k) => got.push({ ...k }));

const cases: [string, () => void][] = [
  ["q (control: plain key)", () => setup.mockInput.pressKey("q")],
  ["ctrl+c", () => setup.mockInput.pressKey("c", { ctrl: true })],
  ["ctrl+s", () => setup.mockInput.pressKey("s", { ctrl: true })],
];

for (const [label, fire] of cases) {
  got.length = 0;
  fire();
  await new Promise((r) => setTimeout(r, 60));
  console.log(
    `${label} -> ${got.length === 0 ? "NOTHING (parser emitted no keypress)" : JSON.stringify(got[0])}`,
  );
}
adapter.destroy();
process.exit(0);
