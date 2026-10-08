import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  detectFeatures,
  getWebglRenderer,
  parseMcu,
  viewportInfo,
} from '../../src/platform/detect';

afterEach(() => {
  vi.unstubAllGlobals();
});

interface FakeGlOptions {
  renderer?: unknown;
  debugExt?: boolean;
}

/** Fake `document` whose canvases hand out a fake WebGL context; records loseContext calls. */
function stubDocument(gl: FakeGlOptions | null, extra: Record<string, unknown> = {}) {
  const lost = { count: 0 };
  const UNMASKED_RENDERER_WEBGL = 0x9246;
  const context =
    gl === null
      ? null
      : {
          getExtension(name: string): unknown {
            if (name === 'WEBGL_debug_renderer_info') {
              return gl.debugExt === false ? null : { UNMASKED_RENDERER_WEBGL };
            }
            if (name === 'WEBGL_lose_context') {
              return {
                loseContext() {
                  lost.count += 1;
                },
              };
            }
            return null;
          },
          getParameter(p: number): unknown {
            return p === UNMASKED_RENDERER_WEBGL ? gl.renderer : null;
          },
        };
  vi.stubGlobal('document', {
    createElement: (tag: string) => {
      if (tag !== 'canvas') throw new Error(`unexpected element ${tag}`);
      return { getContext: (id: string) => (id === 'webgl' ? context : null) };
    },
    ...extra,
  });
  return lost;
}

describe('parseMcu', () => {
  it.each([
    ['Mesa DRI Intel(R) HD Graphics 505 (APL 3)', 'intel'],
    ['Mesa Intel(R) HD Graphics 505 (APL 3)', 'intel'],
    ['ANGLE (Intel, Mesa Intel(R) HD Graphics 505 (APL 3), OpenGL 4.6)', 'intel'],
    ['Intel ApolloLake', 'intel'],
    // Synthetic string matching both patterns: the Intel regex is tested first (contract).
    ['ANGLE (Intel, Intel(R) HD Graphics 630 + AMD Radeon RX Vega M, OpenGL 4.6)', 'intel'],
    ['AMD Radeon Vega 8 Graphics (raven, LLVM 15.0.7, DRM 3.42)', 'amd'],
    ['ANGLE (AMD, AMD Radeon(TM) Graphics (radeonsi, picasso), OpenGL 4.6)', 'amd'],
    ['Radeon RX Vega', 'amd'],
    ['AMD Ryzen Embedded V1000', 'amd'],
    ['NVIDIA Tegra 3', 'unknown'],
    ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)', 'unknown'],
    ['', 'unknown'],
  ] as const)('%s → %s', (renderer, mcu) => {
    expect(parseMcu(renderer)).toBe(mcu);
  });

  it('returns unknown for null', () => {
    expect(parseMcu(null)).toBe('unknown');
  });
});

describe('getWebglRenderer', () => {
  it('returns null without a document (Node)', () => {
    expect(getWebglRenderer()).toBeNull();
  });

  it('reads the unmasked renderer and releases the context', () => {
    const lost = stubDocument({ renderer: 'Mesa Intel(R) HD Graphics 505 (APL 3)' });
    expect(getWebglRenderer()).toBe('Mesa Intel(R) HD Graphics 505 (APL 3)');
    expect(lost.count).toBe(1);
  });

  it('returns null when the debug extension is unavailable', () => {
    const lost = stubDocument({ debugExt: false });
    expect(getWebglRenderer()).toBeNull();
    expect(lost.count).toBe(1);
  });

  it('returns null for a non-string or empty renderer', () => {
    stubDocument({ renderer: 42 });
    expect(getWebglRenderer()).toBeNull();
    stubDocument({ renderer: '' });
    expect(getWebglRenderer()).toBeNull();
  });

  it('returns null when WebGL is unavailable', () => {
    stubDocument(null);
    expect(getWebglRenderer()).toBeNull();
  });

  it('returns null when canvas creation throws', () => {
    vi.stubGlobal('document', {
      createElement: () => {
        throw new Error('blocked');
      },
    });
    expect(getWebglRenderer()).toBeNull();
  });
});

