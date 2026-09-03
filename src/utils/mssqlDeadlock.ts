/**
 * SQL Server deadlock reports → the same graph MySQL's InnoDB reports produce.
 *
 * SQL Server is the best of the three engines here and it is not close. MySQL
 * exposes only the **latest** deadlock, and it is gone the moment another one
 * happens. PostgreSQL publishes a per-database *counter* and writes the detail
 * to the server log, where the app cannot reach it. SQL Server keeps a
 * **history** of complete deadlock graphs in the `system_health` Extended
 * Events session, which runs by default on every instance — so the panel can
 * show a deadlock from last Tuesday, with both statements and the exact lock.
 *
 * ## Two places to look, and the obvious one is often empty
 *
 * `system_health` writes to two targets. The **ring buffer** has it
 * immediately; the **event file** holds far more history but buffers writes, so
 * `sys.fn_xe_file_target_read_file` can return **zero rows seconds after a
 * deadlock you just caused** — measured, not theorised. Reading only the file
 * target makes the panel look broken exactly when someone is testing it, so
 * `MSSQL_DEADLOCK_SQL` reads the ring buffer and the caller merges.
 *
 * Both queries use XML methods, which require `QUOTED_IDENTIFIER ON`. The
 * driver sets it (pinned by a live test); anything else running these by hand
 * needs it too, or the answer is Msg 1934 rather than a deadlock.
 *
 * ## Why regex and not DOMParser
 *
 * `DOMParser` does not exist under `node --test`, and this module is worth
 * testing against a captured report far more than it is worth using a DOM. The
 * report is machine-generated and rigidly shaped, so targeted patterns are
 * sound here in a way they would not be for user-authored XML.
 *
 * Pure: no server, no DOM. The fixture in `tests/fixtures/` is a real report
 * from SQL Server 2022.
 */
import type { DeadlockGraph, DeadlockLock, DeadlockTxn, DeadlockEdge } from './deadlockGraph.ts';
import { findCycle } from './deadlockGraph.ts';

/**
 * The most recent deadlock reports, newest first, from the ring buffer.
 *
 * `system_health` is on by default, so this needs no setup — only
 * VIEW SERVER STATE.
 */
export const MSSQL_DEADLOCK_SQL = `
SELECT TOP 20 CAST(x.evt.query('.') AS nvarchar(max)) AS report,
       x.evt.value('@timestamp', 'datetime2') AS captured_at
FROM (SELECT CAST(t.target_data AS xml) AS td
      FROM sys.dm_xe_session_targets t
      JOIN sys.dm_xe_sessions s ON s.address = t.event_session_address
      WHERE s.name = 'system_health' AND t.target_name = 'ring_buffer') r
CROSS APPLY r.td.nodes('//event[@name="xml_deadlock_report"]') AS x(evt)
ORDER BY captured_at DESC`.trim();

/** Attributes of one element, as a map. */
function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w-]+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

/** XML text → the characters it stands for. */
function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x0?D;/gi, '\r').replace(/&#x0?A;/gi, '\n')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');   // last, or an escaped &amp;lt; decodes twice
}

/**
 * One lock from the resource list.
 *
 * `objectname` is already `db.schema.table`, which is what the MySQL side calls
 * `table` — the shapes line up without translation. A parallelism deadlock
 * (`exchangeEvent`) has no object at all; it is named for what it is rather
 * than dropped, because a deadlock the panel cannot draw is still one the user
 * needs to know happened.
 */
function lockFrom(kind: string, a: Record<string, string>, mode: string): DeadlockLock {
  const table = a.objectname
    ?? (kind === 'exchangeEvent' ? `parallelism (${a.waitType ?? 'exchange'})` : kind);
  return {
    kind: kind === 'objectlock' ? 'table' : 'record',
    table,
    index: a.indexname ?? null,
    mode: mode || a.mode || '',
    modeShort: (mode || a.mode || '').split(/\s+/)[0] ?? '',
  };
}

/**
 * Parse one `<deadlock>` report.
 *
 * Returns null for anything that is not one, so a caller can hand it whatever
 * the query returned without pre-checking.
 */
