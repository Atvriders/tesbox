import { afterEach, describe, expect, it, vi } from 'vitest';
import { afterLoad, createSwUpdater, registerAppSw, type SwHost } from '../../src/platform/sw-register';

// ── Fakes of the ServiceWorkerContainer / Registration / ServiceWorker parts the updater uses ──

class FakeWorker {
  readonly posted: unknown[] = [];
  private readonly listeners: (() => void)[] = [];
  constructor(public state: string) {}
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  addEventListener(type: string, fn: () => void): void {
    if (type === 'statechange') this.listeners.push(fn);
  }
  setState(state: string): void {
    this.state = state;
    for (const fn of this.listeners) fn();
  }
}

class FakeRegistration {
  waiting: FakeWorker | null = null;
  installing: FakeWorker | null = null;
  private readonly listeners: (() => void)[] = [];
  addEventListener(type: string, fn: () => void): void {
    if (type === 'updatefound') this.listeners.push(fn);
  }
  /** The browser found a changed /sw.js and starts installing it. */
  startInstall(worker = new FakeWorker('installing')): FakeWorker {
    this.installing = worker;
    this.fireUpdateFound();
    return worker;
  }
  fireUpdateFound(): void {
    for (const fn of this.listeners) fn();
  }
  /** Install succeeded: the registration's waiting slot is set before the worker's statechange (spec order). */
  finishInstall(worker: FakeWorker): void {
    this.installing = null;
    this.waiting = worker;
    worker.setState('installed');
  }
}

class FakeContainer {
  controller: object | null;
  readonly register = vi.fn<(url: string, opts: { scope: string }) => Promise<FakeRegistration | undefined>>(() =>
    Promise.resolve(this.registration),
  );
  private readonly listeners: (() => void)[] = [];
  constructor(
    public registration: FakeRegistration | undefined,
    controlled: boolean,
  ) {
    this.controller = controlled ? new FakeWorker('activated') : null;
  }
  addEventListener(type: string, fn: () => void): void {
    if (type === 'controllerchange') this.listeners.push(fn);
  }
  /** A worker took control of this page (clients.claim() after activation). */
  changeController(worker: object): void {
    this.controller = worker;
    for (const fn of this.listeners) fn();
  }
}

