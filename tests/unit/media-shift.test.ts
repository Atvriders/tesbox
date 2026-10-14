import { describe, expect, it } from 'vitest';
import { MEDIA_KEY, MediaShift, TILT_KEYS, WheelTest, mediaKeyCode } from '../../src/input/media-shift';

describe('media keys', () => {
  it('names a keydown by its code, or by its key when it carries no usable code', () => {
    expect(mediaKeyCode({ code: 'MediaTrackNext', key: 'MediaTrackNext' })).toBe('MediaTrackNext');
    expect(mediaKeyCode({ code: '', key: 'MediaTrackPrevious' })).toBe('MediaTrackPrevious');
    expect(mediaKeyCode({ code: 'Unidentified', key: 'MediaPlayPause' })).toBe('MediaPlayPause');
  });

  it('TILT_KEYS are exactly the keys MediaShift and WheelTest take as tilts', () => {
    expect([...TILT_KEYS].sort()).toEqual(['MediaTrackNext', 'MediaTrackPrevious']);
    for (const k of TILT_KEYS) expect(new MediaShift(true).handleKey(k, 0)).not.toBeNull();
    const w = new WheelTest();
    w.start(0);
    expect(w.onKey('MediaTrackNext', 1)).toBe('waitLeft');
    expect(w.onKey('MediaTrackPrevious', 2)).toBe('done');
  });

  it('MEDIA_KEY matches the media and volume keys a wheel or remote may send, nothing else', () => {
    for (const k of ['MediaTrackNext', 'MediaPlayPause', 'MediaStop', 'AudioVolumeUp', 'AudioVolumeMute']) {
      expect(MEDIA_KEY.test(k), k).toBe(true);
    }
    for (const k of ['KeyE', 'Space', 'ArrowUp', 'nexttrack', '']) expect(MEDIA_KEY.test(k), k).toBe(false);
  });
});

function enabled(): MediaShift {
  const m = new MediaShift();
  m.enabled = true;
  return m;
}

describe('MediaShift — mapping', () => {
  it('is off until enabled: tilts do not shift', () => {
    const m = new MediaShift();
    expect(m.enabled).toBe(false);
    expect(m.handleAction('nexttrack', 0)).toBeNull();
    expect(m.handleKey('MediaTrackPrevious', 5000)).toBeNull();
  });

  it('maps next to up and previous to down, from Media Session actions and media keys', () => {
    const m = enabled();
    expect(m.handleAction('nexttrack', 0)).toBe('up');
    expect(m.handleAction('previoustrack', 5000)).toBe('down');
    expect(m.handleKey('MediaTrackNext', 10_000)).toBe('up');
    expect(m.handleKey('MediaTrackPrevious', 15_000)).toBe('down');
  });

  it('play, pause and every other action or key never shift', () => {
    const m = enabled();
    let t = 0;
    for (const a of ['play', 'pause', 'stop', 'seekforward', 'seekbackward', 'seekto', 'skipad', '']) {
      expect(m.handleAction(a, (t += 2000))).toBeNull();
    }
    for (const k of ['MediaPlayPause', 'MediaStop', 'MediaPlay', 'AudioVolumeUp', 'KeyE', 'nexttrack', '']) {
      expect(m.handleKey(k, (t += 2000))).toBeNull();
    }
  });

  it('can be constructed enabled', () => {
    expect(new MediaShift(true).handleAction('nexttrack', 0)).toBe('up');
  });

  it('disabling stops shifting at once and re-enabling resumes', () => {
    const m = enabled();
    expect(m.handleKey('MediaTrackNext', 0)).toBe('up');
    m.enabled = false;
    expect(m.handleAction('nexttrack', 3000)).toBeNull();
    m.enabled = true;
    expect(m.handleAction('nexttrack', 6000)).toBe('up');
  });
});

