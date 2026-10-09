import { describe, expect, it, vi } from 'vitest';
import { checkAllSearchLatency, checkSearchLatency, clearSearchLatencyCache } from '../src/search-latency';

describe('search latency', () => {
  it('uses HEAD and treats HTTP errors as reachable', async () => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => new Response(null, { status: init?.method === 'HEAD' ? 405 : 200 }));
    const result = await checkSearchLatency('duckduckgo', fetcher);
    expect(result).toMatchObject({ state: 'reachable', reachable: true, status: 405 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('falls back once to GET after a HEAD network error and runs sequentially', async () => {
    clearSearchLatencyCache();
    const methods: string[] = [];
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      methods.push(String(init?.method));
      if (init?.method === 'HEAD') throw new Error('network');
      return new Response('body', { status: 200 });
    });
    const rows = await checkAllSearchLatency(['duckduckgo', 'brave'], fetcher);
    expect(rows.every((row) => row.reachable)).toBe(true);
    expect(methods).toEqual(['HEAD', 'GET', 'HEAD', 'GET']);
  });
  it('does not call fetch while offline', async () => {
    const fetcher = vi.fn();
    const rows = await checkAllSearchLatency(['duckduckgo'], fetcher, true);
    expect(rows[0].state).toBe('offline');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
