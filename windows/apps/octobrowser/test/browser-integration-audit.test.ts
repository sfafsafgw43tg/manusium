import { describe, expect, it } from 'vitest';
import { defaultProfile } from '@octo/core';
import { profilePartition } from '@octo/shell/profile-partition';

describe('native Chromium identity runtime', () => {
  it('keeps profile storage partitions isolated', () => {
    const p1 = defaultProfile('personal', 'Personal');
    const p2 = defaultProfile('work', 'Work');
    expect(profilePartition(p1.id)).not.toBe(profilePartition(p2.id));
    expect(profilePartition(p1.id)).toMatch(/^persist:octo-profile-/);
  });
});