describe('detectFeatures', () => {
  it('reports nothing but ES modules in a bare Node environment', () => {
    vi.stubGlobal('navigator', {});
    expect(detectFeatures()).toEqual({
      audioWorklet: false,
      serviceWorker: false,
      cacheStorage: false,
      mediaSession: false,
      gamepad: false,
      deviceMotion: false,
      geolocation: false,
      crossOriginIsolated: false,
      fullscreen: false,
      esModules: true,
      webgl: false,
      outputTimestamp: false,
      mediaStreamDestination: false,
    });
  });

  it('reports every feature of a capable browser', () => {
    class FakeAudioContext {
      get audioWorklet(): object {
        return {};
      }
      getOutputTimestamp(): object {
        return {};
      }
      createMediaStreamDestination(): object {
        return {};
      }
    }
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('AudioWorkletNode', class {});
    vi.stubGlobal('DeviceMotionEvent', class {});
    vi.stubGlobal('caches', {});
    vi.stubGlobal('crossOriginIsolated', true);
    vi.stubGlobal('navigator', {
      serviceWorker: {},
      mediaSession: {},
      geolocation: {},
      getGamepads: () => [],
    });
    stubDocument({ renderer: 'x' }, { fullscreenEnabled: true });
    expect(detectFeatures()).toEqual({
      audioWorklet: true,
      serviceWorker: true,
      cacheStorage: true,
      mediaSession: true,
      gamepad: true,
      deviceMotion: true,
      geolocation: true,
      crossOriginIsolated: true,
      fullscreen: true,
      esModules: true,
      webgl: true,
      outputTimestamp: true,
      mediaStreamDestination: true,
    });
  });

  it('needs both AudioWorkletNode and context.audioWorklet for audioWorklet', () => {
    vi.stubGlobal('AudioContext', class {});
    vi.stubGlobal('AudioWorkletNode', class {});
    // The bare class also lacks getOutputTimestamp and createMediaStreamDestination.
    expect(detectFeatures()).toMatchObject({ audioWorklet: false, outputTimestamp: false, mediaStreamDestination: false });
  });

  it('survives a caches getter that throws (sandboxed / storage-blocked context)', () => {
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      get() {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    try {
      expect(() => detectFeatures()).not.toThrow();
      expect(detectFeatures().cacheStorage).toBe(false);
    } finally {
      Reflect.deleteProperty(globalThis, 'caches');
    }
  });

  it('survives a navigator.serviceWorker getter that throws (opaque-origin document)', () => {
    vi.stubGlobal('navigator', {
      get serviceWorker(): never {
        throw new DOMException('The document is sandboxed', 'SecurityError');
      },
    });
    expect(() => detectFeatures()).not.toThrow();
  });
});

describe('viewportInfo', () => {
  it('returns neutral values without a window (Node)', () => {
    expect(viewportInfo()).toEqual({
      dpr: 1,
      screen: [0, 0],
      inner: [0, 0],
      visual: null,
      maxTouchPoints: 0,
    });
  });

  it('reads dpr, screen, inner and visual viewport sizes', () => {
    vi.stubGlobal('window', {
      devicePixelRatio: 1.53,
      screen: { width: 1182, height: 920 },
      innerWidth: 773,
      innerHeight: 601,
      visualViewport: { width: 773, height: 590.5 },
    });
    vi.stubGlobal('navigator', { maxTouchPoints: 10 });
    expect(viewportInfo()).toEqual({
      dpr: 1.53,
      screen: [1182, 920],
      inner: [773, 601],
      visual: [773, 590.5],
      maxTouchPoints: 10,
    });
  });

  it('defaults dpr to 1, visual to null and touch points to 0 when missing', () => {
    vi.stubGlobal('window', {
      devicePixelRatio: 0,
      screen: { width: 800, height: 600 },
      innerWidth: 800,
      innerHeight: 600,
      visualViewport: null,
    });
    vi.stubGlobal('navigator', {});
    expect(viewportInfo()).toEqual({
      dpr: 1,
      screen: [800, 600],
      inner: [800, 600],
      visual: null,
      maxTouchPoints: 0,
    });
  });
});