function setup(opts: { controlled?: boolean; registration?: FakeRegistration | undefined } = {}) {
  const registration = 'registration' in opts ? opts.registration : new FakeRegistration();
  const container = new FakeContainer(registration, opts.controlled ?? true);
  const reload = vi.fn();
  const host: SwHost = { navigator: { serviceWorker: container }, reload };
  const onUpdateReady = vi.fn();
  return { registration: registration as FakeRegistration, container, reload, onUpdateReady, updater: createSwUpdater(host) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('registration', () => {
  it('registers /sw.js for the whole site', async () => {
    const t = setup();
    expect(await t.updater.register(t.onUpdateReady)).toBe('registered');
    expect(t.container.register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
  });

  it("is 'unsupported' without navigator.serviceWorker (old browser, insecure context)", async () => {
    const reload = vi.fn();
    const onUpdateReady = vi.fn();
    expect(await createSwUpdater({ navigator: {}, reload }).register(onUpdateReady)).toBe('unsupported');
    expect(onUpdateReady).not.toHaveBeenCalled();
  });

  it("is 'unsupported' when register() yields no registration (a blocked API, e.g. Playwright serviceWorkers: 'block')", async () => {
    const t = setup({ registration: undefined });
    expect(await t.updater.register(t.onUpdateReady)).toBe('unsupported');
  });

  it("is 'failed' when registering rejects or the API throws, and never throws itself", async () => {
    const t = setup();
    t.container.register.mockRejectedValueOnce(new DOMException('bad script', 'SecurityError'));
    expect(await t.updater.register(t.onUpdateReady)).toBe('failed');

    const throwing: SwHost = {
      navigator: Object.defineProperty({}, 'serviceWorker', {
        get: () => {
          throw new DOMException('sandboxed', 'SecurityError');
        },
      }),
      reload: vi.fn(),
    };
    expect(await createSwUpdater(throwing).register(vi.fn())).toBe('failed');
  });

  it("registerAppSw uses the page's navigator: unsupported here (Node has no service workers)", async () => {
    const onUpdateReady = vi.fn();
    expect(await registerAppSw(onUpdateReady)).toBe('unsupported');
    expect(onUpdateReady).not.toHaveBeenCalled();
  });
});

describe('update detection', () => {
  it('a new version already waiting at registration is ready', async () => {
    const t = setup();
    t.registration.waiting = new FakeWorker('installed');
    await t.updater.register(t.onUpdateReady);
    expect(t.onUpdateReady).toHaveBeenCalledTimes(1);
  });

  it('a new version found later is ready once installed, not while installing', async () => {
    const t = setup();
    await t.updater.register(t.onUpdateReady);
    expect(t.onUpdateReady).not.toHaveBeenCalled();
    const worker = t.registration.startInstall();
    expect(t.onUpdateReady).not.toHaveBeenCalled();
    t.registration.finishInstall(worker);
    expect(t.onUpdateReady).toHaveBeenCalledTimes(1);
  });

  it('an install already under way when register() resolves (its updatefound already fired) is followed too', async () => {
    const t = setup();
    const worker = new FakeWorker('installing');
    t.registration.installing = worker;
    await t.updater.register(t.onUpdateReady);
    t.registration.finishInstall(worker);
    expect(t.onUpdateReady).toHaveBeenCalledTimes(1);
  });

  it('a worker seen both at registration and in a later updatefound is reported once', async () => {
    const t = setup();
    const worker = new FakeWorker('installing');
    t.registration.installing = worker;
    await t.updater.register(t.onUpdateReady);
    t.registration.fireUpdateFound(); // the same worker's updatefound, still queued at registration
    t.registration.finishInstall(worker);
    expect(t.onUpdateReady).toHaveBeenCalledTimes(1);
  });

  it('the first install (no worker controls the page yet) is not an update, and its claim never reloads', async () => {
    const t = setup({ controlled: false });
    await t.updater.register(t.onUpdateReady);
    const worker = t.registration.startInstall();
    t.registration.finishInstall(worker);
    worker.setState('activated');
    t.container.changeController(worker);
    expect(t.onUpdateReady).not.toHaveBeenCalled();
    expect(t.reload).not.toHaveBeenCalled();
  });

  it('an install that fails is not an update', async () => {
    const t = setup();
    await t.updater.register(t.onUpdateReady);
    t.registration.startInstall().setState('redundant');
    expect(t.onUpdateReady).not.toHaveBeenCalled();
  });
});

describe('applyUpdate', () => {
  it('asks the waiting worker to skip waiting, then reloads once it controls the page', async () => {
    const t = setup();
    const waiting = new FakeWorker('installed');
    t.registration.waiting = waiting;
    await t.updater.register(t.onUpdateReady);
    t.updater.applyUpdate();
    expect(waiting.posted).toEqual([{ type: 'SKIP_WAITING' }]);
    expect(t.reload).not.toHaveBeenCalled();
    t.container.changeController(waiting);
    expect(t.reload).toHaveBeenCalledTimes(1);
    t.container.changeController(new FakeWorker('activated'));
    expect(t.reload).toHaveBeenCalledTimes(1);
  });

  it('never reloads on a controller change it did not ask for (another tab applied the update)', async () => {
    const t = setup();
    t.registration.waiting = new FakeWorker('installed');
    await t.updater.register(t.onUpdateReady);
    t.container.changeController(t.registration.waiting);
    expect(t.reload).not.toHaveBeenCalled();
  });

  it('reloads straight away when nothing is waiting any more (another tab already applied it)', async () => {
    const t = setup();
    await t.updater.register(t.onUpdateReady);
    t.updater.applyUpdate();
    expect(t.reload).toHaveBeenCalledTimes(1);
  });

  it('reloads after 5 s anyway if the new worker never takes control, and only once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const t = setup();
    const waiting = new FakeWorker('installed');
    t.registration.waiting = waiting;
    await t.updater.register(t.onUpdateReady);
    t.updater.applyUpdate();
    await vi.advanceTimersByTimeAsync(4999);
    expect(t.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(t.reload).toHaveBeenCalledTimes(1);
    t.container.changeController(waiting);
    expect(t.reload).toHaveBeenCalledTimes(1);
  });
});

describe('afterLoad', () => {
  function fakePage(readyState: DocumentReadyState) {
    const listeners: { fn: () => void; once: boolean }[] = [];
    return {
      document: { readyState },
      addEventListener(type: string, fn: () => void, options?: { once?: boolean }): void {
        if (type === 'load') listeners.push({ fn, once: options?.once === true });
      },
      fireLoad(): void {
        for (const l of [...listeners]) {
          if (l.once) listeners.splice(listeners.indexOf(l), 1);
          l.fn();
        }
      },
    };
  }

  it('runs at once on a page that has finished loading', () => {
    const run = vi.fn();
    afterLoad(fakePage('complete'), run);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('otherwise waits for the load event, and runs once', () => {
    const run = vi.fn();
    const page = fakePage('interactive');
    afterLoad(page, run);
    expect(run).not.toHaveBeenCalled();
    page.fireLoad();
    page.fireLoad();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
