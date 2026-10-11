import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => await import('./fake-electron'));

import { profileRuntimeSettingsChanged, settingsAffectHostServices } from '../src/main/manager';

describe('profileRuntimeSettingsChanged', () => {
  it('keeps launcher-only sidebar navigation changes out of profile browser windows', () => {
    expect(profileRuntimeSettingsChanged({ ui: { navHidden: ['settings'] } })).toBe(false);
    expect(profileRuntimeSettingsChanged({ ui: { navOrder: ['profiles', 'settings'] } })).toBe(false);
    expect(profileRuntimeSettingsChanged({ ui: { theme: 'octo-violet', showStartupSplash: false } })).toBe(false);
  });

  it('continues to refresh a profile when its browser-facing settings change', () => {
    expect(profileRuntimeSettingsChanged({ ui: { verticalTabs: true } })).toBe(true);
    expect(profileRuntimeSettingsChanged({ ui: { confirmOnQuit: false } })).toBe(true);
    expect(profileRuntimeSettingsChanged({ network: { searchEngine: 'startpage' } })).toBe(true);
    expect(profileRuntimeSettingsChanged({ offlineMode: 'strict' })).toBe(true);
  });

  it('does not reconfigure process-wide host services for sidebar-only changes', () => {
    expect(settingsAffectHostServices({ ui: { navHidden: ['logs'] } })).toBe(false);
    expect(settingsAffectHostServices({ ui: { navOrder: ['profiles', 'settings'] } })).toBe(false);
    expect(settingsAffectHostServices({ ui: { theme: 'octo-violet' } })).toBe(false);
    expect(settingsAffectHostServices({ network: { searchEngine: 'startpage' } })).toBe(true);
    expect(settingsAffectHostServices({ offlineMode: 'practical' })).toBe(true);
  });
});
