/**
 * packages/core/src/archive.ts
 *
 * Minimal directory archive used for encrypted profile exports, backups and
 * the at-rest profile vault. The archive is always encrypted by the caller
 * (see profiles.ts / vault.ts) - it is never written to disk in plain form.
 *
 * Format: "OCTA1\n" | u32 headerLen | header JSON [{p,s}] | file bytes...
 * Extraction refuses absolute paths, "..", and symlinks (zip-slip protection).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureDir, safeJoin } from './fsutil';

const MAGIC = Buffer.from('OCTA1\n', 'ascii');
/** Hard cap to protect memory (cache folders are always excluded). */
export const MAX_ARCHIVE_BYTES = 1536 * 1024 * 1024;

/** Chromium folders that are pure cache and never archived. */
export const CACHE_DIR_NAMES = new Set([
  'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
  'GrShaderCache', 'ShaderCache', 'Service Worker/CacheStorage', 'blob_storage', 'Crashpad',
]);

export function isCachePath(rel: string): boolean {
  const norm = rel.split(path.sep).join('/');
  for (const c of CACHE_DIR_NAMES) {
    if (norm === c || norm.startsWith(`${c}/`) || norm.includes(`/${c}/`) || norm.endsWith(`/${c}`)) return true;
  }
  return false;
}

interface Entry { p: string; s: number }

/** Pack a directory tree into a buffer. `skip` receives paths relative to root. */
export function packDir(root: string, skip: (rel: string) => boolean = isCachePath): Buffer {
  const entries: Entry[] = [];
  const chunks: Buffer[] = [];
  let total = 0;
  const walk = (rel: string) => {
    const abs = rel ? path.join(root, rel) : root;
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(abs).sort()) {
        const childRel = rel ? path.join(rel, name) : name;
        if (skip(childRel)) continue;
        walk(childRel);
      }
      return;
    }
    if (!st.isFile()) return;
    let data: Buffer;
    try {
      data = fs.readFileSync(abs);
    } catch (err) {
      // Locked files (e.g. a running engine) are skipped; callers close the profile first.
      if ((err as NodeJS.ErrnoException).code === 'EBUSY') return;
      throw err;
    }
    total += data.length;
    if (total > MAX_ARCHIVE_BYTES) throw new Error('Profile too large to archive');
    entries.push({ p: rel.split(path.sep).join('/'), s: data.length });
    chunks.push(data);
  };
  if (fs.existsSync(root)) walk('');
  const header = Buffer.from(JSON.stringify(entries), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(header.length, 0);
  return Buffer.concat([MAGIC, len, header, ...chunks]);
}

/** Extract an archive buffer into `dest` (created if missing). */
export function unpackTo(buf: Buffer, dest: string): number {
  if (buf.length < MAGIC.length + 4 || !buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('Invalid archive');
  }
  const hlen = buf.readUInt32BE(MAGIC.length);
  const hstart = MAGIC.length + 4;
  if (hstart + hlen > buf.length) throw new Error('Invalid archive header');
  const entries = JSON.parse(buf.subarray(hstart, hstart + hlen).toString('utf8')) as Entry[];
  if (!Array.isArray(entries)) throw new Error('Invalid archive header');
  let off = hstart + hlen;
  ensureDir(dest);
  for (const e of entries) {
    if (typeof e.p !== 'string' || typeof e.s !== 'number' || e.s < 0 || off + e.s > buf.length) {
      throw new Error('Invalid archive entry');
    }
    if (e.p.includes('\0') || path.isAbsolute(e.p) || /^[a-zA-Z]:/.test(e.p)) throw new Error('Unsafe archive path');
    const target = safeJoin(dest, e.p.split('/').join(path.sep));
    ensureDir(path.dirname(target));
    fs.writeFileSync(target, buf.subarray(off, off + e.s));
    off += e.s;
  }
  return entries.length;
}
