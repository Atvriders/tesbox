import { BUILD_SHA } from './platform/build-info';

/** Phase 0 placeholder boot. The real app shell arrives in Phase 3. */
function boot(doc: Document): void {
  const unsupported = doc.getElementById('unsupported');
  if (unsupported) unsupported.hidden = true;

  const app = doc.getElementById('app');
  if (!app) return;

  const status = doc.createElement('p');
  status.id = 'status';
  const link = doc.createElement('a');
  link.href = '/probe/';
  link.textContent = '/probe/';
  status.append('Tesbox — under construction. Open ', link);

  const build = doc.createElement('p');
  build.id = 'build-sha';
  build.textContent = `Build ${BUILD_SHA}`;

  const footer = doc.createElement('p');
  footer.textContent = 'Not affiliated with Tesla, Inc.';

  app.replaceChildren(status, build, footer);
}

boot(document);
