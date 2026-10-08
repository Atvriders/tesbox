/** Short SHA of the running build (replaced at build time by Vite `define`). */
export const BUILD_SHA: string = __BUILD_SHA__;

export interface VersionCheck {
  local: string;
  remote: string | null;
  stale: boolean;
  error?: string;
}

/**
 * Compares the running build with the deployed one via `version.json`, fetched with
 * `cache: 'no-store'` because the car's browser caches HTML indefinitely. Never throws.
 */
export async function checkVersion(
  fetchFn: typeof fetch = (input, init) => fetch(input, init),
  url: string = new URL('/version.json', location.origin).href,
): Promise<VersionCheck> {
  const local = BUILD_SHA;
  try {
    const res = await fetchFn(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body: unknown = await res.json();
    const remote =
      typeof body === 'object' && body !== null && 'sha' in body ? body.sha : undefined;
    if (typeof remote !== 'string' || remote === '') {
      throw new Error('version.json has no "sha" string');
    }
    return { local, remote, stale: remote !== local };
  } catch (err) {
    return {
      local,
      remote: null,
      stale: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
