/**
 * Favorites (starred connections), in localStorage.
 *
 * Purely a UI convenience layer keyed by connection id — no ConnectionConfig or
 * backend change. The Sidebar pins the starred set at the top for one-click
 * access to the 3–4 databases you actually use. (A "recently opened" MRU
 * section used to sit next to it; the owner found it hurt orientation more
 * than it helped, so it was removed — favorites carry the feature alone.)
 */
import { useEffect, useState } from 'react';

const FAV_KEY = 'dbgui.favorites.v1';
const EVT = 'dbgui:favorites-changed';

function read<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : fallback; }
  catch { return fallback; }
}
function write(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota */ }
  window.dispatchEvent(new Event(EVT));
}

export function favoriteIds(): string[] { return read<string[]>(FAV_KEY, []); }
export function isFavorite(id: string): boolean { return favoriteIds().includes(id); }

export function toggleFavorite(id: string): void {
  const set = new Set(favoriteIds());
  if (set.has(id)) set.delete(id); else set.add(id);
  write(FAV_KEY, [...set]);
}

/** Drop ids that no longer exist (called when the connection list loads). */
export function pruneFavorites(existing: Set<string>): void {
  const fav = favoriteIds().filter(id => existing.has(id));
  if (fav.length !== favoriteIds().length) write(FAV_KEY, fav);
}

/** Re-render the caller whenever favorites change. */
export function useConnFavorites(): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const on = () => setTick(t => t + 1);
    window.addEventListener(EVT, on);
    return () => window.removeEventListener(EVT, on);
  }, []);
}
