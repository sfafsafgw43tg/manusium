/** packages/core/test/helpers.ts - shared test utilities. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { KdfParams, OsProtector } from '../src';

/** Fast KDF parameters for tests only (production uses DEFAULT_KDF). */
export const FAST_KDF: KdfParams = { memoryKiB: 8 * 1024, iterations: 1, parallelism: 1 };

/** Temp dir whose name contains spaces and Polish characters (spec §13/§20). */
export function tmpDir(prefix = 'Octo test ząbek żółć'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix} `));
}

/**
 * Fake DPAPI: XOR with a fixed pad (only for tests).
 * `canUnprotect: false` simulates a blob written by another Windows account -
 * protecting still works, unprotecting throws, like the real thing.
 */
export function fakeProtector(available = true, canUnprotect = true): OsProtector {
  const pad = Buffer.from('test-only-not-dpapi-0123456789abcdef');
  const xor = (b: Buffer) => Buffer.from(b.map((v, i) => v ^ pad[i % pad.length]));
  return {
    name: 'fake',
    available: () => available,
    protect: xor,
    unprotect: (b) => { if (!canUnprotect) throw new Error('DPAPI refused the blob'); return xor(b); },
  };
}
