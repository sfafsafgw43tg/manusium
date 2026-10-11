// Downloads the pinned upstream hosts file (StevenBlack/hosts) into .cache/ and verifies it.
// `npm run build` calls loadUpstream() itself when the cache is missing. Run `npm run lists:fetch` to refresh it.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const PIN = JSON.parse(readFileSync(path.join(ROOT, 'rules', 'sources', 'stevenblack-hosts.json'), 'utf8'));
export const CACHE_FILE = path.join(ROOT, '.cache', 'upstream', `stevenblack-hosts-${PIN.commit.slice(0, 12)}.txt`);

/** Git's object id for a blob: SHA-1 over "blob <size>" + NUL + the bytes. */
export function gitBlobId(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** Throws unless the bytes are exactly the pinned file. */
export function verifyUpstream(bytes) {
  const blob = gitBlobId(bytes);
  if (blob !== PIN.blobSha) throw new Error(`upstream hosts file has blob id ${blob}, expected ${PIN.blobSha}`);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== PIN.sha256) throw new Error(`upstream hosts file has sha256 ${digest}, expected ${PIN.sha256}`);
  return bytes;
}

/** Returns the verified bytes of the pinned file, from the cache when it is already there and valid. */
export async function loadUpstream({ log = () => {} } = {}) {
  if (existsSync(CACHE_FILE)) {
    try {
      return verifyUpstream(readFileSync(CACHE_FILE));
    } catch {
      log('the cached hosts file failed verification and will be downloaded again');
    }
  }
  const url = `https://api.github.com/repos/${PIN.repo}/git/blobs/${PIN.blobSha}`;
  log(`downloading ${PIN.repo} hosts file at commit ${PIN.commit.slice(0, 7)}`);
  const response = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'goal-in-browser-build' },
  });
  if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status} for ${url}`);
  const body = await response.json();
  if (body.encoding !== 'base64' || typeof body.content !== 'string') {
    throw new Error('GitHub returned an unexpected blob format');
  }
  const bytes = verifyUpstream(Buffer.from(body.content, 'base64'));
  mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  writeFileSync(CACHE_FILE, bytes);
  return bytes;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  loadUpstream({ log: console.log }).then(
    (bytes) => console.log(`verified ${bytes.length} bytes at ${path.relative(ROOT, CACHE_FILE)}`),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
