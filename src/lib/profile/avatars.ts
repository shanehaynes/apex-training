import type { AvatarKey } from '../db/types';
import goatUrl from '../../assets/avatars/goat.svg';
import ibexUrl from '../../assets/avatars/ibex.svg';
import snowLeopardUrl from '../../assets/avatars/snow-leopard.svg';
import eagleUrl from '../../assets/avatars/eagle.svg';
import wolfUrl from '../../assets/avatars/wolf.svg';
import bighornUrl from '../../assets/avatars/bighorn.svg';
import marmotUrl from '../../assets/avatars/marmot.svg';
import ravenUrl from '../../assets/avatars/raven.svg';
import lynxUrl from '../../assets/avatars/lynx.svg';
import foxUrl from '../../assets/avatars/fox.svg';
import bearUrl from '../../assets/avatars/bear.svg';
import owlUrl from '../../assets/avatars/owl.svg';
import falconUrl from '../../assets/avatars/falcon.svg';
import pikaUrl from '../../assets/avatars/pika.svg';
import elkUrl from '../../assets/avatars/elk.svg';
import wolverineUrl from '../../assets/avatars/wolverine.svg';
import cougarUrl from '../../assets/avatars/cougar.svg';
import chamoisUrl from '../../assets/avatars/chamois.svg';
import yakUrl from '../../assets/avatars/yak.svg';
import hareUrl from '../../assets/avatars/hare.svg';
import orcaUrl from '../../assets/avatars/orca.svg';
import sealUrl from '../../assets/avatars/seal.svg';
import otterUrl from '../../assets/avatars/otter.svg';
import octopusUrl from '../../assets/avatars/octopus.svg';

// The twenty-four profile avatars — stylized animals in a flat badge
// style. Keys must stay in sync with the profiles.avatar_key CHECK
// constraint (phase14) and the allowlist in api/profile.ts.

export const AVATARS: Record<AvatarKey, { label: string; src: string }> = {
  'goat':         { label: 'Mountain Goat',      src: goatUrl },
  'ibex':         { label: 'Ibex',               src: ibexUrl },
  'snow-leopard': { label: 'Snow Leopard',       src: snowLeopardUrl },
  'eagle':        { label: 'Golden Eagle',       src: eagleUrl },
  'wolf':         { label: 'Wolf',               src: wolfUrl },
  'bighorn':      { label: 'Bighorn Ram',        src: bighornUrl },
  'marmot':       { label: 'Marmot',             src: marmotUrl },
  'raven':        { label: 'Raven',              src: ravenUrl },
  'lynx':         { label: 'Lynx',               src: lynxUrl },
  'fox':          { label: 'Red Fox',            src: foxUrl },
  'bear':         { label: 'Grizzly Bear',       src: bearUrl },
  'owl':          { label: 'Great Horned Owl',   src: owlUrl },
  'falcon':       { label: 'Peregrine Falcon',   src: falconUrl },
  'pika':         { label: 'Pika',               src: pikaUrl },
  'elk':          { label: 'Elk',                src: elkUrl },
  'wolverine':    { label: 'Wolverine',          src: wolverineUrl },
  'cougar':       { label: 'Cougar',             src: cougarUrl },
  'chamois':      { label: 'Chamois',            src: chamoisUrl },
  'yak':          { label: 'Yak',                src: yakUrl },
  'hare':         { label: 'Snowshoe Hare',      src: hareUrl },
  'orca':         { label: 'Orca',               src: orcaUrl },
  'seal':         { label: 'Harbor Seal',        src: sealUrl },
  'otter':        { label: 'River Otter',        src: otterUrl },
  'octopus':      { label: 'Octopus',            src: octopusUrl },
};

export const AVATAR_KEYS = Object.keys(AVATARS) as AvatarKey[];

export function avatarSrc(key: AvatarKey | null | undefined): string {
  return AVATARS[key ?? 'goat']?.src ?? AVATARS.goat.src;
}
