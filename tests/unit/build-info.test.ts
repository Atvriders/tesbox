import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveBuildSha } from '../../deploy/build-sha';
import { BUILD_SHA, checkVersion } from '../../src/platform/build-info';

const VERSION_URL = 'https://tesbox.example.com/version.json';

function fakeFetch(respond: () => Promise<Response>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fn = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    return respond();
  };
  return { fetchFn: fn as typeof fetch, calls };
}

const json = (body: unknown, status = 200): Promise<Response> =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

describe('BUILD_SHA', () => {
  it('is the SHA vite.config.ts injected via define', () => {
    expect(BUILD_SHA).toBe(resolveBuildSha());
    expect(BUILD_SHA.length).toBeGreaterThan(0);
  });
});

describe('checkVersion', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches the url with cache no-store and reports up to date', async () => {
    const { fetchFn, calls } = fakeFetch(() => json({ sha: BUILD_SHA, builtAt: 'x' }));
    const result = await checkVersion(fetchFn, VERSION_URL);
    expect(calls).toEqual([{ url: VERSION_URL, init: { cache: 'no-store' } }]);
    expect(result).toEqual({ local: BUILD_SHA, remote: BUILD_SHA, stale: false });
  });

  it('reports stale when the deployed sha differs', async () => {
    const { fetchFn } = fakeFetch(() => json({ sha: 'zzzzzzz', builtAt: 'x' }));
    const result = await checkVersion(fetchFn, VERSION_URL);
    expect(result).toEqual({ local: BUILD_SHA, remote: 'zzzzzzz', stale: true });
  });

  it('reports an HTTP error without throwing', async () => {
    const { fetchFn } = fakeFetch(() => json({ error: 'nope' }, 404));
    const result = await checkVersion(fetchFn, VERSION_URL);
    expect(result).toEqual({ local: BUILD_SHA, remote: null, stale: false, error: 'HTTP 404' });
  });

  it('reports a network failure without throwing', async () => {
    const { fetchFn } = fakeFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    const result = await checkVersion(fetchFn, VERSION_URL);
    expect(result).toEqual({
      local: BUILD_SHA,
      remote: null,
      stale: false,
      error: 'Failed to fetch',
    });
  });

  it('reports unparseable JSON without throwing', async () => {
    const { fetchFn } = fakeFetch(() => Promise.resolve(new Response('<html>', { status: 200 })));
    const result = await checkVersion(fetchFn, VERSION_URL);
    expect(result.local).toBe(BUILD_SHA);
    expect(result.remote).toBeNull();
    expect(result.stale).toBe(false);
    expect(typeof result.error).toBe('string');
  });

  it('rejects a body without a sha string', async () => {
    const { fetchFn } = fakeFetch(() => json({ sha: 42 }));
    const result = await checkVersion(fetchFn, VERSION_URL);
    expect(result).toEqual({
      local: BUILD_SHA,
      remote: null,
      stale: false,
      error: 'version.json has no "sha" string',
    });
  });

  it('rejects an empty sha string', async () => {
    const { fetchFn } = fakeFetch(() => json({ sha: '' }));
    const result = await checkVersion(fetchFn, VERSION_URL);
    expect(result).toEqual({ local: BUILD_SHA, remote: null, stale: false, error: 'version.json has no "sha" string' });
  });

  it('defaults to /version.json on the page origin', async () => {
    vi.stubGlobal('location', { origin: 'https://tesbox.example.com' });
    const { fetchFn, calls } = fakeFetch(() => json({ sha: BUILD_SHA }));
    await checkVersion(fetchFn);
    expect(calls[0]?.url).toBe('https://tesbox.example.com/version.json');
  });
});
