// Shared application state, the Go counterpart of rust/src/state.rs.
//
// Unlike the single-threaded TS edition, the polling timer and every future
// tea.Cmd run on their own goroutines, so the fields are guarded by an
// RWMutex — the same reason the Rust AppState carries RwLock/Mutex
// (state.rs:14-30). Accessors snapshot values under the lock; M3's bubbletea
// Update/View and the Cmd results all go through them.
package core

import "sync"

// AppState is the mutable dashboard state.
type AppState struct {
	mu sync.RWMutex

	settings            SettingsData
	lastQuota           *QuotaResult
	update              UpdateStatus
	effectiveTheme      string // "light" | "dark" after resolving "system"
	lastManualRefreshMs *int64 // 2 s debounce stamp (SPEC 12.7); nil means none
	skillsCache         []SkillInfo
}

// NewAppState mirrors AppState::new.
func NewAppState(settings SettingsData, effectiveTheme string) *AppState {
	return &AppState{
		settings:       settings,
		update:         EmptyUpdateStatus(),
		effectiveTheme: effectiveTheme,
	}
}

// Settings snapshots the persisted settings.
func (s *AppState) Settings() SettingsData {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.settings
}

// SetSettings stores settings after a save (SPEC 18).
func (s *AppState) SetSettings(v SettingsData) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.settings = v
}

// LastQuota returns the last-good quota for the keep-last-good fill
// (SPEC 16.5 step 2).
func (s *AppState) LastQuota() *QuotaResult {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.lastQuota
}

// SetLastQuota stores a fresh fetch result.
func (s *AppState) SetLastQuota(v *QuotaResult) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastQuota = v
}

// Update snapshots the CLI version-check status.
func (s *AppState) Update() UpdateStatus {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.update
}

// SetUpdate stores a fresh update-check result.
func (s *AppState) SetUpdate(v UpdateStatus) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.update = v
}

// EffectiveTheme returns the resolved theme.
func (s *AppState) EffectiveTheme() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.effectiveTheme
}

// SetEffectiveTheme stores the resolved theme.
func (s *AppState) SetEffectiveTheme(v string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.effectiveTheme = v
}

// LastManualRefreshMs returns the debounce stamp, or nil.
func (s *AppState) LastManualRefreshMs() *int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.lastManualRefreshMs
}

// SetLastManualRefreshMs stores the debounce stamp (pass nil to clear).
func (s *AppState) SetLastManualRefreshMs(v *int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastManualRefreshMs = v
}

// SkillsCache returns the one-shot lazy skills cache (SPEC 21.2).
func (s *AppState) SkillsCache() []SkillInfo {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.skillsCache
}

// SetSkillsCache stores the skills scan result.
func (s *AppState) SetSkillsCache(v []SkillInfo) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.skillsCache = v
}
