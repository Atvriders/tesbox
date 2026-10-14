/**
 * Tesbox app entry (phase-3 contract T1). Checks the platform with the same test as
 * public/unsupported.js, sizes touch targets from the device pixel ratio, picks the first screen
 * (Drive after a reload mid-drive), builds the shell around EngineAudio and GpsSource, mounts the
 * screen router and only then hides the static Unsupported block. A boot failure shows that block
 * with the error instead of an empty page.
 */
import * as store from './app/store';
import { EngineAudio } from './audio/engine-audio';
import { GpsSource } from './audio/gps-source';
import { getWebglRenderer, parseMcu } from './platform/detect';
import {
  createShell,
  initialScreen,
  mountApp,
  sessionFlag,
  showUnsupported,
  trackTouchSize,
  unsupportedReason,
  wireGps,
  type GpsWiring,
} from './ui/app';
import { STR } from './ui/strings';

/** Per tab (sessionStorage): the engine was on — from a start until stopEngine (spec §6.3). */
const ENGINE_ON_KEY = 'tesbox.v1.engineOn';

function boot(): void {
  const reason = unsupportedReason(window);
  if (reason !== null) {
    showUnsupported(document, reason);
    return;
  }
  const root = document.getElementById('app');
  if (root === null) return;

  // Touch targets ≥ 22 mm on any Tesla panel (spec §7.1); the car's zoom changes the dpr at runtime.
  trackTouchSize(window, document.documentElement);

  // After a reload mid-drive: restore settings, show Start immediately — Drive's Start overlay (spec §6.3).
  const engineMark = sessionFlag(ENGINE_ON_KEY);
  store.go(initialScreen(store.screen.peek(), engineMark.take()));

  let gps: GpsWiring | null = null;
  const { shell, audio } = createShell({
    settings: store.settings,
    engine: store.engine,
    teslaParams: store.teslaParams,
    audio: store.audio,
    snapshot: store.snapshot,
    toast: store.toast,
    updateSettings: store.updateSettings,
    createAudio: (cb) => new EngineAudio(cb),
    mcu: () => parseMcu(getWebglRenderer()),
    gpsMoving: () => gps?.moving() ?? false,
    engineMark,
    doc: document,
    page: window,
  });
  // From boot, whatever the speed source: the real-GPS parked estimate locks Settings while moving.
  gps = wireGps({
    settings: store.settings,
    gps: store.gps,
    audio: store.audio,
    post: (fix) => audio.post(fix),
    createGps: (onFix, onStatus) =>
      'geolocation' in navigator ? new GpsSource(navigator.geolocation, onFix, onStatus) : null,
  });
  mountApp(root, { screen: store.screen, toast: store.toast, audio: store.audio, shell });

  const unsupported = document.getElementById('unsupported');
  if (unsupported) unsupported.hidden = true;
}

try {
  boot();
} catch (err) {
  showUnsupported(document, STR.unsupported.bootFailed(err instanceof Error ? err.message : String(err)));
}
