import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

const PUBLIC_TEXT_FILES = [
  'README.md',
  'NOTICES',
  'docs/IN_CAR_CHECKLIST.md',
  'docs/CLEAN_ROOM.md',
  'docker-compose.yml',
  'Dockerfile',
  'nginx.conf',
  '.github/workflows/ci.yml',
];

describe('licence and notices', () => {
  it('LICENSE is MIT, 2026 Atvriders', () => {
    const license = read('LICENSE');
    expect(license.startsWith('MIT License')).toBe(true);
    expect(license).toContain('Copyright (c) 2026 Atvriders');
  });

  it('NOTICES lists the test-only jsQR dependency, the QR encoder MIT notice and the non-affiliation line, and ships in the image', () => {
    const notices = read('NOTICES');
    expect(notices).toContain('jsQR — Apache-2.0');
    // MIT notice for the src/platform/qr.ts adaptation of Project Nayuki's library (T3).
    expect(notices).toContain('src/platform/qr.ts');
    expect(notices).toContain('https://www.nayuki.io/page/qr-code-generator-library');
    expect(notices).toContain('Copyright (c) Project Nayuki. (MIT License)');
    expect(notices).toContain('Permission is hereby granted, free of charge');
    expect(notices).toContain('Not affiliated with or endorsed by Tesla, Inc.');
    // Phase 1 inserts its Ajv line directly below this one.
    expect(notices).toContain('Development and test tools (not shipped to users):\n');
    expect(notices).toContain('\n  TypeScript, Playwright — Apache-2.0\n');
    // MIT: the notice must accompany every copy, including the published image (Step 21).
    expect(read('Dockerfile')).toContain('COPY NOTICES /usr/share/nginx/html/NOTICES.txt');
    expect(read('Dockerfile')).toContain('COPY LICENSE /usr/share/nginx/html/LICENSE.txt');
  });

  it('keeps the QR encoder attribution in the bundle and ships no other third-party runtime code', () => {
    // A `/*! … @license` legal comment survives minification only with `comments: { legal: true }`.
    const qr = read('src/platform/qr.ts');
    expect(qr.startsWith('/*!')).toBe(true);
    expect(qr).toContain('@license MIT — Copyright (c) Project Nayuki. (MIT License)');
    const vite = read('vite.config.ts');
    expect(vite).toMatch(/comments:\s*\{\s*legal:\s*true\s*\}/);
    // Without this, Vite injects its own (MIT) modulepreload polyfill into the entry chunk.
    expect(vite).toMatch(/modulePreload:\s*\{\s*polyfill:\s*false\s*\}/);
  });
});

