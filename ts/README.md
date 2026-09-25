# kimi-planbar-tui-ts — Bun + OpenTUI edition

This directory holds the TS implementation of Kimi Planbar TUI built on **Bun + OpenTUI**. It was frozen as experimental after v0.1.1 and **unfrozen on 2026-09-25** to land the owned-console startup crash fix and the renderer mouse-tracking fix (see [`../HANDOFF.md`](../HANDOFF.md)); it is a supported alternative again, versioned independently of the Rust edition.

- Supported implementations: this Bun edition plus the Rust edition in [`../rust/`](../rust) (recommended) and the Node edition in [`../ts-nodejs/`](../ts-nodejs)
- User-facing docs: [`../README.md`](../README.md) / [`../README_CN.md`](../README_CN.md)
- This edition's implementation deltas are registered in [`../docs/SPEC.md`](../docs/SPEC.md) chapter 22
