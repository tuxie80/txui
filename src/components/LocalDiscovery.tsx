import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { errorDisplay } from '../utils/appError';
import type { ConnectionConfig } from '../types';
import {
  alreadySaved, discoveryPrefill, discoveryName,
} from '../utils/connDiscovery';
import type { DiscoveredService } from '../utils/connDiscovery';
import { EngineLogo } from './engineLogos';

interface Props {
  /** Saved configs — a service that already has one is not offered again. */
  existing: ConnectionConfig[];
  /** Open the connection form prefilled for this service. */
  onAdd: (prefill: Partial<ConnectionConfig>) => void;
}

/**
 * "Scan this machine" (W5.3, RedisInsight-style): probe the well-known ports
 * on localhost (`discover_local_services`) and offer what answered as
 * one-click connection rows — engine, 127.0.0.1 and port prefilled, the rest
 * left to the engine-default placeholders.
 *
 * Deliberately quiet: a click away (nothing probes until asked), a "nothing
 * found" line instead of a fanfare, and services already saved are named as
 * such rather than re-offered.
 */
export function LocalDiscovery({ existing, onAdd }: Props) {
  const [scanning, setScanning] = useState(false);
  /** null = never scanned; a scan that found nothing is a real answer. */
  const [found, setFound] = useState<DiscoveredService[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function scan() {
    setScanning(true);
    setError(null);
    try {
      setFound(await invoke<DiscoveredService[]>('discover_local_services'));
    } catch (err) {
      setFound(null);
      setError(errorDisplay(err));
    } finally {
      setScanning(false);
    }
  }

  return (
    <div className="discover">
      <button className="toolbar-btn" disabled={scanning} onClick={() => void scan()}>
        {scanning ? 'Scanning…' : found === null ? 'Scan this machine' : 'Scan again'}
      </button>
      {error && <p className="discover-note">Scan failed — {error}</p>}
      {found !== null && found.length === 0 && !error && (
        <p className="discover-note">
          Nothing answered on the usual ports (3306 · 5432 · 6379 · 8123 · 27017 · 1433).
        </p>
      )}
      {found !== null && found.length > 0 && (
        <div className="discover-list">
          {found.map(s => {
            const saved = alreadySaved(s, existing);
            return (
              <div key={`${s.engine}:${s.port}`} className="discover-row">
                <span className="engine-icon"><EngineLogo engine={s.engine} size={14} /></span>
                <span className="discover-name" title={s.detail || undefined}>
                  {discoveryName(s)}
                </span>
                {saved ? (
                  <span className="discover-note">already saved</span>
                ) : (
                  <button className="toolbar-btn" onClick={() => onAdd(discoveryPrefill(s))}>
                    Add
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
