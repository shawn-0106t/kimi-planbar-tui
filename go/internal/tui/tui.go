// Package tui is the bubbletea v2 render layer of the Go edition
// (dashboard / settings / skills views, key routing, sanitize). It is the
// only package allowed to import bubbletea and lipgloss; the core package
// stays UI-agnostic (PLAN-GO §3).
//
// View layouts are translated line-for-line from rust/src/ui/*.rs; row
// clipping and width rules follow SPEC 21.3 (East Asian Width), and every
// external string passes sanitize() before entering a frame (SPEC 22.5).
package tui
