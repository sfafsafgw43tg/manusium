import { describe, expect, it } from 'vitest';
import { ephemeralPartition, profilePartition } from '../src/profile-partition';

describe('profile session partitions', () => {
  it('creates a fresh non-persistent partition for every ephemeral launch', () => {
    const a = ephemeralPartition();
    const b = ephemeralPartition();
    expect(a).toMatch(/^octo-ephemeral-[0-9a-f-]{36}$/);
    expect(a).not.toContain('persist:');
    expect(a).not.toBe(b);
  });
  it('keeps persistent partitions explicit and profile-scoped', () => {
    expect(profilePartition('abc')).toBe('persist:octo-profile-abc');
  });
});
