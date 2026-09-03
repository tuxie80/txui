/**
 * TxShell — a SQL command line inside the app.
 *
 * The transcript is a list of *entries*, not a stream of characters. A result
 * set renders as the real grid, sortable and exportable; a plan opens the plan
 * view. FluidShell is a VT220 emulator, so everything it produces is text and
 * anything structured has to be re-parsed to be used again. Keeping entries
 * structured is what will let phase 2's pipeline stages operate on rows rather
 * than on rendered characters.
 *
 * Grammar and parsing live in utils/txShell + utils/txShellGrammar; this file
 * is the prompt, the transcript and the execution of what was parsed.
 */
import { errorDisplay } from '../utils/appError';
import { confirmDialog } from '../utils/appDialog';
import { quoteIdent } from '../utils/sqlIdent';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke, Channel } from '@tauri-apps/api/core';
import { audited } from '../utils/panelAudit';
import type { QueryResult, Session } from '../types';
import { ResultGrid } from './ResultGrid';
import { StatusIcon } from './StatusIcon';
import {
  parseLine, substituteVars, isComplete, quotesClosed, pushHistory, completions,
} from '../utils/txShell';
import type { ParsedLine } from '../utils/txShell';
import { VERBS, METAS, PIPE, findMeta } from '../utils/txShellGrammar';
import { psqlMeta } from '../utils/psqlMeta';
import { getPref, PREFS } from '../store/preferences';
import { fmtDuration } from '../utils/fmtDuration';
import { ConnectionsStore } from '../store/connections';
import {
  runPipeline, delimitedToResult, matchesPattern, unionResults,
} from '../utils/txShellPipeline';
import type { SinkAction } from '../utils/txShellPipeline';
import { serialize, toInserts } from '../utils/exporters';
import type { ExportFormat as ExporterFormat } from '../utils/exporters';
import { toXlsx } from '../utils/xlsx';

interface OsOutput {
  stdout: string; stderr: string; code: number | null;
  truncated: boolean; timed_out: boolean; ms: number;
}

type ExecEvent =
  | { event: 'started'; data: { connection_id: string; name: string } }
  | { event: 'finished'; data: {
      connection_id: string; name: string; ok: boolean;
      result: QueryResult | null; error: string | null; execution_ms: number } }
  | { event: 'done'; data: unknown };

/** Cap on servers a single `@pattern` may hit without being named explicitly. */
const FANOUT_CONFIRM_AT = 4;

/**
 * TxShell's format names vs the exporter's.
 *
 * The shell says `md` and `inserts` because that is what fits on a command
 * line; the exporter has always said `markdown` and `insert`. Mapping here
 * beats renaming either side and breaking the other.
 */
const TO_EXPORTER: Record<string, ExporterFormat> = {
  csv: 'csv', tsv: 'tsv', json: 'json', ascii: 'ascii',
  md: 'markdown', inserts: 'insert',
  html: 'html', xml: 'xml', latex: 'latex',
};

interface Props {
  session: Session;
  /** Every open session, so `insert into t @other` can find its destination. */
  openSessions: Session[];
  onClose: () => void;
}

type Entry =
  | { id: number; kind: 'input'; text: string }
  | { id: number; kind: 'text'; text: string; tone?: 'err' | 'muted' | 'ok' }
  | { id: number; kind: 'result'; result: QueryResult; sql: string; ms: number }
  | { id: number; kind: 'help'; topic?: string };

let nextId = 1;