describe('docs', () => {
  it('README uses the placeholder domain, the disclaimer and links the checklist + clean-room log', () => {
    const readme = read('README.md');
    expect(readme).toContain('https://tesbox.example.com');
    expect(readme).toContain('Not affiliated with or endorsed by Tesla, Inc.');
    expect(readme).toContain('docs/IN_CAR_CHECKLIST.md');
    expect(readme).toContain('docs/CLEAN_ROOM.md');
  });

  it('IN_CAR_CHECKLIST maps every §16 question (Q1–Q11) and separates parked from driving steps', () => {
    const checklist = read('docs/IN_CAR_CHECKLIST.md');
    for (let q = 1; q <= 11; q++) expect(checklist, `Q${q}`).toMatch(new RegExp(`^\\| Q${q} \\|`, 'm'));
    expect(checklist).toMatch(/^## \d\. Parked/m);
    expect(checklist).toMatch(/^## \d\. Driving/m);
    expect(checklist).toContain('Show QR');
  });

  it('IN_CAR_CHECKLIST carries the whole-phase review changes (C8.1, C8.5)', () => {
    const checklist = read('docs/IN_CAR_CHECKLIST.md');
    const driveStart = checklist.indexOf('\n## 4. Driving');
    const driveEnd = checklist.indexOf('\n## 5. ', driveStart);
    expect(driveStart).toBeGreaterThan(0);
    expect(driveEnd).toBeGreaterThan(driveStart);
    const beforeDriving = checklist.slice(0, driveStart);
    const driving = checklist.slice(driveStart, driveEnd);

    expect(checklist).toContain('Show QR with the browser full size, not split view');
    // Each route pass restarts the music too, so the per-route *music* answer starts from playing music.
    expect(checklist).toContain('Repeat 2.1–2.8');
    expect(checklist).not.toContain('Repeat 2.2–2.8');
    // Minimising the browser means touching the screen: the hidden-fixes check is parked now.
    expect(beforeDriving).toContain('*hidden fixes*');
    expect(driving).not.toContain('*hidden fixes*');
    // A lone driver starts a longer motion probe while stopped, then pulls away.
    expect(driving).toContain('motionSeconds=');
    // Active Road Noise Reduction acts on road noise: listen at speed too, set the note only once parked.
    expect(driving).toContain('Active Road Noise Reduction');
    expect(driving).toContain('*Road-noise cancellation interferes* after parking');
    // The next-day storage check is exported as well.
    const nextDay = checklist.split('\n').find((l) => l.startsWith('| 5.4 |'));
    expect(nextDay).toContain('Show QR and append the export in a follow-up commit');
  });

  it('CLEAN_ROOM states the binding policy and records the patent check', () => {
    const cleanRoom = read('docs/CLEAN_ROOM.md');
    expect(cleanRoom).toContain('rupteur.app');
    expect(cleanRoom).toContain('juniper-sound-lab');
    expect(cleanRoom).toContain('ISO/IEC 18004');
    // Spec §13: the US 6,959,094 status as Google Patents shows it.
    expect(cleanRoom).toMatch(/US 6,959,094 .*"Expired - Lifetime", adjusted expiration 2022-12-26/);
    // Later phases append their source logs under these headings.
    for (const heading of ['# Clean-room log', '## Policy', '## Phase 0 source log', '## Planned sources', '## Patents checked']) {
      expect(cleanRoom, heading).toMatch(new RegExp(`^${heading}`, 'm'));
    }
    expect(cleanRoom).toContain('| Module | Algorithm | Source |');
  });
});

describe('privacy (spec: no real hostnames or IPs in the repo)', () => {
  it('only loopback IPv4 literals appear', () => {
    for (const file of PUBLIC_TEXT_FILES) {
      const ips = read(file).match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? [];
      expect(ips.filter((ip) => ip !== '127.0.0.1'), file).toEqual([]);
    }
  });

  it('every absolute URL in user-facing docs is the placeholder domain or localhost', () => {
    for (const file of ['README.md', 'docs/IN_CAR_CHECKLIST.md', 'docker-compose.yml']) {
      const urls = read(file).match(/https?:\/\/[^\s)`'"]+/g) ?? [];
      for (const url of urls) expect(url, file).toMatch(/^(https:\/\/tesbox\.example\.com|http:\/\/localhost(:\d+)?)(\/|$)/);
    }
  });
});

describe('.github/workflows/ci.yml', () => {
  const ci = (): string => read('.github/workflows/ci.yml');

  /** One job's text: from its `  <name>:` header to the next job header (or the end of the file). */
  const job = (name: string): string => {
    const text = ci();
    const start = text.indexOf(`\n  ${name}:\n`);
    if (start === -1) throw new Error(`ci.yml has no job "${name}"`);
    const rest = text.slice(start + 1);
    const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
    return next === -1 ? rest : rest.slice(0, next + 2);
  };

  /** Amendment C7 pins (resolved 2026-10-07), plus the Playwright browser cache (spec §12), resolved 2026-10-08. */
  const PINNED_ACTIONS = new Set([
    'actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0',
    'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0',
    'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2',
    'docker/setup-qemu-action@c7c53464625b32c7a7e944ae62b3e17d2b600130 # v3.7.0',
    'docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f # v3.12.0',
    'docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9 # v3.7.0',
    'docker/build-push-action@10e90e3645eae34f1e60eeb005ba3a3d33f178e8 # v6.19.2',
    'actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830 # v4.3.0',
  ]);

  it('runs on master pushes and PRs with read-only workflow permissions (C7)', () => {
    expect(ci()).toMatch(/push:\n\s+branches: \[master\]\n\s+pull_request:/);
    // Workflow level: exactly `contents: read`, nothing else.
    expect(ci()).toMatch(/^permissions:\n {2}contents: read\n(?! )/m);
  });

  it('grants packages: write to the publish job only (C7)', () => {
    expect(ci()).not.toMatch(/write-all/);
    expect([...ci().matchAll(/^\s+[\w-]+: write\s*$/gm)].map((m) => m[0].trim())).toEqual(['packages: write']);
    expect(job('publish')).toMatch(/\n {4}permissions:\n {6}contents: read\n {6}packages: write\n/);
    expect(job('test')).not.toContain('packages:');
    expect(job('e2e')).not.toContain('packages:');
  });

  it('publishes one run per ref at a time: a newer push cancels the older publish (C8.7)', () => {
    expect(job('publish')).toMatch(
      /\n {4}concurrency:\n {6}group: publish-\$\{\{ github\.ref \}\}\n {6}cancel-in-progress: true\n/,
    );
    expect(ci()).not.toMatch(/^concurrency:/m); // job-level only: test and e2e runs are never cancelled
  });

  it('chains test → e2e → publish, publishing only on pushes to master', () => {
    expect(ci()).toMatch(/\n {2}e2e:\n {4}needs: test\n/);
    expect(ci()).toMatch(/\n {2}publish:\n {4}needs: \[test, e2e\]\n {4}if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/master'\n/);
  });

  it('tests the container with Playwright (browsers cached) and pushes both multi-arch tags', () => {
    expect(ci()).toContain('tags: tesbox:ci');
    expect(ci()).toContain('build-args: GITHUB_SHA=${{ github.sha }}');
    expect(ci()).toContain('docker run -d --name tesbox -p 8080:8080 tesbox:ci');
    expect(ci()).toContain('path: ~/.cache/ms-playwright');
    expect(ci()).toContain("key: playwright-${{ runner.os }}-${{ hashFiles('package-lock.json') }}");
    expect(ci()).toContain('npx playwright install --with-deps chromium');
    expect(ci()).toContain('E2E_BASE_URL: http://localhost:8080');
    expect(ci()).toContain('platforms: linux/amd64,linux/arm64');
    expect(ci()).toContain('ghcr.io/atvriders/tesbox:latest');
    expect(ci()).toContain('ghcr.io/atvriders/tesbox:${{ github.sha }}');
  });

  it('labels the published image with its source repository and revision (C6)', () => {
    const publish = job('publish');
    expect(publish).toContain('org.opencontainers.image.source=https://github.com/Atvriders/tesbox');
    expect(publish).toContain('org.opencontainers.image.revision=${{ github.sha }}');
    expect(read('Dockerfile')).toContain('LABEL org.opencontainers.image.source="https://github.com/Atvriders/tesbox"');
  });

  it('pins every action to a full commit SHA with its version as a comment (C7)', () => {
    const uses = [...ci().matchAll(/^\s*(?:- )?uses: (.+)$/gm)].map((m) => (m[1] ?? '').trim());
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}/);
    for (const u of uses) expect(u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
    for (const u of uses) expect(PINNED_ACTIONS.has(u), u).toBe(true);
    expect(new Set(uses)).toEqual(PINNED_ACTIONS);
  });
});
