import type { AvatarKey } from '../db/types';
import goatUrl from '../../assets/avatars/goat.svg';
import ibexUrl from '../../assets/avatars/ibex.svg';
import snowLeopardUrl from '../../assets/avatars/snow-leopard.svg';
import eagleUrl from '../../assets/avatars/eagle.svg';
import wolfUrl from '../../assets/avatars/wolf.svg';

// The five profile avatars — stylized animals that embody training for
// alpinism. Keys must stay in sync with the profiles.avatar_key CHECK
// constraint (phase9) and the allowlist in api/profile.ts.

export const AVATARS: Record<AvatarKey, { label: string; src: string }> = {
  'goat':         { label: 'Mountain Goat', src: goatUrl },
  'ibex':         { label: 'Ibex',          src: ibexUrl },
  'snow-leopard': { label: 'Snow Leopard',  src: snowLeopardUrl },
  'eagle':        { label: 'Golden Eagle',  src: eagleUrl },
  'wolf':         { label: 'Wolf',          src: wolfUrl },
};

export const AVATAR_KEYS = Object.keys(AVATARS) as AvatarKey[];

export function avatarSrc(key: AvatarKey | null | undefined): string {
  return AVATARS[key ?? 'goat']?.src ?? AVATARS.goat.src;
}
