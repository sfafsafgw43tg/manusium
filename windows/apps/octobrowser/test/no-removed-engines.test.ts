/**
 * Zero references to the emulator engines OctoBrowser no longer supports. The
 * banned words are assembled from pieces so that this file does not contain
 * them literally. The scan covers every text file in the repository and every
 * entry inside studio.zip (which is compressed, so it is inflated here).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..', '..', '..');
const BANNED = [
  new RegExp(['gen', 'ymotion'].join(''), 'i'),
  new RegExp(['gen', 'ymobile'].join(''), 'i'),
  new RegExp(['wayd', 'roid'].join(''), 'i'),
  new RegExp(['gm', 'tool'].join(''), 'i'),
];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.vite', '.turbo', '.cache']);
const SKIP_FILES = new Set(['package-lock.json']);

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(path.join(dir, entry.name));
    } else if (entry.isFile() && !SKIP_FILES.has(entry.name)) {
      yield path.join(dir, entry.name);
    }
  }
}

function isText(buffer: Buffer): boolean {
  return !buffer.subarray(0, 8000).includes(0);
}

/** Every stored or deflated entry of a zip archive, by name. */
function zipEntries(archive: Buffer): Array<{ name: string; data: Buffer }> {
  const eocd = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('not a zip archive');
  const count = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);
  const out: Array<{ name: string; data: Buffer }> = [];
  for (let i = 0; i < count; i++) {
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const localName = archive.readUInt16LE(localOffset + 26);
    const localExtra = archive.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localName + localExtra;
    const raw = archive.subarray(start, start + compressedSize);
    out.push({ name, data: method === 8 ? inflateRawSync(raw) : raw });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

describe('no removed emulator engine is referenced anywhere', () => {
  it('has no matches in any text file of the repository', () => {
    const hits: string[] = [];
    for (const file of walk(root)) {
      const buffer = fs.readFileSync(file);
      if (!isText(buffer)) continue;
      const text = buffer.toString('utf8');
      if (BANNED.some((pattern) => pattern.test(text))) hits.push(path.relative(root, file));
    }
    expect(hits).toEqual([]);
  });

  it('has no matches inside studio.zip', () => {
    const hits: string[] = [];
    for (const entry of zipEntries(fs.readFileSync(path.join(root, 'studio.zip')))) {
      if (!isText(entry.data)) continue;
      const text = entry.data.toString('utf8');
      if (BANNED.some((pattern) => pattern.test(text))) hits.push(entry.name);
    }
    expect(hits).toEqual([]);
  });
});
