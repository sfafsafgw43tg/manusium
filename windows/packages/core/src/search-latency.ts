import { SEARCH_ENGINE_DEFINITIONS, type SearchEngine } from './settings';

export type LatencyState = 'reachable' | 'timeout' | 'error' | 'offline' | 'cached';
export interface SearchLatencyResult {
  engine: SearchEngine;
  state: LatencyState;
  reachable: boolean;
  status: number | null;
  latencyMs: number | null;
}
export type LatencyFetch = (input: string, init?: RequestInit) => Promise<Response>;

const cache = new Map<SearchEngine, { at: number; result: SearchLatencyResult }>();
const CACHE_MS = 60_000;
const TIMEOUT_MS = 4_000;

async function request(url: string, method: 'HEAD' | 'GET', fetcher: LatencyFetch): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetcher(url, {
      method, signal: controller.signal, credentials: 'omit', cache: 'no-store',
      referrerPolicy: 'no-referrer', redirect: 'manual',
    });
    if (method === 'GET') void response.body?.cancel();
    return response;
  } finally { clearTimeout(timer); }
}

export async function checkSearchLatency(engine: SearchEngine, fetcher: LatencyFetch = fetch): Promise<SearchLatencyResult> {
  const definition = SEARCH_ENGINE_DEFINITIONS[engine];
  const started = performance.now();
  try {
    let response: Response;
    try { response = await request(definition.latencyUrl, 'HEAD', fetcher); }
    catch (headError) {
      if (headError instanceof DOMException && headError.name === 'AbortError') throw headError;
      response = await request(definition.latencyUrl, 'GET', fetcher);
    }
    return { engine, state: 'reachable', reachable: true, status: response.status, latencyMs: Math.round(performance.now() - started) };
  } catch (error) {
    const timeout = error instanceof DOMException && error.name === 'AbortError';
    return { engine, state: timeout ? 'timeout' : 'error', reachable: false, status: null, latencyMs: null };
  }
}

export async function checkAllSearchLatency(
  engines: readonly SearchEngine[], fetcher: LatencyFetch = fetch, offline = false,
): Promise<SearchLatencyResult[]> {
  if (offline) return engines.map((engine) => ({ engine, state: 'offline', reachable: false, status: null, latencyMs: null }));
  const now = performance.now();
  const results: SearchLatencyResult[] = [];
  for (const engine of engines) {
    const prior = cache.get(engine);
    if (prior && now - prior.at < CACHE_MS) { results.push({ ...prior.result, state: 'cached' }); continue; }
    const result = await checkSearchLatency(engine, fetcher);
    cache.set(engine, { at: performance.now(), result });
    results.push(result);
  }
  return results;
}

export function clearSearchLatencyCache(): void { cache.clear(); }
