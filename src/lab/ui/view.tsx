/**
 * The Sound Lab page (phase-2c contract L3): masthead (Start audio, engine, view / tier / bass), the
 * instruments (meter, drive, A/B, export / import) and the voicing panel generated from the schema.
 *
 * Views are hook-free and read the model's signals, so each panel re-renders only for its own signals (the
 * ~20 Hz meter re-renders the meter alone). Number boxes commit on `change` (Enter, or focus leaving) — never
 * per keystroke, so "3" of "3000" is not clamped and a half-typed voicing value is not applied — and while one
 * is focused it is rendered uncontrolled (`defaultValue`), so no re-render overwrites what is being typed.
 * Runtime values reach CSS only as custom properties through CSSOM (CSP: no inline style attributes).
 */
import type { VNode } from 'preact';
import { ENGINES } from '../../data/engines';
import type { LabEvent } from './protocol';
import { SEGMENT_LIST, type LabModel, type SubPreset } from './model';
import { LAB_STR } from './strings';
import { VOICING_SCHEMA, voicingFields, type NumberField, type VoicingField } from './voicing-fields';

interface Props {
  model: LabModel;
}

const SETS = ['euro', 'jdm', 'american', 'exotic'] as const;
/** Level bars span −60…0 dBFS. */
const LEVEL_FLOOR_DB = -60;
/** The stage's true-peak ceiling (−1 dBTP), marked on the peak bar. */
const CEILING_DB = -1;

function minus(text: string): string {
  return text.replace(/^-/, '−');
}

function dbText(db: number | null): string {
  return db === null || db <= -199 ? '—' : `${minus(db.toFixed(1))} dB`;
}

function signedDb(db: number): string {
  return `${db > 0 ? '+' : ''}${minus(db.toFixed(1))} dB`;
}

export function LabView({ model }: Props): VNode {
  return (
    <div class="lab">
      <Masthead model={model} />
      <main class="bench">
        <div class="instruments">
          <NoticeLine model={model} />
          <MeterPanel model={model} />
          <DrivePanel model={model} />
          <ComparePanel model={model} />
          <FilesPanel model={model} />
        </div>
        <VoicingPanel model={model} />
      </main>
      <footer class="foot">{LAB_STR.footer}</footer>
    </div>
  );
}

// ───────────────────────────── masthead ─────────────────────────────

function statusText(model: LabModel): string {
  const state = model.audioState.value;
  switch (state) {
    case 'off':
      return LAB_STR.status.off;
    case 'starting':
      return LAB_STR.status.starting;
    case 'running': {
      const rate = model.sampleRate.value;
      return model.ready.value && rate !== null ? LAB_STR.status.running((rate / 1000).toFixed(1)) : LAB_STR.status.starting;
    }
    case 'suspended':
      return LAB_STR.status.suspended;
    case 'error':
      return LAB_STR.status.error(model.audioMessage.value ?? 'unknown error');
  }
}

