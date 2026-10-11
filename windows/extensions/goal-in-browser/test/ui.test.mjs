import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRESET_TEXT, summaryText } from '../dist/ui.js';
import { PRESET_IDS } from '../dist/settings.js';

test('every preset has a description', () => {
  for (const id of PRESET_IDS) assert.equal(typeof PRESET_TEXT[id], 'string');
  assert.match(PRESET_TEXT.strict, /access to all sites/i, 'the strict description says it needs site access');
});

test('the summary counts on, off, and items that need attention', () => {
  const items = [
    { id: 'a', label: 'A', state: 'on', detail: '' },
    { id: 'b', label: 'B', state: 'off', detail: '' },
    { id: 'c', label: 'C', state: 'error', detail: '' },
    { id: 'd', label: 'D', state: 'skipped', detail: '' },
    { id: 'e', label: 'E', state: 'partial', detail: '' },
    { id: 'f', label: 'F', state: 'on', detail: '' },
  ];
  assert.equal(summaryText(items), '2 on, 1 off, 3 need attention');
  assert.equal(summaryText(items.slice(0, 2)), '1 on, 1 off');
});
