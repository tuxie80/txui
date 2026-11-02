export interface ColumnLayout {
  order: string[];
  pinned: string[];
  hidden: string[];
}

export interface LayoutColumn {
  name: string;
  index: number;
}

export type ColumnLayoutAction =
  | { kind: 'pin'; column: string }
  | { kind: 'hide'; column: string }
  | { kind: 'move'; column: string; direction: -1 | 1 }
  | { kind: 'reset' };

export function normalizeLayout(names: readonly string[], layout?: Partial<ColumnLayout>): ColumnLayout {
  const valid = new Set(names);
  const order = [...new Set(layout?.order ?? [])].filter(name => valid.has(name));
  for (const name of names) if (!order.includes(name)) order.push(name);
  return {
    order,
    pinned: [...new Set(layout?.pinned ?? [])].filter(name => valid.has(name)),
    hidden: [...new Set(layout?.hidden ?? [])].filter(name => valid.has(name)),
  };
}

export function layoutColumns(names: readonly string[], layout?: Partial<ColumnLayout>): LayoutColumn[] {
  const normalized = normalizeLayout(names, layout);
  const hidden = new Set(normalized.hidden);
  const pinned = new Set(normalized.pinned);
  return normalized.order
    .filter(name => !hidden.has(name))
    .sort((a, b) => Number(pinned.has(b)) - Number(pinned.has(a)))
    .map(name => ({ name, index: names.indexOf(name) }));
}

export function columnLayoutReducer(names: readonly string[], current: ColumnLayout, action: ColumnLayoutAction): ColumnLayout {
  const layout = normalizeLayout(names, current);
  if (action.kind === 'reset') return normalizeLayout(names);
  if (action.kind === 'pin') {
    const pinned = layout.pinned.includes(action.column)
      ? layout.pinned.filter(name => name !== action.column)
      : [...layout.pinned, action.column];
    return { ...layout, pinned, hidden: layout.hidden.filter(name => name !== action.column) };
  }
  if (action.kind === 'hide') {
    return {
      ...layout,
      pinned: layout.pinned.filter(name => name !== action.column),
      hidden: layout.hidden.includes(action.column) ? layout.hidden : [...layout.hidden, action.column],
    };
  }
  const order = layout.order.filter(name => !layout.pinned.includes(name));
  const from = order.indexOf(action.column);
  if (from < 0) return layout;
  const to = Math.max(0, Math.min(order.length - 1, from + action.direction));
  if (from === to) return layout;
  order.splice(to, 0, order.splice(from, 1)[0]);
  return { ...layout, order: [...layout.pinned, ...order] };
}

function layoutKey(engine: string | undefined, names: readonly string[]): string {
  return `dbgui.columnlayout.v1.${engine ?? 'unknown'}.${names.join('|')}`;
}

export function loadColumnLayout(engine: string | undefined, names: readonly string[], storage?: Storage): ColumnLayout {
  const target = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage);
  if (!target) return normalizeLayout(names);
  try {
    const raw = target.getItem(layoutKey(engine, names));
    return raw ? normalizeLayout(names, JSON.parse(raw) as Partial<ColumnLayout>) : normalizeLayout(names);
  } catch {
    return normalizeLayout(names);
  }
}

export function saveColumnLayout(engine: string | undefined, names: readonly string[], layout: ColumnLayout, storage?: Storage): void {
  const target = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage);
  if (!target) return;
  try {
    target.setItem(layoutKey(engine, names), JSON.stringify(normalizeLayout(names, layout)));
  } catch { /* layout persistence is optional and quota must not break the grid */ }
}