function Masthead({ model }: Props): VNode {
  const state = model.audioState.value;
  const engine = model.engine.value;
  const manual = model.drive.value.manual;
  const workletError = model.workletError.value;
  const startLabel = state === 'suspended' ? LAB_STR.resume : state === 'running' ? LAB_STR.audioOn : LAB_STR.start;
  return (
    <header class="masthead">
      <div class="brand">
        <p class="product">{LAB_STR.product}</p>
        <h1>{LAB_STR.title}</h1>
        <p class="tagline">{LAB_STR.tagline}</p>
      </div>
      <div class="power">
        <button
          type="button"
          class="start"
          data-state={state}
          disabled={state === 'starting' || state === 'running'}
          onClick={() => void model.start()}
        >
          {startLabel}
        </button>
        <p class="audio-status" role="status" data-state={state}>
          {statusText(model)}
        </p>
      </div>
      <div class="engine-pick">
        <label for="engine">{LAB_STR.engine}</label>
        <select id="engine" value={engine.id} onChange={(e) => model.selectEngine(e.currentTarget.value)}>
          {SETS.map((set) => (
            <optgroup key={set} label={LAB_STR.sets[set] ?? set}>
              {ENGINES.filter((e) => e.set === set).map((e) => (
                <option key={e.id} value={e.id}>
                  {LAB_STR.engineOption(e.name, e.inspiredBy)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <p class="inspired">{LAB_STR.inspiredBy(engine.inspiredBy)}</p>
      </div>
      <div class="toggles">
        <Choice
          name="perspective"
          legend={LAB_STR.view}
          value={manual.perspective}
          options={[
            ['cabin', LAB_STR.cabin],
            ['outside', LAB_STR.outside],
          ]}
          onPick={(v) => model.setPerspective(v)}
        />
        <Choice
          name="tier"
          legend={LAB_STR.tier}
          value={model.tier.value}
          options={[
            ['full', LAB_STR.full],
            ['lite', LAB_STR.lite],
          ]}
          onPick={(v) => model.setTier(v)}
        />
        <Choice<SubPreset>
          name="bass"
          legend={LAB_STR.bass}
          value={model.sub.value}
          options={[
            ['no-sub', LAB_STR.noSub],
            ['sub', LAB_STR.sub],
          ]}
          onPick={(v) => model.setSub(v)}
        />
      </div>
      {workletError !== null ? (
        <p class="worklet-error" role="alert">
          {LAB_STR.workletError(workletError)}
        </p>
      ) : null}
    </header>
  );
}

interface ChoiceProps<T extends string> {
  name: string;
  legend: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onPick(value: T): void;
}

function Choice<T extends string>({ name, legend, value, options, onPick }: ChoiceProps<T>): VNode {
  return (
    <fieldset class="choice">
      <legend>{legend}</legend>
      <div class="seg">
        {options.map(([v, label]) => (
          <label class="seg-opt" key={v}>
            <input type="radio" name={name} value={v} checked={value === v} onChange={() => onPick(v)} />
            <span>{label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function NoticeLine({ model }: Props): VNode {
  const n = model.notice.value;
  return (
    <p class="notice" role="status" data-kind={n === null ? 'none' : n.kind}>
      {n === null ? '' : n.text}
    </p>
  );
}

// ───────────────────────────── meter ─────────────────────────────

function MeterPanel({ model }: Props): VNode {
  const m = model.meter.value;
  const monitor = model.monitorDb.value;
  return (
    <section
      class="panel meter"
      aria-labelledby="meter-title"
      data-rms-db={m === null ? undefined : String(m.rmsDb)}
      data-peak-db={m === null ? undefined : String(m.peakDb)}
      data-rpm={m === null ? undefined : String(m.rpm)}
      data-gear={m === null ? undefined : String(m.gear)}
    >
      <h2 id="meter-title">{LAB_STR.meter.title}</h2>
      <div class="gauge">
        <p class="tach">
          <output class="tach-value" aria-label={LAB_STR.meter.rpm} aria-live="off">
            {m === null ? '—' : String(Math.round(m.rpm))}
          </output>
          <span class="tach-unit">{LAB_STR.meter.rpm}</span>
        </p>
        <p class="gear-box">
          <span class="gear-label">{LAB_STR.meter.gear}</span>
          <output class="gear-value" aria-label={LAB_STR.meter.gear} aria-live="off">
            {m === null ? '—' : String(m.gear)}
          </output>
        </p>
        <p class="lamp" data-on={m !== null && m.limiter ? 'true' : 'false'}>
          {LAB_STR.meter.limiterLamp}
        </p>
      </div>
      <LevelBar label={LAB_STR.meter.rms} db={m === null ? null : m.rmsDb} ceiling={false} />
      <LevelBar label={LAB_STR.meter.peak} db={m === null ? null : m.peakDb} ceiling />
      <dl class="readouts">
        <div>
          <dt>{LAB_STR.meter.gr}</dt>
          <dd>{m === null ? '—' : `${m.limiterGrDb.toFixed(1)} dB`}</dd>
        </div>
        <div>
          <dt>{LAB_STR.meter.boost}</dt>
          <dd>{m === null ? '—' : `${Math.round(m.boost * 100)} %`}</dd>
        </div>
        <div>
          <dt>{LAB_STR.meter.resets}</dt>
          <dd data-alarm={m !== null && m.nonFiniteResets > 0 ? 'true' : 'false'}>{m === null ? '—' : String(m.nonFiniteResets)}</dd>
        </div>
      </dl>
      <div class="monitor">
        <label for="monitor">{LAB_STR.meter.monitor}</label>
        <input
          id="monitor"
          type="range"
          min={-40}
          max={0}
          step={1}
          value={String(monitor)}
          onInput={(e) => model.setMonitor(Number(e.currentTarget.value))}
        />
        <output for="monitor">{minus(`${monitor} dB`)}</output>
        <p class="hint">{LAB_STR.meter.monitorHint}</p>
      </div>
    </section>
  );
}

function LevelBar({ label, db, ceiling }: { label: string; db: number | null; ceiling: boolean }): VNode {
  const shown = db === null ? LEVEL_FLOOR_DB : Math.min(0, Math.max(LEVEL_FLOOR_DB, db));
  const frac = (shown - LEVEL_FLOOR_DB) / -LEVEL_FLOOR_DB;
  return (
    <div class="level">
      <span class="level-label">{label}</span>
      <div
        class="level-track"
        role="meter"
        aria-label={label}
        aria-valuemin={LEVEL_FLOOR_DB}
        aria-valuemax={0}
        aria-valuenow={Math.round(shown * 10) / 10}
        style={{ '--level': frac.toFixed(4), '--ceiling': ((CEILING_DB - LEVEL_FLOOR_DB) / -LEVEL_FLOOR_DB).toFixed(4) }}
      >
        {ceiling ? <span class="level-ceiling" title="−1 dBTP ceiling" /> : null}
      </div>
      <span class="level-value">{dbText(db)}</span>
    </div>
  );
}

// ───────────────────────────── drive ─────────────────────────────

const EVENT_BUTTONS: readonly { ev: LabEvent; label: string; key: string }[] = [
  { ev: 'upshift', label: LAB_STR.drive.upshift, key: 'E' },
  { ev: 'downshift', label: LAB_STR.drive.downshift, key: 'Q' },
  { ev: 'liftoff', label: LAB_STR.drive.liftoff, key: 'Space' },
  { ev: 'limiter', label: LAB_STR.drive.limiter, key: 'L' },
  { ev: 'ignition', label: LAB_STR.drive.ignition, key: '' },
];

function DrivePanel({ model }: Props): VNode {
  const d = model.drive.value;
  const m = d.manual;
  const spec = model.engine.value.spec;
  const live = model.canDrive.value;
  const playing = d.segment;
  const gears = spec.gearbox.overallRatios.length;
  const pressed: Partial<Record<LabEvent, boolean>> = { liftoff: d.liftoff, limiter: d.limiterHold, ignition: d.ignitionOn };
  const playingInfo = SEGMENT_LIST.find((s) => s.name === playing);
  return (
    <section class="panel drive" aria-labelledby="drive-title">
      <h2 id="drive-title">{LAB_STR.drive.title}</h2>
      <Slider
        model={model}
        id="drive-rpm"
        label={LAB_STR.drive.rpm}
        unit="rpm"
        min={spec.rpm.idle}
        max={spec.rpm.limiter.rpm}
        step={10}
        value={m.rpm}
        onValue={(v) => model.setRpm(v)}
      />
      <Slider
        model={model}
        id="drive-load"
        label={LAB_STR.drive.load}
        unit=""
        min={-1}
        max={1}
        step={0.01}
        value={m.load}
        onValue={(v) => model.setLoad(v)}
        hint={LAB_STR.drive.loadHint}
      />
      <div class="drive-row">
        <label class="pick">
          <span>{LAB_STR.drive.gear}</span>
          <select value={String(m.gear)} onChange={(e) => model.setGear(Number(e.currentTarget.value))}>
            {Array.from({ length: gears }, (_, i) => (
              <option key={i} value={String(i + 1)}>
                {String(i + 1)}
              </option>
            ))}
          </select>
        </label>
        <label class="pick">
          <span>{LAB_STR.drive.valve}</span>
          <select value={m.valve} onChange={(e) => model.setValve(e.currentTarget.value as typeof m.valve)}>
            {(['auto', 'open', 'closed'] as const).map((v) => (
              <option key={v} value={v}>
                {LAB_STR.drive.valves[v] ?? v}
              </option>
            ))}
          </select>
        </label>
        <label class="pick">
          <span>{LAB_STR.drive.driveMode}</span>
          <select value={m.driveMode} onChange={(e) => model.setDriveMode(e.currentTarget.value as typeof m.driveMode)}>
            {(['comfort', 'sport'] as const).map((v) => (
              <option key={v} value={v}>
                {LAB_STR.drive.modes[v] ?? v}
              </option>
            ))}
          </select>
        </label>
        <label class="check">
          <input type="checkbox" checked={m.warm} onChange={(e) => model.setWarm(e.currentTarget.checked)} />
          <span>{LAB_STR.drive.warm}</span>
        </label>
      </div>
      <div class="events" role="group" aria-label="Events">
        {EVENT_BUTTONS.map((b) => {
          const p = pressed[b.ev];
          return (
            <button
              key={b.ev}
              type="button"
              class="event"
              aria-pressed={p === undefined ? undefined : p ? 'true' : 'false'}
              disabled={!live || (playing !== null && b.ev !== 'ignition')}
              onClick={() => model.fire(b.ev)}
            >
              {b.label}
              {b.key !== '' ? <kbd>{b.key}</kbd> : null}
            </button>
          );
        })}
      </div>
      <div class="segment-row">
        <label class="pick">
          <span>{LAB_STR.drive.segment}</span>
          <select
            value={model.segmentChoice.value}
            onChange={(e) => {
              model.segmentChoice.value = e.currentTarget.value;
            }}
          >
            {SEGMENT_LIST.map((s) => (
              <option key={s.name} value={s.name}>
                {`${s.name} (${s.durationS} s)`}
              </option>
            ))}
          </select>
        </label>
        <button type="button" disabled={!live} onClick={() => model.playSegment()}>
          {LAB_STR.drive.play}
        </button>
        <button type="button" disabled={playing === null} onClick={() => model.stopSegment()}>
          {LAB_STR.drive.stop}
        </button>
      </div>
      <p class="drive-state" data-segment={playing ?? ''}>
        {playingInfo !== undefined
          ? LAB_STR.drive.playing(playingInfo.name, playingInfo.durationS)
          : live
            ? LAB_STR.drive.manual
            : LAB_STR.drive.needsAudio}
      </p>
      <dl class="keys" aria-label={LAB_STR.drive.keysTitle}>
        {LAB_STR.keys.map(([k, what]) => (
          <div key={k}>
            <dt>
              {k.split(' ').map((part) => (
                <kbd key={part}>{part}</kbd>
              ))}
            </dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

interface SliderProps {
  model: LabModel;
  id: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onValue(v: number): void;
  hint?: string;
}

function driveText(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}

/**
 * Drive slider + number box. The box commits on change and is uncontrolled while focused, so after a commit
 * it is given the clamped value itself (the control clamps rpm to [idle, limiter], load to [−1, 1]).
 */
function Slider({ model, id, label, unit, min, max, step, value, onValue, hint }: SliderProps): VNode {
  const typing = model.editing.value === id;
  const text = driveText(value);
  return (
    <div class="slider">
      <label for={id}>{label}</label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={String(Math.min(max, Math.max(min, value)))}
        aria-label={`${label} slider`}
        onInput={(e) => onValue(Number(e.currentTarget.value))}
      />
      <span class="box">
        <input
          id={id}
          type="number"
          min={min}
          max={max}
          step="any"
          aria-label={label}
          {...(typing ? { defaultValue: text } : { value: text })}
          onFocus={() => {
            model.editing.value = id;
          }}
          onBlur={() => {
            if (model.editing.peek() === id) model.editing.value = null;
          }}
          onChange={(e) => {
            const box = e.currentTarget;
            commit(box.value, (v) => {
              const clamped = Math.min(max, Math.max(min, v));
              onValue(clamped);
              box.value = driveText(clamped);
            });
          }}
        />
        {unit !== '' ? <span class="unit">{unit}</span> : null}
      </span>
      {hint !== undefined ? <p class="hint">{hint}</p> : null}
    </div>
  );
}

/** A committed number box: blank or not a number changes nothing. */
function commit(raw: string, onValue: (v: number) => void): void {
  if (raw.trim() === '') return;
  const v = Number(raw);
  if (Number.isFinite(v)) onValue(v);
}

// ───────────────────────────── A/B ─────────────────────────────

function ComparePanel({ model }: Props): VNode {
  const ref = model.ref.value;
  const side = model.ab.value;
  const match = model.match.value;
  const live = model.canDrive.value;
  return (
    <section class="panel compare" aria-labelledby="compare-title">
      <h2 id="compare-title">{LAB_STR.compare.title}</h2>
      <label class="file-pick">
        <span>{LAB_STR.compare.pick}</span>
        <input
          type="file"
          accept="audio/*"
          disabled={model.refLoading.value}
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            if (file !== undefined) void model.loadReference(file);
          }}
        />
      </label>
      <p class="ref-info">
        {ref === null ? LAB_STR.compare.empty : LAB_STR.compare.info(ref.name, ref.durationS.toFixed(2), minus(ref.rmsDb.toFixed(1)))}
      </p>
      <div class="ab-row">
        <button
          type="button"
          class="ab"
          data-side={side}
          aria-pressed={side === 'B' ? 'true' : 'false'}
          disabled={ref === null}
          onClick={() => model.toggleAb()}
        >
          {LAB_STR.compare.ab}
          <kbd>B</kbd>
        </button>
        <p class="ab-side" data-side={side}>
          <span class="side-a">{LAB_STR.compare.sideA}</span>
          <span class="side-b">{LAB_STR.compare.sideB}</span>
        </p>
        <button type="button" disabled={ref === null || !live} onClick={() => model.matchLevel()}>
          {LAB_STR.compare.match}
        </button>
      </div>
      {match !== null ? <p class="match">{LAB_STR.compare.matched(signedDb(match.refGainDb), signedDb(match.labGainDb))}</p> : null}
    </section>
  );
}

// ───────────────────────────── export / import ─────────────────────────────

function FilesPanel({ model }: Props): VNode {
  const preview = model.exportPreview.value;
  return (
    <section class="panel files" aria-labelledby="files-title">
      <h2 id="files-title">{LAB_STR.files.title}</h2>
      <div class="file-actions">
        <button type="button" onClick={() => model.exportFile()}>
          {LAB_STR.files.download}
        </button>
        <button type="button" onClick={() => void model.copyExport()}>
          {LAB_STR.files.copy}
        </button>
        <label class="file-pick">
          <span>{LAB_STR.files.import}</span>
          <input
            type="file"
            accept=".json,application/json"
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              if (file !== undefined) void model.importFile(file);
            }}
          />
        </label>
      </div>
      <p class="hint">{LAB_STR.files.howTo}</p>
      <details class="json">
        <summary>{LAB_STR.files.show}</summary>
        <textarea readOnly rows={14} aria-label="Voicing JSON" value={preview.ok ? preview.text : preview.problems.map((p) => p.message).join('\n')} />
      </details>
    </section>
  );
}

// ───────────────────────────── voicing ─────────────────────────────

/** A field is flagged when a problem names it or one of its containers (`headersM` flags every header). */
function flaggedBy(keys: readonly string[], key: string): boolean {
  return keys.some((k) => k === key || key.startsWith(`${k}.`) || key.startsWith(`${k}[`));
}

function VoicingPanel({ model }: Props): VNode {
  const engine = model.engine.value;
  const groups = voicingFields(model.draft.value, VOICING_SCHEMA, engine.voicing);
  const problems = model.problems.value;
  const keys = problems.map((p) => p.key).filter((k): k is string => k !== null);
  const state = model.applyState.value;
  return (
    <section class="panel voicing" aria-labelledby="voicing-title">
      <div class="voicing-head">
        <h2 id="voicing-title">{LAB_STR.voicing.title}</h2>
        <p class="apply-state" data-state={state}>
          {LAB_STR.voicing.state[state] ?? state}
        </p>
        <div class="voicing-actions">
          <button type="button" onClick={() => model.resetToEngine()}>
            {LAB_STR.voicing.resetEngine}
          </button>
          <button type="button" onClick={() => model.resetToDefault()}>
            {LAB_STR.voicing.resetDefault}
          </button>
        </div>
      </div>
      {problems.length > 0 ? (
        <div class="flag" role="alert">
          <p>{LAB_STR.voicing.flagged}</p>
          <ul>
            {problems.map((p, i) => (
              <li key={i}>{p.message}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div class="groups">
        {groups.map((g) => (
          <fieldset class="group" key={g.key}>
            <legend>{g.key}</legend>
            {g.fields.map((f) => (
              <FieldRow key={f.key} model={model} field={f} invalid={flaggedBy(keys, f.key)} />
            ))}
          </fieldset>
        ))}
      </div>
    </section>
  );
}

function FieldRow({ model, field, invalid }: { model: LabModel; field: VoicingField; invalid: boolean }): VNode {
  const id = `v-${field.key}`;
  const flag = invalid ? 'true' : 'false';
  switch (field.kind) {
    case 'number':
      return <NumberRow model={model} f={field} invalid={invalid} />;
    case 'boolean':
      return (
        <div class="field check" data-key={field.key} data-invalid={flag}>
          <input
            id={id}
            type="checkbox"
            aria-label={field.key}
            checked={field.value}
            disabled={!field.editable}
            onChange={(e) => model.editField(field.path, e.currentTarget.checked)}
          />
          <label for={id}>{field.label}</label>
          {!field.editable ? <span class="hint">{LAB_STR.voicing.estimatedHint}</span> : null}
        </div>
      );
    case 'enum':
      return (
        <div class="field pick" data-key={field.key} data-invalid={flag}>
          <label for={id}>{field.label}</label>
          <select id={id} aria-label={field.key} value={field.value} onChange={(e) => model.editField(field.path, e.currentTarget.value)}>
            {field.options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </div>
      );
    case 'absent':
      return (
        <p class="field absent" data-key={field.key} data-invalid={flag}>
          <span class="field-name">{field.label}</span>
          <span class="hint">{LAB_STR.voicing.absent}</span>
        </p>
      );
  }
}

function NumberRow({ model, f, invalid }: { model: LabModel; f: NumberField; invalid: boolean }): VNode {
  const id = `v-${f.key}`;
  const typing = model.editing.value === f.key;
  const text = String(f.value);
  return (
    <div class="field number" data-key={f.key} data-invalid={invalid ? 'true' : 'false'}>
      <label class="field-name" for={id}>
        {f.label}
        {f.unit !== '' ? <span class="unit">{f.unit}</span> : null}
      </label>
      <input
        type="range"
        min={f.min}
        max={f.max}
        step={f.step}
        value={String(Math.min(f.max, Math.max(f.min, f.value)))}
        aria-label={`${f.key} slider`}
        onInput={(e) => model.editField(f.path, Number(e.currentTarget.value))}
      />
      <input
        id={id}
        type="number"
        min={f.min}
        max={f.max}
        step={f.integer ? 1 : 'any'}
        aria-label={f.key}
        aria-invalid={invalid ? 'true' : undefined}
        {...(typing ? { defaultValue: text } : { value: text })}
        onFocus={() => {
          model.editing.value = f.key;
        }}
        onBlur={() => {
          if (model.editing.peek() === f.key) model.editing.value = null;
        }}
        onChange={(e) => commit(e.currentTarget.value, (v) => model.editField(f.path, v))}
      />
    </div>
  );
}