export function TxShellPanel({ session, openSessions, onClose }: Props) {
  const [entries, setEntries] = useState<Entry[]>([
    { id: nextId++, kind: 'text', tone: 'muted',
      text: `TxShell — ${session.connectionName}. A bare line is SQL and runs. `
        + `Use ${PIPE} to pipe, \\help for commands, ! for your shell.` },
  ]);
  const [buffer, setBuffer] = useState('');
  const [pending, setPending] = useState<string[]>([]);   // multi-line so far
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState<number | null>(null);
  const [vars, setVars] = useState<Record<string, string>>({});
  const [timing, setTiming] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ghost, setGhost] = useState('');

  // `\source` runs lines through `execute`, which is defined after the meta
  // handler that calls it. A ref breaks the cycle without reordering the file.
  const executeRef = useRef<((line: string) => Promise<void>) | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const push = useCallback((e: Omit<Entry, 'id'>) => {
    // Capped transcript (WP-14 14.6, same bound the panel's log slice uses):
    // `entries` grew without cap and result entries retained their full row
    // sets forever — a long session leaked every result ever printed.
    setEntries(prev => {
      const next = [...prev, { ...e, id: nextId++ } as Entry];
      return next.length > 499 ? next.slice(-499) : next;
    });
  }, []);
  /** Bumped on every error, so `\source` can stop at the first failure. */
  const errorCount = useRef(0);
  const say = useCallback((text: string, tone?: 'err' | 'muted' | 'ok') => {
    if (tone === 'err') errorCount.current++;
    push({ kind: 'text', text, tone } as Entry);
  }, [push]);

  // Follow the tail as output arrives.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // ── execution ──────────────────────────────────────────────────────────────

  /**
   * Execute and return the rows; the caller decides whether to show them.
   *
   * Audited like the editor is. The shell runs arbitrary SQL — including
   * `CREATE USER … IDENTIFIED BY` — so leaving it out of the record was the
   * largest hole in it, and the statement is redacted on the way in
   * (utils/panelAudit).
   */
  const queryRows = useCallback(async (sql: string): Promise<QueryResult | null> => {
    try {
      return await audited({
        sessionId: session.sessionId, engine: session.engine,
        tab: '❯ TxShell', source: 'shell', statement: sql,
        rowsOut: (r: QueryResult) => r.rows.length,
        rowsAffected: (r: QueryResult) => (r.rows_affected == null ? null : Number(r.rows_affected)),
        run: () => invoke<QueryResult>('execute_query', {
          sessionId: session.sessionId,
          sql,
          limit: getPref(PREFS.defaultLimit) || null,
          tabId: null,
          includeWarnings: false,
        }),
      });
    } catch (e) {
      say(errorDisplay(e), 'err');
      return null;
    }
  }, [session.sessionId, session.engine, say]);

  const runSql = useCallback(async (sql: string) => {
    const t0 = performance.now();
    const result = await queryRows(sql);
    if (!result) return;
    push({ kind: 'result', result, sql, ms: Math.round(performance.now() - t0) } as Entry);
    for (const w of result.warnings ?? []) say(w, 'muted');
  }, [queryRows, push, say]);

  const runMeta = useCallback(async (name: string, args: string[]) => {
    switch (name) {
      case 'help':
        push({ kind: 'help', topic: args[0] } as Entry);
        return;
      case 'clear':
        setEntries([]);
        return;
      case 'vars': {
        const keys = Object.keys(vars);
        say(keys.length
          ? keys.map(k => `$${k} = ${vars[k]}`).join('\n')
          : 'No variables set. Assign one with `$name = value`.', 'muted');
        return;
      }
      case 'unset':
        if (!args[0]) return say('`\\unset` needs a name — try `\\unset foo`', 'err');
        setVars(v => { const n = { ...v }; delete n[args[0]]; return n; });
        say(`Unset $${args[0]}`, 'muted');
        return;
      case 'history':
        say(history.slice(-(Number(args[0]) || 20)).join('\n') || 'No history yet.', 'muted');
        return;
      case 'timing':
        setTiming(t => (args[0] ? args[0].toLowerCase() === 'on' : !t));
        say(`Timing ${args[0] ? args[0] : !timing ? 'on' : 'off'}`, 'muted');
        return;
      case 'c':
        // Switching sessions belongs to the host; phase 1 reports where it is.
        say(`Current session: ${session.connectionName} (${session.engine})`
          + (session.environment ? ` · ${session.environment}` : ''), 'muted');
        return;
      // PostgreSQL catalog listings are handled ahead of `runMeta` by `psqlMeta`;
      // these branches are the MySQL/other-engine equivalents.
      case 'l':
        await runSql('SHOW DATABASES');
        return;
      case 'dt':
        await runSql('SHOW TABLES');
        return;
      case 'dv':
        await runSql("SHOW FULL TABLES WHERE Table_type = 'VIEW'");
        return;
      case 'df':
        await runSql('SELECT ROUTINE_SCHEMA, ROUTINE_NAME, ROUTINE_TYPE '
          + 'FROM information_schema.ROUTINES ORDER BY 1,2');
        return;
      case 'd': {
        const obj = args[0];
        if (!obj) return runMeta('dt', []);
        await runSql(`SHOW FULL COLUMNS FROM ${quoteIdent(obj, 'mysql')}`);
        return;
      }
      case 'source': {
        const file = args[0];
        if (!file) return say('`\\source` needs a file — try `\\source setup.txsh`', 'err');
        let text: string;
        try {
          text = await invoke<string>('read_text_file', { path: file });
        } catch (e) {
          return say(`Could not read ${file}: ${errorDisplay(e)}`, 'err');
        }
        // Lines are executed in order, and the script STOPS at the first error.
        // Carrying on past a failed statement is how a setup script leaves a
        // database half-built and looks like it worked.
        const lines = text.split('\n');
        let buf: string[] = [];
        let ran = 0;
        for (const raw of lines) {
          buf.push(raw);
          const joined = buf.join('\n');
          if (!joined.trim() || !isComplete(joined, getPref(PREFS.sqlDelimiter))) continue;
          buf = [];
          const before = errorCount.current;
          say(`▸ ${joined.trim()}`, 'muted');
          await executeRef.current?.(joined);
          ran++;
          if (errorCount.current > before) {
            return say(`Script stopped at statement ${ran} — ${file}`, 'err');
          }
        }
        if (buf.join('\n').trim()) {
          return say(`${file} ends mid-statement — nothing was run for the last line.`, 'err');
        }
        say(`${file}: ${ran} statement${ran === 1 ? '' : 's'} run.`, 'ok');
        return;
      }
      case 'edit':
        window.dispatchEvent(new CustomEvent('dbgui:insert-sql',
          { detail: { sql: history[history.length - 1] ?? '' } }));
        say('Sent to the SQL editor.', 'muted');
        return;
      default:
        say(`\`\\${name}\` is recognised but not wired up yet.`, 'muted');
    }
  }, [vars, history, timing, session, say, push, runSql]);

  const runOs = useCallback(async (command: string) => {
    try {
      const r = await invoke<OsOutput>('run_os_command', { command, cwd: null });
      if (r.stdout.trim()) say(r.stdout.replace(/\n$/, ''));
      if (r.stderr.trim()) say(r.stderr.replace(/\n$/, ''), 'err');
      if (r.timed_out) say('Timed out after 120 s and was killed.', 'err');
      else if (r.truncated) say('Output was truncated.', 'muted');
      if (r.code !== null && r.code !== 0) say(`exit ${r.code}`, 'err');
      if (timing) say(`${fmtDuration(r.ms)}`, 'muted');
    } catch (e) {
      say(errorDisplay(e), 'err');
    }
  }, [say, timing]);

  /**
   * Perform whatever the pipeline asked for at its end.
   *
   * The pure layer only *describes* a sink; the IO happens here, so every
   * stage stays unit-testable without a filesystem.
   */
  const performSink = useCallback(async (
    result: QueryResult, sink: SinkAction | undefined, sql: string, ms: number,
  ) => {
    const cells = result.rows;
    const names = result.columns.map(c => c.name);

    if (!sink || sink.kind === 'grid') {
      push({ kind: 'result', result, sql, ms } as Entry);
      return;
    }
    if (sink.kind === 'chart') {
      // The chart view lives in the result area; hand it the rows and say so.
      window.dispatchEvent(new CustomEvent('dbgui:chart-result', { detail: { result } }));
      push({ kind: 'result', result, sql, ms } as Entry);
      say('Sent to the chart view.', 'muted');
      return;
    }
    if (sink.kind === 'to') {
      say(serialize(TO_EXPORTER[sink.format!], names, cells, 'result', session.engine));
      return;
    }

    if (sink.kind === 'insert') {
      if (cells.length === 0) return say('Nothing to insert — the pipeline produced no rows.', 'muted');
      const table = sink.table!;

      // A destination sends the rows to a DIFFERENT server than the one that
      // produced them. That server needs an open session — TxShell writes
      // through a live connection rather than opening one behind your back.
      let target = session.sessionId;
      let where = 'this session';
      let targetEngine = session.engine;
      if (sink.destination) {
        const hit = openSessions.filter(
          x => matchesPattern(x.connectionName, sink.destination!));
        if (hit.length === 0) {
          return say(`No OPEN session matches \`@${sink.destination}\`. `
            + `Open it first — writing needs a live connection. `
            + `Open now: ${openSessions.map(x => x.connectionName).join(', ') || '(none)'}`, 'err');
        }
        if (hit.length > 1) {
          return say(`\`@${sink.destination}\` matches ${hit.length} open sessions `
            + `(${hit.map(x => x.connectionName).join(', ')}) — name one exactly. `
            + 'Nothing was written.', 'err');
        }
        if (hit[0].environment === 'prod') {
          const okGo = await confirmDialog(
            `Insert ${cells.length} row${cells.length === 1 ? '' : 's'} into `
            + `${table} on PRODUCTION (${hit[0].connectionName})?`,
            { danger: true });
          if (!okGo) return say('Cancelled.', 'muted');
        }
        target = hit[0].sessionId;
        where = hit[0].connectionName;
        targetEngine = hit[0].engine;
      }

      // The INSERTs run on the TARGET session — its dialect decides quoting.
      const sqlText = toInserts(table, names, cells, targetEngine);
      // One transaction: a failure part-way must leave nothing behind, which is
      // the whole difference between this and pasting generated INSERTs.
      const statements = ['BEGIN', ...sqlText.split(/;\s*\n/).filter(x => x.trim()), 'COMMIT'];
      try {
        for (const st of statements) {
          const stmt = st.replace(/;\s*$/, '');
          // Audited against the TARGET session, not this one: the rows land
          // there, so that is the connection whose record must show it.
          await audited({
            sessionId: target, engine: session.engine,
            tab: '❯ TxShell', source: 'shell', statement: stmt,
            run: () => invoke('execute_query', {
              sessionId: target, sql: stmt,
              limit: null, tabId: null, includeWarnings: false,
            }),
          });
        }
        say(`${cells.length} row${cells.length === 1 ? '' : 's'} inserted into `
          + `${table} on ${where}`, 'ok');
      } catch (e) {
        try {
          // The rollback is audited too: "the insert failed and was undone" is
          // a different fact from "the insert failed", and only one of them
          // means the target table is untouched.
          await audited({
            sessionId: target, engine: session.engine,
            tab: '❯ TxShell', source: 'shell', statement: 'ROLLBACK',
            run: () => invoke('execute_query', {
              sessionId: target, sql: 'ROLLBACK',
              limit: null, tabId: null, includeWarnings: false,
            }),
          });
          say(`Insert failed and was rolled back: ${errorDisplay(e)}`, 'err');
        } catch {
          say(`Insert failed: ${errorDisplay(e)}. The transaction could NOT be rolled back — `
            + `check ${table} on ${where} before retrying.`, 'err');
        }
      }
      return;
    }

    // save / append
    const file = sink.file!;
    try {
      if (sink.format === 'xlsx') {
        if (sink.kind === 'append') {
          return say('xlsx cannot be appended to — use `save` instead.', 'err');
        }
          await invoke('write_binary_file', { path: file, contents: [...toXlsx(names, cells)] });
      } else {
        const text = serialize(TO_EXPORTER[sink.format!], names, cells, 'result', session.engine);
        if (sink.kind === 'append') {
          // Read-modify-write: there is no append command, and a partial write
          // would be worse than an explicit failure.
          let existing = '';
          try { existing = await invoke<string>('read_text_file', { path: file }); }
          catch { /* a new file is fine */ }
          const joined = existing && !existing.endsWith('\n') ? existing + '\n' + text : existing + text;
          await invoke('write_text_file', { path: file, contents: joined });
        } else {
          await invoke('write_text_file', { path: file, contents: text });
        }
      }
      say(`${cells.length} row${cells.length === 1 ? '' : 's'} `
        + `${sink.kind === 'append' ? 'appended to' : 'written to'} ${file}`, 'ok');
    } catch (e) {
      say(`Could not write ${file}: ${errorDisplay(e)}`, 'err');
    }
  }, [push, say, session.sessionId, session.engine, openSessions]);

  /**
   * Run a statement on every connection matching a pattern.
   *
   * Fan-out multiplies risk by the number of targets, so a write is refused
   * outright and a wide match is named before it runs — a mistyped pattern
   * that hits fourteen servers should be visible, not discovered afterwards.
   */
  const runFanout = useCallback(async (pattern: string, sql: string) => {
    const all = await ConnectionsStore.list().catch(() => []);
    const hits = all.filter(c => matchesPattern(c.name, pattern));
    if (hits.length === 0) {
      return say(`No connection matches \`@${pattern}\`. `
        + `Known: ${all.map(c => c.name).join(', ') || '(none)'}`, 'err');
    }
    if (!/^\s*(select|show|explain|with|describe|desc)\b/i.test(sql)) {
      return say(
        'Fan-out runs read-only statements only. A write across many servers needs '
        + 'to be done deliberately, one at a time or through ⚡ Fleet exec — not from '
        + 'a pattern that might match more than you meant. Nothing was run.', 'err');
    }
    const prod = hits.filter(c => c.environment === 'prod');
    if (hits.length >= FANOUT_CONFIRM_AT || prod.length > 0) {
      const ok = await confirmDialog(
        `Run on ${hits.length} connection${hits.length === 1 ? '' : 's'}?\n\n`
        + hits.map(c => `  ${c.name}${c.environment === 'prod' ? '  (prod)' : ''}`).join('\n')
        + `\n\n${sql}`,
        prod.length > 0 ? { danger: true } : {});
      if (!ok) return say('Cancelled.', 'muted');
    }

    const parts: Array<{ name: string; result: QueryResult }> = [];
    const failures: string[] = [];
    const chan = new Channel<ExecEvent>();
    const done = new Promise<void>(resolve => {
      chan.onmessage = ev => {
        if (ev.event === 'finished') {
          const d = ev.data;
          if (d.ok && d.result) parts.push({ name: d.name, result: d.result });
          else failures.push(`${d.name}: ${d.error ?? 'failed'}`);
        } else if (ev.event === 'done') resolve();
      };
    });
    try {
      // Same rule as the ⚟ Multi-exec panel: one row for the decision to run
      // it everywhere. No session id — it belongs to no single connection.
      await audited({
        sessionId: '',
        connectionName: `${hits.length} server${hits.length === 1 ? '' : 's'}`,
        engine: 'multi', tab: '❯ TxShell', source: 'fleet',
        statement: `-- across ${hits.length} server${hits.length === 1 ? '' : 's'}: `
          + `${hits.map(c => c.name).join(', ')}\n${sql}`,
        run: () => invoke('multi_execute', {
          connectionIds: hits.map(c => c.id), sql, onEvent: chan,
        }),
      });
      await done;
    } catch (e) {
      return say(errorDisplay(e), 'err');
    }
    for (const f of failures) say(f, 'err');
    return unionResults(parts);
  }, [say]);

  /** `from <file>` — a delimited file as a result set. */
  const runSource = useCallback(async (file: string): Promise<QueryResult | null> => {
    try {
      const text = await invoke<string>('read_text_file', { path: file });
      const delim = /\.tsv$/i.test(file) ? '\t' : ',';
      if (/\.json$/i.test(file)) {
        const parsed = JSON.parse(text);
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        const keys = [...new Set(arr.flatMap(o => Object.keys(o ?? {})))];
        return {
          columns: keys.map(k => ({ name: k, type_name: 'text', nullable: true })),
          rows: arr.map(o => keys.map(k => (o as Record<string, unknown>)?.[k] ?? null)),
          rows_affected: null, execution_ms: 0, fetch_ms: 0, warnings: [],
        };
      }
      return delimitedToResult(text, delim);
    } catch (e) {
      say(`Could not read ${file}: ${errorDisplay(e)}`, 'err');
      return null;
    }
  }, [say]);

  const execute = useCallback(async (line: string) => {
    const parsed: ParsedLine = parseLine(line);
    const head = parsed.head;

    if (head.kind === 'empty' || head.kind === 'comment') return;
    if (head.kind === 'error') return say(head.message, 'err');
    if (parsed.error) return say(parsed.error, 'err');

    // Variables are substituted after parsing, so a value containing `|>` or a
    // quote cannot change what the line MEANS — only what it says.
    const subst = (text: string): string | null => {
      const { text: out, missing } = substituteVars(text, vars);
      if (missing.length) {
        say(`Unset variable${missing.length > 1 ? 's' : ''}: `
          + missing.map(m => `$${m}`).join(', ')
          + '. Nothing was run — set it with `$name = value`, or `\\vars` to see what is set.',
          'err');
        return null;
      }
      return out;
    };

    // Meta, OS and assignment take no pipeline — they produce no rows.
    if (head.kind === 'meta') {
      if (parsed.stages.length) return say('A `\\command` cannot be piped yet.', 'err');
      // A psql backslash command maps onto a catalog query or a display toggle;
      // the mapped SQL runs through the same `runSql` path a typed query does.
      // `null` means "not a psql meta I own" — fall through to the shell's own
      // handling (\\help, \\c, \\watch, and the MySQL catalog equivalents).
      const mapped = psqlMeta(line.trim(), session.engine);
      if (mapped) {
        if (mapped.toggle === 'timing') {
          setTiming(t => (head.args[0] ? head.args[0].toLowerCase() === 'on' : !t));
          return say(`Timing ${head.args[0] ? head.args[0] : !timing ? 'on' : 'off'}`, 'muted');
        }
        if (mapped.toggle === 'expanded') {
          setExpanded(x => (head.args[0] ? head.args[0].toLowerCase() === 'on' : !x));
          return say(`Expanded display ${head.args[0] ? head.args[0] : !expanded ? 'on' : 'off'}`, 'muted');
        }
        if (mapped.note) return say(mapped.note, 'muted');
        if (mapped.sql) return void await runSql(mapped.sql);
      }
      return runMeta(head.name, head.args);
    }
    if (head.kind === 'os') {
      const cmd = subst(head.command);
      if (cmd === null) return;
      setBusy(true);
      await runOs(cmd);
      setBusy(false);
      return;
    }
    if (head.kind === 'assign') {
      setVars(v => ({ ...v, [head.name]: head.value }));
      return say(`$${head.name} = ${head.value}`, 'muted');
    }

    // Everything else produces rows, which the pipeline then shapes.
    setBusy(true);
    try {
      const t0 = performance.now();
      let rows: QueryResult | null | undefined;
      let label = '';

      if (head.kind === 'sql') {
        const sql = subst(head.sql);
        if (sql === null) return;
        label = sql;
        // With no pipeline this is the plain path, warnings and all.
        if (parsed.stages.length === 0) return void await runSql(sql);
        rows = await queryRows(sql);
      } else if (head.kind === 'fanout') {
        const sql = subst(head.sql);
        if (sql === null) return;
        label = `@${head.pattern} ${sql}`;
        rows = await runFanout(head.pattern, sql) || null;
      } else if (head.kind === 'source') {
        const file = subst(head.args[0]);
        if (file === null) return;
        label = `from ${file}`;
        rows = await runSource(file);
      }

      if (!rows) return;
      const ms = Math.round(performance.now() - t0);
      const out = runPipeline(rows, parsed.stages);
      if ('error' in out) return say(out.error, 'err');
      await performSink(out.result, out.sink, label, ms);
    } finally {
      setBusy(false);
    }
  }, [vars, say, runSql, queryRows, runMeta, runOs, runFanout, runSource, performSink,
      session.engine, timing, expanded]);

  useEffect(() => { executeRef.current = execute; }, [execute]);

  // ── the prompt ─────────────────────────────────────────────────────────────

  const submit = useCallback(async () => {
    const whole = [...pending, buffer].join('\n');
    if (!whole.trim()) { setBuffer(''); return; }

    // A bare single line runs on Enter without demanding a `;` — a GUI shell
    // is not a terminal, and an unterminated `select 1` vanishing into a
    // pending buffer reads as "the shell ate my query". Multi-line input
    // still waits for the terminator (that's what Shift+Enter is for), and
    // an open quote always means the user is mid-literal, not done.
    const singleLine = pending.length === 0 && !buffer.includes('\n');
    const runnable = isComplete(whole, getPref(PREFS.sqlDelimiter))
      || (singleLine && quotesClosed(whole));
    if (!runnable) {
      // Still mid-statement — echo the accepted line so it never silently
      // disappears, and keep the prompt open (psql's `->`, made visible).
      push({ kind: 'input', text: buffer } as Entry);
      setPending(p => [...p, buffer]);
      setBuffer('');
      return;
    }

    // Continuation lines were echoed as they went pending; echo only the
    // closing line, otherwise the one-shot line itself.
    push({ kind: 'input', text: pending.length ? buffer : whole } as Entry);
    setHistory(h => pushHistory(h, whole));
    setHistIdx(null);
    setPending([]);
    setBuffer('');
    await execute(whole);
  }, [pending, buffer, push, execute]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
      return;
    }
    // History only when the caret cannot move within the line — otherwise ↑
    // would fight normal editing in a multi-line statement.
    const el = e.currentTarget;
    const atStart = el.selectionStart === 0 && el.selectionEnd === 0;
    const atEnd = el.selectionStart === el.value.length && el.selectionEnd === el.value.length;

    if (e.key === 'ArrowUp' && atStart && history.length) {
      e.preventDefault();
      const idx = histIdx === null ? history.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(idx);
      setBuffer(history[idx]);
      return;
    }
    if (e.key === 'ArrowDown' && atEnd && histIdx !== null) {
      e.preventDefault();
      const idx = histIdx + 1;
      if (idx >= history.length) { setHistIdx(null); setBuffer(''); }
      else { setHistIdx(idx); setBuffer(history[idx]); }
      return;
    }
    if (e.key === 'Tab') {
      const opts = completions(buffer, el.selectionStart ?? buffer.length);
      if (opts.length === 1) {
        e.preventDefault();
        const token = /(\S*)$/.exec(buffer.slice(0, el.selectionStart ?? 0))?.[1] ?? '';
        setBuffer(buffer.slice(0, (el.selectionStart ?? 0) - token.length) + opts[0]
          + buffer.slice(el.selectionStart ?? 0) + ' ');
      } else if (opts.length > 1) {
        e.preventDefault();
        say(opts.join('   '), 'muted');
      }
      return;
    }
    if (e.key === 'Escape' && pending.length) {
      e.preventDefault();
      setPending([]);
      setBuffer('');
      say('Cancelled.', 'muted');
    }
  };

  // A live hint of what the current line will do — the cheapest way to make
  // the grammar teach itself.
  useEffect(() => {
    const t = buffer.trim();
    if (!t || pending.length) { setGhost(''); return; }
    const p = parseLine(t);
    if (p.head.kind === 'error') { setGhost(p.head.message); return; }
    if (p.error) { setGhost(p.error); return; }
    const label: Record<string, string> = {
      sql: 'SQL on this session', fanout: 'fan-out', meta: 'command',
      os: 'your shell', assign: 'set a variable', source: 'file source',
      comment: 'comment', empty: '',
    };
    const base = label[p.head.kind] ?? '';
    setGhost(p.stages.length ? `${base} ${PIPE} ${p.stages.map(s => s.name).join(` ${PIPE} `)}` : base);
  }, [buffer, pending.length]);

  const prompt = pending.length ? '…' : `${session.connectionName} ▸`;

  return (
    // Clicking anywhere in the shell puts the caret back in the prompt, which
    // is what every terminal does and what makes the transcript feel like part
    // of the same thing. Without it, clicking the output silently drops focus
    // and the next keystroke goes nowhere — which reads as "the panel does not
    // work" rather than "you are not focused".
    //
    // Guarded so it does not fight a real selection: dragging to copy a line
    // out of the transcript must not yank the caret away mid-gesture.
    <div
      className="txsh"
      onMouseUp={() => {
        if ((window.getSelection()?.toString().length ?? 0) === 0) inputRef.current?.focus();
      }}
    >
      <div className="panel-header">
        <span className="panel-title">❯ TxShell</span>
        <span className="txsh-sess">{session.connectionName}</span>
        {session.environment === 'prod' && <span className="txsh-prod">prod</span>}
        <div style={{ flex: 1 }} />
        <button className="toolbar-btn" onClick={() => setEntries([])}>Clear</button>
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>

      <div className="txsh-scroll" ref={scrollRef}>
        {entries.map(e => <EntryView key={e.id} entry={e} timing={timing} expanded={expanded} />)}
        {busy && <div className="txsh-line txsh-muted">running…</div>}
      </div>

      <div className="txsh-prompt">
        <span className="txsh-caret">{prompt}</span>
        <textarea
          ref={inputRef}
          className="txsh-input"
          value={buffer}
          rows={1}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder={pending.length ? 'continue the statement…' : 'SELECT 1   ·   \\help'}
          onChange={e => setBuffer(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      {ghost && <div className="txsh-ghost">{ghost}</div>}
    </div>
  );
}

// ── transcript entries ───────────────────────────────────────────────────────

// Memoized (WP-14 14.6): every new prompt line used to re-render every prior
// entry INCLUDING its ResultGrid.
const EntryView = memo(function EntryView({ entry, timing, expanded }: { entry: Entry; timing: boolean; expanded: boolean }) {
  if (entry.kind === 'input') {
    return (
      <div className="txsh-line txsh-echo">
        <span className="txsh-echo-mark">▸</span>
        <code>{entry.text}</code>
      </div>
    );
  }
  if (entry.kind === 'text') {
    return (
      <div className={`txsh-line${entry.tone ? ` txsh-${entry.tone}` : ''}`}>
        {entry.tone === 'err' && <StatusIcon kind="error" />}
        {entry.tone === 'ok' && <StatusIcon kind="ok" />}
        <pre>{entry.text}</pre>
      </div>
    );
  }
  if (entry.kind === 'help') return <HelpView topic={entry.topic} />;

  const rows = entry.result.rows.length;
  const affected = entry.result.rows_affected;
  return (
    <div className="txsh-result">
      <div className="txsh-result-meta">
        {affected !== null && affected !== undefined
          ? `${affected} row${affected === 1 ? '' : 's'} affected`
          : `${rows} row${rows === 1 ? '' : 's'}`}
        {timing && ` · ${fmtDuration(entry.ms)}`}
      </div>
      {entry.result.columns.length > 0 && rows > 0 && (
        <div className={`txsh-grid${expanded ? ' txsh-grid-x' : ''}`}>
          <ResultGrid result={entry.result} />
        </div>
      )}
    </div>
  );
});

/** `\help`, generated from the registry so it cannot drift from the parser. */
function HelpView({ topic }: { topic?: string }) {
  const verb = useMemo(
    () => (topic ? VERBS.find(v => v.name === topic.toLowerCase()) : undefined), [topic]);
  const meta = useMemo(
    () => (topic ? findMeta(topic.replace(/^\\/, '')) : undefined), [topic]);

  if (topic && (verb || meta)) {
    const usage = verb?.usage ?? meta!.usage;
    const summary = verb?.summary ?? meta!.summary;
    const detail = verb?.detail ?? meta?.detail;
    return (
      <div className="txsh-help">
        <code className="txsh-help-usage">{usage}</code>
        <div className="txsh-help-summary">{summary}</div>
        {detail && <div className="txsh-help-detail">{detail}</div>}
      </div>
    );
  }
  if (topic) {
    return <div className="txsh-line txsh-err"><pre>{`No help for \`${topic}\`.`}</pre></div>;
  }

  const group = (kind: string) => VERBS.filter(v => v.kind === kind);
  return (
    <div className="txsh-help">
      <div className="txsh-help-rule">
        A bare line is <b>SQL</b> and runs. <code>{PIPE}</code> pipes rows to a verb —
        not <code>|</code>, which stays SQL&rsquo;s bitwise-or. There is no <code>&gt;</code> redirect:
        <code> save</code> writes files, so <code>&gt;</code> is always a comparison.
      </div>
      <HelpGroup title="Prefixes" items={[
        ['@pattern SQL', 'run on every matching connection'],
        ['\\command', 'a shell command (below)'],
        ['!line', 'hand the line to your own shell'],
        ['$name = value', 'set a variable; use $name or ${name}'],
        ['# text', 'comment'],
      ]} />
      <HelpGroup title="Pipeline" items={group('stage').map(v => [v.usage, v.summary])} />
      <HelpGroup title="Output" items={group('sink').map(v => [v.usage, v.summary])} />
      <HelpGroup title="Input" items={group('source').map(v => [v.usage, v.summary])} />
      <HelpGroup title="Commands" items={METAS.map(m => [m.usage, m.summary])} />
      <div className="txsh-help-detail">
        <code>\help &lt;name&gt;</code> explains one. Tab completes. ↑/↓ walks history.
        Enter runs a bare line — no <code>;</code> needed. Shift-Enter adds a line.
      </div>
    </div>
  );
}

function HelpGroup({ title, items }: { title: string; items: (string[])[] }) {
  if (items.length === 0) return null;
  return (
    <div className="txsh-help-group">
      <div className="txsh-help-title">{title}</div>
      {items.map(([usage, summary]) => (
        <div key={usage} className="txsh-help-row">
          <code>{usage}</code><span>{summary}</span>
        </div>
      ))}
    </div>
  );
}
