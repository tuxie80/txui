import { can } from './engineCaps.ts';
import type { EngineCaps } from './engineCaps.ts';
import { engineGapReason } from './engineGaps.ts';

export type SafeOperationPanel = 'migration' | 'refresh' | 'querylab';

const FEATURES: Record<SafeOperationPanel, {
  capability: keyof EngineCaps;
  label: string;
  reason: string;
}> = {
  migration: {
    capability: 'migrationCockpit', label: 'Migration Cockpit',
    reason: 'table migrations are currently modeled on MySQL/MariaDB and PostgreSQL only',
  },
  refresh: {
    capability: 'environmentRefresh', label: 'Safe Environment Refresh',
    reason: 'the initial implementation plans same-engine MySQL/MariaDB transfers only',
  },
  querylab: {
    capability: 'queryLab', label: 'Query Optimization Lab',
    reason: 'experiments currently support MySQL/MariaDB and PostgreSQL only',
  },
};

export function safeOperationCapability(panel: SafeOperationPanel): keyof EngineCaps {
  return FEATURES[panel].capability;
}

export function safeOperationUnavailableReason(engine: string, panel: SafeOperationPanel): string | null {
  const feature = FEATURES[panel];
  if (can(engine, feature.capability)) return null;
  return engineGapReason(engine, panel)
    ?? `${feature.label} — not available for ${engine}: ${feature.reason}.`;
}
