import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '..', '..', '..');
const read = (...p: string[]) => readFileSync(path.join(root, ...p), 'utf8');

describe('profile fingerprint runtime', () => {
  it('keeps the runtime module integrated without a duplicate legacy stub', () => {
    expect(existsSync(path.join(root, 'apps/octobrowser/src/main/fingerprint-runtime.ts'))).toBe(false);
    expect(read('apps/octobrowser/src/main/runtime.ts')).toContain('resolveFingerprint(this.profile.fingerprint');
  });

  it('passes the resolved identity to page preloads', () => {
    const windowSource = read('apps/octobrowser/src/main/window.ts');
    expect(windowSource).toContain('const resolved = this.rt.fp?.enabled ? this.rt.fp : null;');
    expect(windowSource).not.toContain('fp: null,');
    expect(windowSource).toContain('fullVersionList: resolved.fullVersionList');
  });

  it('applies User-Agent and Accept-Language to the profile session', () => {
    const session = read('packages/shell/src/session-privacy.ts');
    expect(session).toContain('this.ses.setUserAgent');
    expect(session).toContain("setHeader(headers, 'User-Agent', this.identityUserAgent)");
    expect(session).toContain("setHeader(headers, 'Accept-Language', this.identityAcceptLanguages)");
  });
});
