/**
 * Feature detection, MCU guess and viewport facts (spec §3). Every probe is guarded so this
 * module also loads in Node (unit tests) and in browsers that lack an API.
 * Touch-target sizing lives in src/contracts.ts (`minTouchCssPx`), not here.
 */

export type Mcu = 'intel' | 'amd' | 'unknown';

const INTEL_RE = /intel|mesa dri intel|hd graphics|apollolake|apl/i;
const AMD_RE = /amd|radeon|raven|vega|picasso|ryzen/i;

/** Guesses the Tesla MCU from a WebGL renderer string: Intel Atom (MCU2) or AMD Ryzen (MCU3). */
export function parseMcu(renderer: string | null): Mcu {
  if (!renderer) return 'unknown';
  if (INTEL_RE.test(renderer)) return 'intel';
  if (AMD_RE.test(renderer)) return 'amd';
  return 'unknown';
}

/** Creates a throwaway WebGL context, runs `fn`, then releases the context (GPU memory is scarce on MCU2). */
function withWebgl<T>(fn: (gl: WebGLRenderingContext) => T, fallback: T): T {
  if (typeof document === 'undefined') return fallback;
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl');
    if (!gl) return fallback;
    try {
      return fn(gl);
    } finally {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch {
    return fallback;
  }
}

/** Unmasked renderer via WEBGL_debug_renderer_info; null when WebGL or the extension is unavailable. */
export function getWebglRenderer(): string | null {
  return withWebgl<string | null>((gl) => {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (!ext) return null;
    const renderer: unknown = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
    return typeof renderer === 'string' && renderer !== '' ? renderer : null;
  }, null);
}

export interface Features {
  audioWorklet: boolean;
  serviceWorker: boolean;
  cacheStorage: boolean;
  mediaSession: boolean;
  gamepad: boolean;
  deviceMotion: boolean;
  geolocation: boolean;
  crossOriginIsolated: boolean;
  fullscreen: boolean;
  esModules: true;
  webgl: boolean;
  outputTimestamp: boolean;
  mediaStreamDestination: boolean;
}

/** True when AudioContext exists and its prototype chain has `name` (BaseAudioContext members included). */
function audioContextHas(name: string): boolean {
  return typeof AudioContext === 'function' && name in AudioContext.prototype;
}

/** `caches` is a getter that throws SecurityError in sandboxed or storage-blocked contexts. */
function hasCaches(): boolean {
  try {
    return typeof caches !== 'undefined';
  } catch {
    return false;
  }
}

/** Never throws: every probe is guarded, so the probe page can call this at module top level. */
export function detectFeatures(): Features {
  const nav: Navigator | undefined = typeof navigator === 'undefined' ? undefined : navigator;
  return {
    audioWorklet: typeof AudioWorkletNode === 'function' && audioContextHas('audioWorklet'),
    serviceWorker: nav !== undefined && 'serviceWorker' in nav,
    cacheStorage: hasCaches(),
    mediaSession: nav !== undefined && 'mediaSession' in nav,
    gamepad: nav !== undefined && typeof nav.getGamepads === 'function',
    deviceMotion: typeof DeviceMotionEvent !== 'undefined',
    geolocation: nav !== undefined && 'geolocation' in nav,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    fullscreen: typeof document !== 'undefined' && document.fullscreenEnabled === true,
    // This module only runs from an ES-module bundle, so module support is a given.
    esModules: true,
    webgl: withWebgl(() => true, false),
    outputTimestamp: audioContextHas('getOutputTimestamp'),
    mediaStreamDestination: audioContextHas('createMediaStreamDestination'),
  };
}

export interface ViewportInfo {
  dpr: number;
  screen: [number, number];
  inner: [number, number];
  visual: [number, number] | null;
  maxTouchPoints: number;
}

/** Current viewport facts in CSS px (re-read on resize; Tesla zoom changes dpr at runtime). */
export function viewportInfo(): ViewportInfo {
  if (typeof window === 'undefined') {
    return { dpr: 1, screen: [0, 0], inner: [0, 0], visual: null, maxTouchPoints: 0 };
  }
  const vv = window.visualViewport;
  return {
    dpr: window.devicePixelRatio || 1,
    screen: [window.screen.width, window.screen.height],
    inner: [window.innerWidth, window.innerHeight],
    visual: vv ? [vv.width, vv.height] : null,
    maxTouchPoints: typeof navigator === 'undefined' ? 0 : (navigator.maxTouchPoints ?? 0),
  };
}