describe('MediaShift — dedupe (spec §6.2)', () => {
  it('a key and an action of the same direction within 900 ms count once, in either order', () => {
    const m = enabled();
    expect(m.handleKey('MediaTrackNext', 0)).toBe('up');
    expect(m.handleAction('nexttrack', 400)).toBeNull();
    expect(m.handleAction('previoustrack', 5000)).toBe('down');
    expect(m.handleKey('MediaTrackPrevious', 5900)).toBeNull(); // exactly 900 ms: still one input
  });

  it('more than 900 ms apart, a key and an action are two shifts', () => {
    const m = enabled();
    expect(m.handleKey('MediaTrackNext', 0)).toBe('up');
    expect(m.handleAction('nexttrack', 901)).toBe('up');
    expect(m.handleAction('previoustrack', 5000)).toBe('down');
    expect(m.handleKey('MediaTrackPrevious', 5901)).toBe('down');
  });

  it('same-source repeats are not suppressed', () => {
    const m = enabled();
    expect(m.handleAction('nexttrack', 0)).toBe('up');
    expect(m.handleAction('nexttrack', 100)).toBe('up');
    expect(m.handleAction('nexttrack', 200)).toBe('up');
    expect(m.handleKey('MediaTrackPrevious', 5000)).toBe('down');
    expect(m.handleKey('MediaTrackPrevious', 5050)).toBe('down');
  });

  it('pairs one key with one action: two quick tilts, each delivered twice, are two shifts', () => {
    const m = enabled();
    // tilt 1 → key then action; tilt 2 → action then key
    expect([
      m.handleKey('MediaTrackNext', 0),
      m.handleAction('nexttrack', 100),
      m.handleAction('nexttrack', 200),
      m.handleKey('MediaTrackNext', 250),
    ]).toEqual(['up', null, 'up', null]);
    // both keys first, then both actions
    expect([
      m.handleKey('MediaTrackNext', 5000),
      m.handleKey('MediaTrackNext', 5050),
      m.handleAction('nexttrack', 5100),
      m.handleAction('nexttrack', 5150),
    ]).toEqual(['up', 'up', null, null]);
  });

  it('an action only absorbs a key from inside its window', () => {
    const m = enabled();
    expect(m.handleKey('MediaTrackNext', 0)).toBe('up');
    expect(m.handleKey('MediaTrackNext', 600)).toBe('up');
    // 1000 ms: the key at 0 has expired, the key at 600 absorbs this action
    expect(m.handleAction('nexttrack', 1000)).toBeNull();
    // and nothing is left to absorb a second action
    expect(m.handleAction('nexttrack', 1100)).toBe('up');
  });

  it('directions are deduplicated separately', () => {
    const m = enabled();
    expect(m.handleKey('MediaTrackNext', 0)).toBe('up');
    expect(m.handleAction('previoustrack', 100)).toBe('down');
    expect(m.handleAction('nexttrack', 200)).toBeNull(); // pairs with the key at 0
    expect(m.handleKey('MediaTrackPrevious', 300)).toBeNull(); // pairs with the action at 100
  });

  it('a play/pause between a key and its action does not break the pairing', () => {
    const m = enabled();
    expect(m.handleKey('MediaTrackNext', 0)).toBe('up');
    expect(m.handleAction('play', 50)).toBeNull();
    expect(m.handleAction('nexttrack', 100)).toBeNull();
  });

  it('tolerates the second half of a pair carrying a slightly earlier timestamp', () => {
    const m = enabled();
    expect(m.handleKey('MediaTrackNext', 1000)).toBe('up'); // e.g. KeyboardEvent.timeStamp
    expect(m.handleAction('nexttrack', 999.5)).toBeNull(); // e.g. performance.now() read earlier
  });

  it('inputs while disabled are not remembered for pairing', () => {
    const m = new MediaShift();
    m.handleKey('MediaTrackNext', 0);
    m.enabled = true;
    expect(m.handleAction('nexttrack', 100)).toBe('up');
  });
});

