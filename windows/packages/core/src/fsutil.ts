/**
 * packages/core/src/fsutil.ts
 *
 * Small, dependency-free filesystem helpers used by every store:
 *  - atomic writes (write temp file + fsync + rename) so a crash never leaves
 *    a half-written config file;
 *  - best-effort secure deletion of temporary/profile files;
 *  - safe path joining that refuses path traversal.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

/** Create a directory (recursively) if it does not exist. */
export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Write a file atomically. The data is first written to a sibling temp file,
 * flushed to disk and then renamed over the destination (rename is atomic on
 * NTFS and POSIX file systems when source and target are on the same volume).
 */
export function atomicWriteFile(file: string, data: string | Uint8Array): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    // Windows can briefly lock the target (antivirus, indexer). Retry once.
    try {
      fs.rmSync(file, { force: true });
      fs.renameSync(tmp, file);
    } catch {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
  }
}

/** Read a UTF-8 file, returning null when it does not exist. */
export function readTextIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Best-effort secure delete of a single file: overwrite with random bytes,
 * flush, then unlink.
 *
 * IMPORTANT LIMITATION: on SSDs,
 * copy-on-write file systems, cloud-synced folders or with Volume Shadow
 * Copies, overwriting a file does NOT guarantee the old blocks are gone.
 * Full-disk encryption (BitLocker) is the real protection.
 */
export function secureDeleteFile(file: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch {
    return;
  }
  if (!st.isFile()) {
    fs.rmSync(file, { force: true, recursive: true });
    return;
  }
  try {
    const fd = fs.openSync(file, 'r+');
    try {
      const chunk = 64 * 1024;
      let remaining = st.size;
      let pos = 0;
      while (remaining > 0) {
        const n = Math.min(chunk, remaining);
        fs.writeSync(fd, crypto.randomBytes(n), 0, n, pos);
        pos += n;
        remaining -= n;
      }
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // File may be locked or read-only; fall through to plain delete.
  }
  fs.rmSync(file, { force: true });
}

/** Recursively secure-delete a directory tree (best effort, see above). */
export function secureDeleteDir(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      // Never follow links out of the tree - just remove the link itself.
      fs.rmSync(p, { force: true });
    } else if (entry.isDirectory()) {
      secureDeleteDir(p);
    } else {
      secureDeleteFile(p);
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Join `child` onto `root` and guarantee that the result stays inside root.
 * Throws on "..", absolute paths, drive letters or UNC tricks.
 */
export function safeJoin(root: string, child: string): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, child);
  const rel = path.relative(resolvedRoot, target);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return target;
  throw new Error(`Path escapes root: ${child}`);
}

/** Total size in bytes of a directory tree (symlinks are not followed). */
export function dirSize(dir: string): number {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(p);
    else if (entry.isFile()) total += fs.statSync(p).size;
  }
  return total;
}

/** Copy a directory tree (used for profile duplication and backups). */
export function copyDir(src: string, dst: string, skip?: (relPath: string) => boolean): void {
  const walk = (rel: string) => {
    const from = path.join(src, rel);
    const to = path.join(dst, rel);
    const st = fs.lstatSync(from);
    if (st.isSymbolicLink()) return; // never copy links
    if (st.isDirectory()) {
      ensureDir(to);
      for (const name of fs.readdirSync(from)) {
        const childRel = rel ? path.join(rel, name) : name;
        if (skip && skip(childRel)) continue;
        walk(childRel);
      }
    } else if (st.isFile()) {
      ensureDir(path.dirname(to));
      fs.copyFileSync(from, to);
    }
  };
  walk('');
}

/** Returns an ISO timestamp safe for use in file names (no ':' on Windows). */
export function fileStamp(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, '-');
}

/** SHA-256 of a buffer/string as lowercase hex. */
export function sha256Hex(data: string | Uint8Array): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** Streaming SHA-256 of a file (does not load big installers into memory). */
export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('error', reject)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')));
  });
}
