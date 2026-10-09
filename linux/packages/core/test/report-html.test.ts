/**
 * packages/core/test/report-html.test.ts
 * The HTML export must not let a probed page inject markup or scripts.
 */
import { describe, expect, it } from 'vitest';
import { AuditReport, escapeHtml, renderHtmlReport, t as translate } from '../src';

const hostile = '<script>alert(1)</script><img src=x onerror=alert(2)>';

const report = (): AuditReport & { target: string } => ({
  schema: 1, app: 'OctoDetect.su', generatedAt: new Date('2026-09-25T10:00:00Z').toISOString(), profileName: hostile,
  risk: 'medium', score: 5, highEntropyExposed: 2, uniqueness: 'possibly-unique', dns: 'warning', webrtc: 'ok',
  fingerprintHash: `"><script>x</script>`, target: 'external',
  findings: [{ id: 'userAgent', category: 'identity', value: hostile, status: 'exposed', entropy: 'medium', points: 1, whyKey: 'why.userAgent' }],
  consistency: [{ key: 'cons.language', detail: hostile }],
});

describe('renderHtmlReport', () => {
  it('escapes every page-controlled value', () => {
    const html = renderHtmlReport(report(), (k, p) => translate('en', k, p));
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('is self-contained with a restrictive CSP and localised labels', () => {
    const html = renderHtmlReport(report(), (k, p) => translate('pl', k, p));
    expect(html).toMatch(/Content-Security-Policy" content="default-src 'none'/);
    expect(html).not.toMatch(/<script|src="http|href="http/i);
    expect(html).toContain('Średnie');
    expect(html).toContain('Nie jest gwarancją prywatności');
  });

  it('escapeHtml covers all special characters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
    expect(escapeHtml(null)).toBe('');
  });
});
