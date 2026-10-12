/**
 * Ad-hoc Galera cluster members — the "Monitor once" hand-off from the Galera
 * tab's discovery banner to the cluster panel. The banner builds one
 * id-preserving config clone per unsaved member (utils/galeraDiscover.ts
 * buildAdhocConfig) and parks them here; the cluster panel picks them up on
 * mount and polls them through `galera_cluster_poll`'s adhocConfigs.
 *
 * Module-level and deliberately NOT persisted, like the prod ack: monitoring
 * unsaved nodes is a this-app-run decision, and a stale set resurrected on
 * the next launch would poll servers nobody asked about.
 */
import type { ConnectionConfig } from '../types';

let adhoc: ConnectionConfig[] = [];

export function setGaleraAdhoc(configs: ConnectionConfig[]): void {
  adhoc = configs;
}

export function getGaleraAdhoc(): ConnectionConfig[] {
  return adhoc;
}

export function clearGaleraAdhoc(): void {
  adhoc = [];
}
