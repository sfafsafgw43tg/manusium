import { describe, expect, it } from 'vitest';
import { generatePassword, passwordStrength, randomIndex } from '../src/shared/password-tools';

describe('generatePassword', () => {
  it('defaults to 20 characters that mix all four classes', () => {
    for (let i = 0; i < 200; i++) {
      const pw = generatePassword();
      expect(pw).toHaveLength(20);
      expect(pw).toMatch(/[a-z]/);
      expect(pw).toMatch(/[A-Z]/);
      expect(pw).toMatch(/[0-9]/);
      expect(pw).toMatch(/[!@#$%^&*()\-_=+[\]{};:,.?]/);
    }
  });

  it('leaves symbols out when asked, and still guarantees the other classes', () => {
    for (let i = 0; i < 200; i++) {
      const pw = generatePassword({ length: 12, symbols: false });
      expect(pw).toHaveLength(12);
      expect(pw).toMatch(/^[A-Za-z0-9]+$/);
      expect(pw).toMatch(/[a-z]/);
      expect(pw).toMatch(/[A-Z]/);
      expect(pw).toMatch(/[0-9]/);
    }
  });

  it('clamps the length to 8..128', () => {
    expect(generatePassword({ length: 1 })).toHaveLength(8);
    expect(generatePassword({ length: 500 })).toHaveLength(128);
    expect(generatePassword({ length: 33.9 })).toHaveLength(33);
    expect(generatePassword({ length: Number.NaN })).toHaveLength(20);
  });

  it('does not repeat across many samples', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) seen.add(generatePassword());
    expect(seen.size).toBe(2000);
  });
});

describe('randomIndex', () => {
  it('draws again when a value falls at or above the unbiased limit', () => {
    // n = 2147483649: floor(2^32 / n) * n = n, so every draw >= n must be rejected.
    const n = 2147483649;
    const draws = [2147483649, 0xffffffff, 7];
    const fill = (buf: Uint32Array) => {
      buf[0] = draws.shift() ?? 0;
      return buf;
    };
    expect(randomIndex(n, fill)).toBe(7);
    expect(draws).toHaveLength(0);
  });

  it('rejects invalid ranges', () => {
    expect(() => randomIndex(0)).toThrow(RangeError);
    expect(() => randomIndex(1.5)).toThrow(RangeError);
  });
});

describe('passwordStrength', () => {
  it('rates short and well-known passwords as weak', () => {
    expect(passwordStrength('').level).toBe(0);
    expect(passwordStrength('Ab1!xyz').level).toBe(0);
    expect(passwordStrength('password').level).toBe(0);
    expect(passwordStrength('Password1').level).toBe(0);
    expect(passwordStrength('aaaaaaaaaaaa').level).toBe(0);
    expect(passwordStrength('abcdefghijkl').level).toBe(0);
  });

  it('rates long, mixed passwords as strong', () => {
    expect(passwordStrength('Tr0ub4dor&3-sample').level).toBe(3);
    expect(passwordStrength(generatePassword()).level).toBe(3);
  });

  it('grades in between by length and variety', () => {
    expect(passwordStrength('abcdefgh1').level).toBeLessThanOrEqual(1);
    expect(passwordStrength('Kq7vnRt2wzLp').level).toBe(2);
  });

  it('never returns a score outside 0..100', () => {
    for (const sample of ['', 'a', 'A1!', 'x'.repeat(200), 'Zq8#Lm2!Vx9@Pk4$Rt6%Wy1^']) {
      const { score } = passwordStrength(sample);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    }
  });
});
