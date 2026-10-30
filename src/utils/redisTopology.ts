import type { Engine } from '../types';

export function sentinelMasterConfig(engine: Engine, value: string): string | null {
  if (engine !== 'redis') return null;
  return value.trim() || null;
}