describe('WheelTest (spec §7.2)', () => {
  it('starts idle with no result', () => {
    const t = new WheelTest();
    expect(t.state).toBe('idle');
    expect(t.works).toBeNull();
  });

  it('works when a right tilt and then a left tilt each arrive within 10 s', () => {
    const t = new WheelTest();
    t.start(0);
    expect(t.state).toBe('waitRight');
    expect(t.onAction('nexttrack', 9000)).toBe('waitLeft');
    expect(t.works).toBeNull();
    expect(t.onAction('previoustrack', 18_000)).toBe('done'); // 9 s into the left step
    expect(t.works).toBe(true);
  });

  it('accepts the MediaTrack keys as tilts', () => {
    const t = new WheelTest();
    t.start(0);
    expect(t.onKey('MediaTrackNext', 100)).toBe('waitLeft');
    expect(t.onKey('MediaTrackPrevious', 200)).toBe('done');
    expect(t.works).toBe(true);
  });

  it('a tilt exactly 10 s into a step still counts', () => {
    const t = new WheelTest();
    t.start(0);
    expect(t.onAction('nexttrack', 10_000)).toBe('waitLeft');
    expect(t.onAction('previoustrack', 20_000)).toBe('done');
    expect(t.works).toBe(true);
  });

  it('fails when no right tilt arrives within 10 s', () => {
    const t = new WheelTest();
    t.start(0);
    expect(t.tick(10_000)).toBe('waitRight');
    expect(t.tick(10_001)).toBe('done');
    expect(t.works).toBe(false);
  });

  it('fails when no left tilt arrives within 10 s of the right one', () => {
    const t = new WheelTest();
    t.start(0);
    t.onAction('nexttrack', 3000);
    expect(t.tick(13_000)).toBe('waitLeft');
    expect(t.tick(13_001)).toBe('done');
    expect(t.works).toBe(false);
  });

  it('a tilt that arrives too late fails the test even without a tick in between', () => {
    const t = new WheelTest();
    t.start(0);
    expect(t.onAction('nexttrack', 10_001)).toBe('done');
    expect(t.works).toBe(false);
  });

  it('ignores presses, the wrong direction and the second delivery of a counted tilt', () => {
    const t = new WheelTest();
    t.start(0);
    expect(t.onAction('play', 100)).toBe('waitRight');
    expect(t.onAction('pause', 200)).toBe('waitRight');
    expect(t.onKey('MediaPlayPause', 300)).toBe('waitRight');
    expect(t.onAction('previoustrack', 400)).toBe('waitRight');
    expect(t.onKey('MediaTrackPrevious', 450)).toBe('waitRight');
    expect(t.onKey('MediaTrackNext', 500)).toBe('waitLeft');
    expect(t.onAction('nexttrack', 600)).toBe('waitLeft'); // the same tilt, delivered again
    expect(t.onAction('play', 700)).toBe('waitLeft');
    expect(t.onAction('previoustrack', 800)).toBe('done');
    expect(t.works).toBe(true);
  });

  it('reports the seconds left in the current step', () => {
    const t = new WheelTest();
    expect(t.remainingS(0)).toBe(0);
    t.start(0);
    expect(t.remainingS(2500)).toBe(7.5);
    t.onAction('nexttrack', 4000);
    expect(t.remainingS(4000)).toBe(10);
    expect(t.remainingS(13_000)).toBe(1);
    expect(t.remainingS(15_000)).toBe(0);
    t.onAction('previoustrack', 5000);
    expect(t.remainingS(5000)).toBe(0);
  });

  it('inputs while idle change nothing, and a finished result stays put', () => {
    const t = new WheelTest();
    expect(t.onAction('nexttrack', 0)).toBe('idle');
    expect(t.tick(60_000)).toBe('idle');
    t.start(100_000);
    t.onAction('nexttrack', 100_100);
    t.onAction('previoustrack', 100_200);
    expect(t.onAction('nexttrack', 100_300)).toBe('done');
    expect(t.tick(1e9)).toBe('done');
    expect(t.works).toBe(true);
  });

  it('start() runs the test again from the beginning and cancel() returns to idle', () => {
    const t = new WheelTest();
    t.start(0);
    t.tick(20_000);
    expect(t.works).toBe(false);
    t.start(30_000);
    expect(t.state).toBe('waitRight');
    expect(t.works).toBeNull();
    expect(t.onAction('nexttrack', 30_500)).toBe('waitLeft');
    t.cancel();
    expect(t.state).toBe('idle');
    expect(t.works).toBeNull();
    expect(t.onAction('previoustrack', 31_000)).toBe('idle');
  });
});
