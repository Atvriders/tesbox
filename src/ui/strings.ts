/**
 * Every user-facing English string of the app (spec §10.1: strings live in one module).
 *
 * Two exceptions must work without the module bundle and so cannot import this file: the static
 * Unsupported markup in index.html and public/unsupported.js (ES5). The reason texts of
 * `unsupported` below are mirrored there verbatim (tests/unit/unsupported-js.test.ts keeps them
 * equal).
 */
export const STR = {
  appName: 'Tesbox',
  build: (sha: string): string => `Build ${sha}`,

  /** Spec §13, shown in the shell footer. */
  disclaimer:
    'Not affiliated with or endorsed by Tesla, Inc. or any car manufacturer. Engine sounds are synthesized impressions, not recordings of the named cars.',

  /** First-run notices, verbatim from spec §10.2 item 2; one OK sets `settings.noticesSeen`. */
  notices: [
    'Tesbox replaces your music while it runs',
    'Keep Tesbox on screen — it idles when minimised',
    'Cabin sound only — keep it below sirens',
    'First load needs Wi-Fi, hotspot or Premium Connectivity',
    'Not affiliated with Tesla, Inc. or any car maker',
  ],

  /** One-time warning when Manual is first enabled, parked only (spec §10.2 item 4, §13). */
  manualWarning:
    'Using the touchscreen while driving may be illegal in some places (e.g. Germany, StVO §23(1a)) and is at your own risk. Auto shifts for you; use the paddles only when it is safe.',

  /** Router screen titles. */
  screens: {
    'first-run': 'Which Tesla?',
    garage: 'Garage',
    drive: 'Drive',
    settings: 'Settings',
    diagnostics: 'Diagnostics',
  },
  /** Title of the error boundary shown when a screen fails to render. */
  screenError: 'This screen stopped working',

  actions: {
    ok: 'OK',
    back: 'Back',
    skip: 'Skip',
    startEngine: 'Start engine',
    stopEngine: 'Stop engine',
    tapToResume: 'Tap to resume',
    useDemo: 'Use Demo',
    preview: 'Preview',
    drive: 'Drive',
    settings: 'Settings',
    diagnostics: 'Diagnostics',
    showQr: 'Show QR',
    reload: 'Reload',
    tryAgain: 'Try again',
  },

  /** Engine start problems (the shell shows them as a toast). */
  noTesla: 'Choose your Tesla before starting the engine.',
  startFailed: (message: string): string => `The engine could not start: ${message}`,
  /**
   * Spec §6.5: audio in its 'error' state — the worklet module or node failed at start, or the
   * worklet died — stays on screen with the error until the next start (the shell's AudioAlert).
   */
  audioFailed: (message: string): string => `Engine sound failed: ${message}`,

  /** Glance-safe locks (spec §10.1): only while parked / stopped. */
  parkedOnly: 'Available when parked',
  readOnlyWhileMoving: 'Read-only while moving',

  /** A newer build (spec §12, phase-4 contract T3): shown only with the engine off and the car parked. */
  update: {
    banner: 'Update available — tap to reload',
  },

  engineSets: { euro: 'Euro', jdm: 'JDM', american: 'American', exotic: 'Exotic' },
  inspiredBy: (car: string): string => `inspired by ${car}`,

  /** First run: notices, Tesla picker and bass sweep (spec §9.3, §10.2 item 2; src/ui/first-run.tsx). */
  firstRun: {
    noticesTitle: 'Before you start',
    steps: {
      model: 'Model',
      generation: 'Generation',
      trim: 'Trim',
      retrofit: 'Has this car had the MCU2 upgrade?',
      mcu1: 'This car needs the MCU2 upgrade',
      notListed: 'A Tesla that is not listed',
      subwoofer: 'Does your car have a subwoofer?',
      bass: 'Bass sweep',
      accel: 'Acceleration mode',
    },
    notListed: 'Not listed',
    notListedHint: 'Enter its 0–100 km/h time and mass',
    retrofitHint: 'Cars built with the first media computer (MCU1) run Tesbox only after the MCU2 upgrade.',
    retrofitYes: 'Yes, it has MCU2',
    retrofitNo: 'No',
    mcu1Blocked:
      'Without the MCU2 upgrade the browser in this car cannot run Tesbox. You can still finish the setup and use Tesbox on another device.',
    continueAnyway: 'Continue anyway',
    subwooferGuessHint: 'Pre-selected from your trim as a best guess.',
    subwooferHint: 'Not sure keeps the deepest bass away from the door speakers.',
    bestGuess: 'best guess',
    // No-break spaces (\u00a0) keep each number with its unit when the text wraps.
    bassIntro:
      'Set the volume where you usually listen. Six low tones play, from 30\u00a0Hz up to 60\u00a0Hz, 1.5\u00a0s each. Then tap the lowest one that sounded clean, without rattle or buzz.',
    bassCurrent: (hz: number): string => `Current setting: ${hz} Hz. Skip keeps it.`,
    playTones: 'Play tones',
    playAgain: 'Play again',
    startingAudio: 'Starting audio…',
    playing: (hz: number, step: number, steps: number): string => `Playing ${hz} Hz (${step} of ${steps})`,
    toneFailed: 'The tones could not play. Try again, or skip.',
    hz: (hz: number): string => `${hz} Hz`,
    accelHint: 'Pick the mode your car is set to; the engine pulls to match.',
    zeroTo100Label: '0–100 km/h time (s)',
    massLabel: 'Mass (kg)',
    bodyLabel: 'Body',
    bodies: { sedan: 'Sedan', suv: 'SUV', truck: 'Truck' },
    notListedInvalid: (s: { min: number; max: number }, kg: { min: number; max: number }): string =>
      `Enter a 0–100 km/h time from ${s.min} to ${s.max} s and a mass from ${kg.min} to ${kg.max} kg.`,
    notListedSummary: (seconds: number, kg: number, body: string): string =>
      `Not listed · 0–100 km/h in ${seconds} s · ${kg} kg · ${body}`,
    continue: 'Continue',
    cancel: 'Cancel',
  },

  /** Garage cards (spec §10.2 item 3; src/ui/garage.tsx). */
  garage: {
    intro: 'Choose an engine. Preview revs it; Drive takes it out.',
    previewing: 'Previewing…',
    previewParkedOnly: 'Preview is available when parked.',
    layout: {
      inline: (n: number): string => `Inline-${n}`,
      flat: (n: number): string => `Flat-${n}`,
      v: (n: number, deg: number): string => `${deg}° V${n}`,
      vCrank: (n: number, deg: number, crank: string): string => `${deg}° ${crank} V${n}`,
      rotary: (rotors: number): string => `${rotors}-rotor rotary`,
    },
    displacement: (litres: string): string => `${litres} L`,
    aspiration: {
      na: 'Naturally aspirated',
      turbo: 'Turbo',
      twinTurbo: 'Twin-turbo',
      sequentialTwinTurbo: 'Sequential twin-turbo',
      turbos: (n: number): string => `${n} turbos`,
      supercharged: 'Supercharged',
    },
    redline: (rpm: string): string => `${rpm} rpm redline`,
    /** Voicing status (phase-4 contract T4): the badge until the user's listening sign-off. */
    betaVoicing: 'Beta voicing',
    /** Last fact of the spec line while a voicing tuned against reference recordings awaits sign-off. */
    tuned: 'Tuned',
  },
  units: { mph: 'mph', kmh: 'km/h' },

  /** Labels for the contract enums the screens toggle. */
  modes: {
    gearbox: { auto: 'Auto', manual: 'Manual' },
    drive: { comfort: 'Comfort', sport: 'Sport' },
    valve: { auto: 'Auto', open: 'Open', closed: 'Closed' },
    perspective: { cabin: 'Cabin', outside: 'Outside' },
    source: { gps: 'GPS', demo: 'Demo', keyboard: 'Keyboard' },
    tier: { auto: 'Auto', full: 'Full', lite: 'Lite' },
    subwoofer: { yes: 'Yes', no: 'No', unsure: 'Not sure' },
  },
  valvesLabel: 'Valves',

  audioStates: {
    off: 'Engine off',
    starting: 'Starting',
    running: 'Running',
    interrupted: 'Interrupted',
    error: 'Audio error',
  },
  gpsStates: {
    off: 'GPS off',
    waiting: 'Waiting for GPS',
    ok: 'GPS ok',
    denied: 'Location blocked',
    unavailable: 'GPS unavailable',
  },
  /** Spec §6.5: blocking banner with re-grant steps, next to a Use Demo button. */
  geoDenied:
    'Location access is blocked, so Tesbox cannot follow your speed. Allow location for this site in the browser settings and reload, or use Demo.',

  /** Spec §6.5 / §10.2 item 1. */
  unsupported: {
    noModules: 'This browser cannot load ES modules.',
    noAudioContext: 'This browser has no Web Audio AudioContext.',
    noAudioWorklet: 'This browser has no Web Audio AudioWorklet (it also needs a secure https:// page).',
    bootFailed: (message: string): string => `Tesbox failed to start: ${message}`,
  },

  /** Drive (spec §7, §10.2 item 4; src/ui/drive.tsx). */
  drive: {
    neutral: 'N',
    none: '–',
    minus: '−',
    plus: '+',
    shiftDown: 'Shift down',
    shiftUp: 'Shift up',
    gearbox: 'Gearbox',
    driveMode: 'Mode',
    gearLabel: 'Gear',
    speedLabel: 'Speed',
    tachUnit: 'rpm × 1000',
    starting: 'Starting…',
    garage: 'Garage',
    resumeHint: 'The engine sound stopped. Tap anywhere to bring it back.',
    gpsMissing: 'This browser has no location access, so Tesbox cannot follow your speed. Use Demo or Keyboard instead.',
    manualTitle: 'Manual shifting',
    manualAccept: 'I understand',
    cancel: 'Cancel',
    statusHold: 'Hold for Diagnostics',
    statusLevels: { off: 'Engine off', ok: 'All good', warn: 'Check status', bad: 'Problem' },
    reasons: {
      engineOff: 'Engine off',
      audioError: 'Audio error',
      interrupted: 'Audio interrupted',
      starting: 'Starting',
      gpsMissing: 'No location access in this browser',
      gpsDenied: 'Location blocked',
      gpsWaiting: 'Waiting for GPS',
      gpsUnavailable: 'GPS unavailable',
      gpsLost: 'GPS lost',
      predicting: 'GPS dropout, predicting',
      overload: 'Audio overload',
      liteNext: 'Next start uses Lite quality',
    },
    sourceShort: { gps: 'GPS', demo: 'Demo', keyboard: 'Keys' },
  },

  /** Settings (spec §10.2 item 5; src/ui/settings-screen.tsx). */
  settingsUi: {
    sound: 'Sound',
    volume: 'Volume trim',
    volumeValue: (db: number): string => `${db > 0 ? '+' : ''}${db} dB`,
    quieter: 'Quieter',
    louder: 'Louder',
    perspective: 'Listening position',
    quality: 'Quality',
    qualityRunning: (tier: string): string => `Running now: ${tier}`,
    liteNext: 'The next start uses Lite after an audio overload.',
    car: 'Car',
    tesla: 'Tesla',
    noTesla: 'Not chosen',
    subwoofer: 'Subwoofer',
    bass: 'Bass limit',
    bassValue: (hz: number): string => `High-pass at ${hz} Hz`,
    bassFull: 'Full range (subwoofer)',
    changeTesla: 'Change Tesla, subwoofer or bass',
    accelMode: 'Acceleration mode',
    accelNotListed: 'Set by the 0–100 km/h time you entered',
    units: 'Units',
    speed: 'Speed',
    source: 'Speed source',
    controls: 'Controls',
    wheel: 'Steering-wheel shifting',
    wheelUntested: 'Not tested yet.',
    wheelWorks: 'Works: tilt right shifts up, tilt left shifts down.',
    wheelFailed: 'No wheel tilt reached Tesbox, so it stays off.',
    wheelTest: 'Test steering-wheel shifting',
    wheelNeedsAudio: 'Start the engine first: the wheel reaches Tesbox only while it plays.',
    wheelRight: 'Tilt the LEFT scroll wheel to the RIGHT now',
    wheelLeft: 'Now tilt the LEFT scroll wheel to the LEFT',
    wheelSecondsLeft: (s: number): string => `${s} s left`,
    wheelStop: 'Stop test',
    wheelEnable: 'Wheel shifting',
    on: 'On',
    off: 'Off',
    gamepadSwap: 'Gamepad A/B swap',
    gamepadHint: 'For Nintendo-style labels and the TESLA VIRTUAL GAMEPAD.',
    engine: 'Engine',
    advanced: 'Advanced',
    showAdvanced: 'Show advanced',
    hideAdvanced: 'Hide advanced',
    gpsMethod: 'GPS method',
    gpsMethods: { poll: 'Poll', watch: 'Watch' },
    highAccuracy: 'High-accuracy GPS',
    outputRoute: 'Audio output',
    routes: { direct: 'Direct', 'media-element': 'Media element', 'direct-anchor': 'Direct + anchor' },
    gpsLatency: 'GPS latency',
    latencyValue: (s: number): string => `${s.toFixed(1)} s`,
    less: 'Less',
    more: 'More',
    reset: 'Reset all settings',
    resetConfirm: 'This forgets your Tesla, your engine choice and every setting.',
    resetYes: 'Reset everything',
    cancel: 'Cancel',
  },

  /** Diagnostics (spec §10.2 item 6; src/ui/diagnostics.tsx). */
  diag: {
    none: '–',
    yes: 'yes',
    no: 'no',
    engine: 'Engine',
    gps: 'GPS',
    audio: 'Audio',
    counters: 'Session counters',
    platform: 'Platform',
    inputs: 'Last 40 inputs',
    noInputs: 'No inputs yet.',
    f: {
      time: 'Worklet time',
      rpm: 'rpm',
      gear: 'Gear',
      speed: 'Speed',
      load: 'Load',
      throttle: 'Throttle',
      boost: 'Boost',
      flags: 'Flags',
      busy: 'Worklet load',
      tier: 'Tier',
      benchK: 'Bench k',
      fixes: 'GPS fixes',
      resets: 'Non-finite resets',
      gpsStatus: 'Status',
      fixAge: 'Fix age',
      parked: 'Parked',
      source: 'Speed source',
      speedUnusable: 'Speed unusable',
      audioState: 'State',
      route: 'Route',
      context: 'AudioContext',
      sampleRate: 'Sample rate',
      baseLatency: 'Base latency',
      outputLatency: 'Output latency',
      latencyHint: 'Latency hint',
      headroom: 'Headroom k',
      recoveries: 'Recoveries',
      overloads: 'Overload events',
      interruptions: 'Interruptions',
      audioErrors: 'Audio errors',
      resetsSession: 'Non-finite resets',
      maxBusy: 'Peak worklet load',
      snapshots: 'Snapshots',
      liteNext: 'Lite next start',
      mcu: 'MCU guess',
      dpr: 'Device pixel ratio',
      viewport: 'Viewport',
      visual: 'Visual viewport',
      screen: 'Screen',
      touch: 'Touch points',
      serviceWorker: 'Service worker',
      build: 'Build',
    },
    /** The app service-worker registration (src/platform/sw-register.ts; 'pending' until it has run after load). */
    swStates: { pending: 'pending', registered: 'registered', unsupported: 'unsupported', failed: 'failed' },
    fixesValue: (accepted: string, rejected: string): string => `${accepted}\u00a0accepted, ${rejected}\u00a0rejected`,
    recoveriesValue: (resumed: number, failed: number, rebuilt: number): string =>
      `${resumed}\u00a0resumed, ${failed}\u00a0failed, ${rebuilt}\u00a0rebuilt`,
    /** A formatted number with its unit; the no-break space (\u00a0) keeps them together when a row wraps. */
    seconds: (v: string): string => `${v}\u00a0s`,
    mps: (v: string): string => `${v}\u00a0m/s`,
    hz: (v: string): string => `${v}\u00a0Hz`,
    ms: (v: string): string => `${v}\u00a0ms`,
    percent: (v: string): string => `${v}\u00a0%`,
    inUnits: (v: string, unit: string): string => `${v}\u00a0${unit}`,
    /** The worklet's speed in m/s and in the display units. */
    speedBoth: (mps: string, inUnits: string): string => `${mps} · ${inUnits}`,
    size: (width: number, height: number): string => `${width} × ${height}`,
    /** One line of the input log, e.g. "t=12.3s media nexttrack: shift up". */
    inputEvent: (seconds: string, source: string, detail: string): string => `t=${seconds}s ${source} ${detail}`,
    /** Input-log details: what an input did. Drive, the wheel test and this screen write the log. */
    log: {
      shiftUp: 'shift up',
      shiftDown: 'shift down',
      valves: (mode: string): string => `valves ${mode}`,
      perspective: (value: string): string => `perspective ${value}`,
      pedal: (throttle: number, brake: number): string => `pedal throttle ${throttle} brake ${brake}`,
      resume: 'resume',
      duplicate: 'duplicate',
      wheelOff: 'wheel shifting off',
      wheelTest: 'wheel test',
      /** "<input>: <what it did>", e.g. "E: shift up", "nexttrack: duplicate". */
      via: (input: string, what: string): string => `${input}: ${what}`,
      /** The keyboard keys and gamepad buttons by action (src/input/keyboard.ts, gamepad.ts). */
      keys: { up: 'E', down: 'Q', valve: 'V', perspective: 'P' },
      pad: { up: 'RB', down: 'LB', valve: 'A', perspective: 'B' },
    },
    qrTitle: 'Diagnostics QR',
    qrPage: (i: number, n: number): string => `QR ${i}/${n}`,
    qrHelp: (bytes: number, n: number): string =>
      `${bytes} bytes in ${n} QR code${n === 1 ? '' : 's'}. Scan every page with your phone, in order.`,
    qrFailed: (message: string): string => `Could not build the QR: ${message}`,
    prev: 'Previous',
    next: 'Next',
    close: 'Close',
  },
} as const;
