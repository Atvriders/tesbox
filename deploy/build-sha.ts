import { execSync } from 'node:child_process';

/**
 * Short build SHA: GITHUB_SHA (CI / Docker build-arg) → `git rev-parse --short HEAD` → 'dev'.
 * An empty GITHUB_SHA (Dockerfile `ENV GITHUB_SHA=$GITHUB_SHA` without the build-arg) counts as
 * unset.
 */
export function resolveBuildSha(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.GITHUB_SHA?.trim().slice(0, 7);
  if (fromEnv) return fromEnv;
  try {
    const out = execSync('git rev-parse --short HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const sha = String(out).trim();
    if (sha) return sha;
  } catch {
    // Not a git checkout (Docker build context has no .git) or no commits yet.
  }
  return 'dev';
}