export function parseMssqlDeadlock(
  xml: string | null | undefined,
  capturedAt?: string,
): DeadlockGraph | null {
  if (!xml || !xml.includes('<deadlock')) return null;
  const raw = xml;

  // ── processes, in report order; the ordinal is 1-based like InnoDB's ──
  const byId = new Map<string, DeadlockTxn>();
  const order: string[] = [];
  // Both forms: `<process …>…</process>` and the self-closing `<process …/>`.
  // A process with no execution stack or input buffer is legal XML, and
  // matching only the paired form dropped it from the graph entirely — an
  // edge pointing at a transaction that is not in the list.
  const procRe = /<process\s([^>]*?)(?:\/>|>([\s\S]*?)<\/process>)/g;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = procRe.exec(xml)) !== null) {
    const a = attrs(m[1]);
    const body = m[2] ?? '';
    const id = a.id ?? `p${n}`;
    const inputbuf = /<inputbuf>([\s\S]*?)<\/inputbuf>/.exec(body)?.[1] ?? '';
    // The status line is assembled from the parts that answer "what was it
    // doing": suspended/running, how long the transaction had been open, and
    // its isolation level — the same job InnoDB's ACTIVE line does.
    const bits = [
      a.status,
      a.transactionname ? `transaction "${a.transactionname}"` : null,
      a.trancount && a.trancount !== '0' ? `trancount ${a.trancount}` : null,
      a.isolationlevel,
      a.waittime ? `waiting ${a.waittime} ms` : null,
    ].filter(Boolean);
    byId.set(id, {
      ordinal: ++n,
      trxId: a.xactid ?? null,
      status: bits.length ? bits.join(' · ') : null,
      threadId: a.spid ?? null,
      host: [a.hostname, a.clientapp].filter(Boolean).join(' / ') || null,
      user: a.loginname ?? null,
      query: unescapeXml(inputbuf).trim() || null,
      holds: [],
      waitingFor: null,
    });
    order.push(id);
  }
  if (byId.size === 0) return null;

  // ── resources: who holds what, and who is queued behind them ──
  const edges: DeadlockEdge[] = [];
  const resRe = /<(keylock|pagelock|objectlock|ridlock|rowgrouplock|hobtlock|exchangeEvent)\s([^>]*?)>([\s\S]*?)<\/\1>/g;
  while ((m = resRe.exec(xml)) !== null) {
    const kind = m[1];
    const a = attrs(m[2]);
    const body = m[3];
    const owners = [...body.matchAll(/<owner\s([^/>]*?)\/?>/g)].map(o => attrs(o[1]));
    const waiters = [...body.matchAll(/<waiter\s([^/>]*?)\/?>/g)].map(w => attrs(w[1]));

    for (const o of owners) {
      const t = o.id ? byId.get(o.id) : undefined;
      if (t) t.holds.push(lockFrom(kind, a, o.mode ?? ''));
    }
    for (const w of waiters) {
      const from = w.id ? byId.get(w.id) : undefined;
      if (!from) continue;
      const lock = lockFrom(kind, a, w.mode ?? '');
      // A transaction can queue on several resources; the first is the one the
      // panel labels it with, matching the single `waitingFor` the model has.
      if (!from.waitingFor) from.waitingFor = lock;
      // One edge per (waiter, owner) pair — the wait-for graph proper. Owners
      // are named explicitly here, so unlike the InnoDB text there is nothing
      // to infer and no unresolved `to`.
      for (const o of owners) {
        const to = o.id ? byId.get(o.id) : undefined;
        if (to && to.ordinal !== from.ordinal) {
          edges.push({ from: from.ordinal, to: to.ordinal, lock });
        }
      }
    }
  }

  // ── the victim SQL Server actually rolled back ──
  const victimId = /<victimProcess\s+id="([^"]+)"/.exec(xml)?.[1];
  const victim = victimId ? byId.get(victimId)?.ordinal ?? null : null;

  const transactions = order.map(id => byId.get(id)!).filter(Boolean);
  // When it happened: the caller's event timestamp if it has one, else the
  // oldest transaction start in the report — which is the closest the XML
  // itself comes to naming the moment.
  const when = capturedAt
    ?? /lasttranstarted="([^"]+)"/.exec(xml)?.[1]
    ?? '';

  return {
    when,
    transactions,
    edges,
    victim,
    cycle: findCycle(edges),
    raw,
  };
}
