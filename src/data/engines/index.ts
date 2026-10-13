import type { EngineDef } from '../../contracts';
import flat4Turbo25 from './flat4-turbo-25.json';
import flat6Na40 from './flat6-na-40.json';
import i4Turbo20 from './i4-turbo-20.json';
import i5Turbo25 from './i5-turbo-25.json';
import i6Twinturbo30 from './i6-twinturbo-30.json';
import rotaryTwin13 from './rotary-twin-13.json';
import v6Twinturbo38 from './v6-twinturbo-38.json';
import v8Flatplane45 from './v8-flatplane-45.json';
import v8Na50 from './v8-na-50.json';
import v8Na62 from './v8-na-62.json';
import v8Sc62 from './v8-sc-62.json';
import v8Twinturbo40 from './v8-twinturbo-40.json';
import v10Na48 from './v10-na-48.json';
import v10Na52 from './v10-na-52.json';
import v12Na65 from './v12-na-65.json';

/** JSON imports widen literal unions to string; engine.schema.json (tests) is the real guard. */
function def(json: unknown): EngineDef {
  return json as EngineDef;
}

/** Starter garage, in spec §5.5 order: euro, jdm, american, exotic. */
export const ENGINES: EngineDef[] = [
  def(i5Turbo25),
  def(flat6Na40),
  def(v10Na52),
  def(i4Turbo20),
  def(i6Twinturbo30),
  def(rotaryTwin13),
  def(flat4Turbo25),
  def(v6Twinturbo38),
  def(v8Na50),
  def(v8Na62),
  def(v8Sc62),
  def(v12Na65),
  def(v8Flatplane45),
  def(v10Na48),
  def(v8Twinturbo40),
];

export function getEngine(id: string): EngineDef {
  const found = ENGINES.find((e) => e.id === id);
  if (found === undefined) {
    throw new Error(`Unknown engine id "${id}"`);
  }
  return found;
}
