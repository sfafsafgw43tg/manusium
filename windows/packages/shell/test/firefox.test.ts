import { describe, expect, it } from 'vitest';
import { firefoxAvailability } from '../src/winutil';

describe('Firefox discovery', () => {
  it('does not execute or accept relative configured paths', () => {
    const result = firefoxAvailability('relative/firefox');
    expect(result.available).toBe(false);
    expect(result.path).toBeNull();
    expect(result.reason).toBe('invalid-path');
  });
});
