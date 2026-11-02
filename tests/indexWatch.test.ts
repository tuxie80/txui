import test from 'node:test';
import assert from 'node:assert/strict';
import { runTargets } from '../dev/render-smoke/run.mjs';
import * as fixtures from '../dev/doc-fixtures.mjs';

const FILE = 'src/components/ThreadProgressDialog.tsx';
const ALTER_PHASE = 'stage/innodb/alter table (read PK and internal sort)';
const MERGE_PHASE = 'stage/innodb/alter table (merge sort)';
const delay = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
const result = rows => ({ columns: [], rows, row_count: rows.length });

function mysqlRow({
  id = 41, query = 'CREATE INDEX ix ON shop.orders (customer_id)', querySecs = 120,
  phase = ALTER_PHASE, completed = 500, estimated = 1000, pct = 50, phaseSecs = 30,
  status = 'running', eventId = 11, statementEventId = 900, statementThreadId = 77,
} = {}) {
  return [
    id, query, querySecs, 'executing', phase, completed, estimated, pct, phaseSecs, status,
    eventId, statementEventId, 'app', 'localhost', 'shop', 'Query', 1.5,
    10, 500, 0, 0, 0, statementThreadId,
  ];
}

function mariaRow() {
  const row = Array(27).fill(null);
  row[0] = 41;
  row[1] = 'OPTIMIZE TABLE shop.orders';
  row[2] = 12.5;
  row[3] = 'copy to tmp table';
  row[9] = 'running';
  row[12] = 'app'; row[13] = 'localhost'; row[14] = 'shop'; row[15] = 'Query';
  row[18] = 500;
  row[23] = 1; row[24] = 2; row[25] = 46; row[26] = 23;
  return row;
}

function workerRow({
  eventId = 12, statementEventId = 900, threadId = 88, phase = MERGE_PHASE,
  completed = 250, pct = 25,
} = {}) {
  const row = mysqlRow({ phase, eventId, statementEventId, statementThreadId: threadId, completed, pct });
  row[0] = null;
  row[1] = '';
  return row;
}

function session(name, engine = 'mysql', readOnly = false) {
  return {
    connectionId: `connection-${name}`, sessionId: `session-${name}`,
    connectionName: `${name} (${engine})`, engine, environment: 'dev', readOnly,
  };
}

function target(name, engine, monitorQuery, extra = {}) {
  const route = args => {
    const sql = String(args.sql);
    if (engine === 'mysql' && sql.includes('SELECT VERSION() AS v')) {
      const maria = extra.flavor === 'mariadb';
      return result([[maria ? '11.8.8-MariaDB' : '8.4.11', maria ? 'MariaDB Server' : 'MySQL Community Server']]);
    }
    return monitorQuery(args);
  };
  return {
    name, file: FILE, tier: 'mount',
    props: { session: session(name, engine, extra.readOnly), initialThreadId: 41, onClose: () => {} },
    mock: { ...fixtures.mockFor(engine), monitor_query: route },
    ...extra,
  };
}

function sqlServerActivity(query = 'CREATE INDEX ix ON dbo.t (a)', command = 'CREATE INDEX') {
  return [
    41, query, 15, 'running', command, null, null,
    73, 'PAGEIOLATCH_EX', 1.25, 4.5, 100, 20, 1000, 4, 256,
    '2026-11-02T10:00:00Z', 0,
  ];
}

function sqlServerMetadataRouter({ activity = result([sqlServerActivity()]), resumable = result([]),
  events = result([]), operators = result([]) } = {}) {
  const respond = value => typeof value === 'function' ? value() : value;
  return args => {
    const sql = String(args.sql);
    if (sql.includes('sys.dm_exec_requests')) return respond(activity);
    if (sql.includes('sys.index_resumable_operations')) return respond(resumable);
    if (sql.includes('sys.dm_xe_sessions')) return respond(events);
    if (sql.includes('sys.dm_exec_query_profiles')) return respond(operators);
    throw new Error(`unexpected SQL Server monitoring query: ${sql}`);
  };
}

function walk(node, found = []) {
  if (node.nodeType === 1) found.push(node);
  for (const child of node.childNodes ?? []) walk(child, found);
  return found;
}

function control(container, text) {
  const match = walk(container).find(el => ['BUTTON', 'INPUT', 'FORM'].includes(el.tagName)
    && (text === undefined || el.textContent.trim() === text));
  if (!match) throw new Error(`control not found: ${text ?? 'input'}`);
  return match;
}

async function click(ctx, text) {
  const button = control(ctx.container, text);
  await ctx.act(async () => {
    button.dispatchEvent(new Event('click', { bubbles: true }));
    await delay();
  });
}

async function enterThread(ctx, id) {
  const input = walk(ctx.container).find(el => el.tagName === 'INPUT');
  const form = walk(ctx.container).find(el => el.tagName === 'FORM');
  if (!input || !form) throw new Error('thread picker not rendered');
  const propsKey = Object.keys(input).find(key => key.startsWith('__reactProps'));
  if (!propsKey) throw new Error('mounted input has no React props');
  await ctx.act(async () => {
    input[propsKey].onChange({ target: { value: id } });
    await delay();
  });
  await ctx.act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await delay();
  });
}

function mysqlRouter(main, workers = () => result([]), setup = () => result([[7, 7, 3, 3]])) {
  return args => {
    const sql = String(args.sql);
    if (sql.includes('mysql.cloudsql_replica_idx_status')) throw new Error('not a Cloud SQL replica');
    if (sql.includes('information_schema.PROCESSLIST')) return main(sql);
    if (sql.includes('performance_schema.events_stages_current s')) return workers(sql);
    if (sql.includes('performance_schema.setup_instruments')) return setup(sql);
    throw new Error(`unexpected MySQL monitoring query: ${sql}`);
  };
}

const targets = [
  target('IndexWatchMysqlCreate', 'mysql', mysqlRouter(
    () => result([
      mysqlRow({ eventId: 10, phase: ALTER_PHASE, status: 'done', pct: 100, phaseSecs: 12 }),
      mysqlRow({ eventId: 11, phase: MERGE_PHASE, pct: 65.2, phaseSecs: 30 }),
    ]),
    () => result([workerRow()]),
  ), {
    interact: async ctx => {
      let copied = '';
      ctx.shim.window.navigator.clipboard.writeText = async text => { copied = text; };
      await click(ctx, 'Copy diagnostics');
      if (/finished after/.test(copied)) throw new Error('running diagnostics claimed completion');
    },
    assert: ({ html, calls }) => {
      for (const text of [
        'CREATE INDEX — Performance Schema stages', '65.2%', 'background', 'THREAD_ID 88',
        'app@localhost', 'shop', '10 / 500 / 0', 'pending', 'estimated remaining',
      ]) if (!html.includes(text)) return `missing ${text}`;
      const phaseRows = (html.match(/<tr class="tpd-phase-/g) ?? []).length;
      if (phaseRows !== 8) return `expected 7 lifecycle phases plus one background event, got ${phaseRows}`;
      const monitoring = calls.filter(c => c.cmd === 'monitor_query' && !String(c.args?.sql).includes('SELECT VERSION()'));
      if (monitoring.length !== 3) return 'statement, worker feeds and the one-time Cloud SQL status probe were not all read';
      if (monitoring.some(c => !/^\s*SELECT\b/i.test(String(c.args?.sql)))) return 'watcher issued a non-read monitoring statement';
      if (calls.some(c => ['kill_processes', 'execute_query'].includes(c.cmd))) return 'watching executed or killed work';
    },
  }),

  target('IndexWatchMysqlAlterTable', 'mysql', mysqlRouter(() => result([
    mysqlRow({ query: 'ALTER TABLE shop.orders MODIFY COLUMN total DECIMAL(14,2)', phase: MERGE_PHASE }),
  ])), {
    assert: ({ html }) => {
      if (!html.includes('ALTER TABLE — Performance Schema stages')) return 'ALTER TABLE was mislabeled';
      if (!html.includes(MERGE_PHASE)) return 'ALTER TABLE phase missing';
    },
  }),

  target('IndexWatchCloudSqlReplicaJobs', 'mysql', args => {
    const sql = String(args.sql);
    if (sql.includes('mysql.cloudsql_replica_idx_status')) return result([
      [7, "CALL mysql.addSecondaryIdxOnReplica('', 'ix', 'shop.orders', 'customer_id', '')", 'CREATE', 41, '2026-08-26 10:52:13', null, 2, null, '[SIC_7]', 'RUNNING'],
      [8, 'CREATE INDEX iy ON shop.t(b)', 'CREATE', null, '2026-08-26 10:51:13', null, 0, null, '[SIC_8]', 'PENDING'],
      [9, 'CREATE INDEX iz ON shop.t(c)', 'CREATE', null, '2026-08-26 10:50:13', '2026-08-26 11:00:13', 1, 'Duplicate key name', '[SIC_9]', 'FAILED'],
      [10, 'CREATE INDEX id ON shop.t(d)', 'CREATE', null, '2026-08-26 10:49:13', '2026-08-26 10:49:30', 0, null, '[SIC_10]', 'DONE'],
    ]);
    if (sql.includes('performance_schema.events_stages_current s')) return result([]);
    if (sql.includes('performance_schema.events_stages_current')) {
      return result([mysqlRow({ query: "CALL mysql.addSecondaryIdxOnReplica('', 'ix', 'shop.orders', 'customer_id', '')" })]);
    }
    throw new Error(`unexpected Cloud SQL monitoring query: ${sql}`);
  }, {
    assert: ({ html }) => {
      for (const text of [
        'Cloud SQL managed replica indexes', 'RUNNING', 'PENDING', 'FAILED', 'DONE',
        'Duplicate key name', 'CREATE INDEX — Performance Schema stages',
      ]) if (!html.includes(text)) return `missing ${text}`;
      if (!html.includes('>2</td>')) return 'retry count missing';
    },
  }),

  target('IndexWatchMariaDbNative', 'mysql', args => {
    const sql = String(args.sql);
    if (sql.includes('p.STAGE, p.MAX_STAGE, p.PROGRESS')) return result([mariaRow()]);
    if (sql.includes('performance_schema.events_stages_current s')) return result([]);
    if (sql.includes('performance_schema.events_stages_current')) {
      return result([mysqlRow({ query: 'OPTIMIZE TABLE shop.orders', phase: null })]);
    }
    throw new Error(`unexpected MariaDB monitoring query: ${sql}`);
  }, {
    flavor: 'mariadb',
    interact: ctx => click(ctx, 'Refresh'),
    assert: ({ html, calls }) => {
      for (const text of [
        'MariaDB native stage 1 of 2', '46.0% of current stage', '23.0% overall',
        'information_schema.PROCESSLIST', 'DATA_FREE alone is not a general fragmentation measure',
      ]) if (!html.includes(text)) return `missing ${text}`;
      if (html.includes('Enable progress tracking')) return 'native progress was hidden by unnecessary setup';
      const native = calls.filter(c => String(c.args?.sql).includes('p.STAGE, p.MAX_STAGE'));
      if (native.length === 0) return 'native MariaDB feed was not queried';
    },
  }),

  (() => {
    let detailCalls = 0;
    return target('IndexWatchMariaDbOptionalFeedOutage', 'mysql', args => {
      const sql = String(args.sql);
      if (sql.includes('p.STAGE, p.MAX_STAGE, p.PROGRESS')) return result([mariaRow()]);
      if (sql.includes('performance_schema.events_stages_current s')) return result([]);
      if (sql.includes('performance_schema.events_stages_current')) {
        detailCalls += 1;
        if (detailCalls > 1) throw new Error('performance_schema is OFF');
        return result([mysqlRow({ query: 'OPTIMIZE TABLE shop.orders' })]);
      }
      throw new Error(`unexpected MariaDB monitoring query: ${sql}`);
    }, {
      flavor: 'mariadb',
      interact: ctx => click(ctx, 'Refresh'),
      assert: ({ html }) => {
        if (!html.includes('Optional Performance Schema detail unavailable: performance_schema is OFF')) {
          return 'optional feed outage was not explained';
        }
        if (!html.includes('tpd-status-running')) return 'last observed running phase was marked complete during an outage';
        if (!html.includes('23.0% overall')) return 'native progress was lost during the optional feed outage';
      },
    });
  })(),

  (() => {
    let polls = 0;
    return target('IndexWatchMysqlCompletion', 'mysql', mysqlRouter(() => {
      polls += 1;
      return polls === 1 ? result([mysqlRow()]) : result([]);
    }), {
      interact: async ctx => {
        await click(ctx, 'Refresh');
        await click(ctx, 'Refresh');
      },
      assert: ({ html, calls }) => {
        if (!html.includes('Completed — final observed statistics')) return 'completion summary missing';
        if (!html.includes('finished after 120.0 s')) return 'final statement statistics missing';
        if (!html.includes('tpd-status-skipped')) return 'unreported phases were not finalized as skipped';
        if ((html.match(/finished after 120\.0 s/g) ?? []).length !== 1) return 'completion was logged more than once';
        if (calls.filter(c => String(c.args?.sql).includes('information_schema.PROCESSLIST')).length !== 3) {
          return 'unexpected completion polling sequence';
        }
      },
    });
  })(),

  (() => {
    let polls = 0;
    return target('IndexWatchMysqlStatementSwitch', 'mysql', mysqlRouter(() => {
      polls += 1;
      if (polls === 1) return result([mysqlRow({ query: 'ALTER TABLE t COPY OLD', phase: 'stage/sql/copy to tmp table' })]);
      return result([mysqlRow({ query: 'ALTER TABLE t ADD CONSTRAINT uk UNIQUE (a)', eventId: 12, statementEventId: 901 })]);
    }), {
      interact: ctx => click(ctx, 'Refresh'),
      assert: ({ html }) => {
        if (!html.includes('ALTER TABLE t ADD CONSTRAINT uk UNIQUE (a)')) return 'new statement missing';
        if (html.includes('stage/sql/copy to tmp table')) return 'old statement phase leaked into the new watch';
        if (html.includes('Completed — final observed statistics')) return 'statement switch displayed a stale completion banner';
      },
    });
  })(),

  (() => {
    let polls = 0;
    return target('IndexWatchMysqlErrorRecovery', 'mysql', mysqlRouter(() => {
      polls += 1;
      if (polls === 2) throw new Error('temporary monitoring failure');
      return result([mysqlRow({ querySecs: 120 + polls })]);
    }), {
      interact: async ctx => {
        await click(ctx, 'Refresh');
        if (!ctx.container.textContent.includes('temporary monitoring failure')) throw new Error('poll error not shown');
        if (!ctx.container.textContent.includes('CREATE INDEX ix')) throw new Error('last good snapshot was discarded');
        await click(ctx, 'Refresh');
      },
      assert: ({ html }) => {
        if (html.includes('temporary monitoring failure')) return 'error survived a successful retry';
        if (!html.includes('123')) return 'recovered snapshot was not rendered';
      },
    });
  })(),

  (() => {
    let polls = 0;
    return target('IndexWatchMysqlStallResume', 'mysql', mysqlRouter(() => {
      polls += 1;
      return result([mysqlRow({
        phaseSecs: [0, 30, 65, 80][polls], completed: polls < 3 ? 500 : 501,
        pct: polls < 3 ? 50 : 50.1,
      })]);
    }), {
      interact: async ctx => {
        await click(ctx, 'Refresh');
        if (!ctx.container.textContent.includes('possible stall')) throw new Error('stationary work was not marked stalled');
        await click(ctx, 'Refresh');
      },
      assert: ({ html }) => {
        if (html.includes('possible stall')) return 'resumed work stayed marked as stalled';
        if (!html.includes('50.1%')) return 'resumed progress was not rendered';
      },
    });
  })(),

  target('IndexWatchMysqlReadOnlySetup', 'mysql', mysqlRouter(
    () => result([mysqlRow({ phase: null, statementThreadId: null })]),
    () => result([]),
    () => result([[3, 7, 2, 3]]),
  ), {
    readOnly: true,
    interact: ctx => click(ctx, 'Enable progress tracking'),
    assert: ({ html, calls }) => {
      if (!html.includes('Instruments: 3/7')) return 'instrument counts missing';
      if (!html.includes('this connection is read-only')) return 'read-only reason missing';
      if (!html.includes('aria-disabled="true"')) return 'setup action is not guarded';
      if (calls.some(c => c.cmd === 'enable_mysql_stage_progress')) return 'read-only session enabled server instrumentation';
    },
  }),

  target('IndexWatchMysqlSetupReady', 'mysql', mysqlRouter(
    () => result([mysqlRow({ phase: null, statementThreadId: null })]),
  ), {
    assert: ({ html }) => html.includes('Progress tracking is enabled') ? undefined : 'enabled setup was misreported',
  }),

  target('IndexWatchMysqlSetupError', 'mysql', mysqlRouter(
    () => result([mysqlRow({ phase: null, statementThreadId: null })]),
    () => result([]),
    () => { throw new Error('performance_schema access denied'); },
  ), {
    assert: ({ html }) => {
      for (const text of ['performance_schema access denied', 'startup-disabled performance_schema', 'Recheck setup']) {
        if (!html.includes(text)) return `missing ${text}`;
      }
    },
  }),

  target('IndexWatchPostgresConcurrent', 'postgres', args => {
    const sql = String(args.sql);
    if (sql.includes('pg_stat_activity')) {
      return result([[41, 'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ix ON public.t (a)', 95, 'active']]);
    }
    if (sql.includes('pg_stat_progress_create_index')) return result([['waiting for old snapshots', 63, 31415]]);
    throw new Error(`unexpected PostgreSQL query: ${sql}`);
  }, {
    assert: ({ html, calls }) => {
      for (const text of ['waiting for old snapshots', '63.0%', 'waiting on pid 31415', 'CREATE UNIQUE INDEX CONCURRENTLY']) {
        if (!html.includes(text)) return `missing ${text}`;
      }
      const monitoring = calls.filter(c => c.cmd === 'monitor_query');
      if (monitoring.length !== 2) return 'activity and create-index progress should each be queried once';
      if (!monitoring[1].args.sql.includes('pid = 41')) return 'progress view queried the wrong backend';
    },
  }),

  target('IndexWatchPostgresNoProgressRow', 'postgres', args => {
    const sql = String(args.sql);
    if (sql.includes('pg_stat_activity')) return result([[41, 'CREATE INDEX ix ON t (a)', 4, 'active']]);
    if (sql.includes('pg_stat_progress_create_index')) return result([]);
    throw new Error(`unexpected PostgreSQL query: ${sql}`);
  }, {
    assert: ({ html }) => {
      if (!html.includes('no server estimate')) return 'missing progress row invented a percentage';
      if (html.includes('waiting on pid')) return 'missing progress row invented a locker';
      if (!html.includes('active')) return 'activity snapshot was discarded';
    },
  }),

  target('IndexWatchPostgresConstraint', 'postgres', args => {
    const sql = String(args.sql);
    if (sql.includes('pg_stat_activity')) return result([[41, 'ALTER TABLE t ADD CONSTRAINT pk PRIMARY KEY (id)', 8, 'active']]);
    if (sql.includes('pg_stat_progress_create_index')) return result([['building index', 25, null]]);
    if (sql.includes('pg_stat_progress_cluster')) throw new Error('constraint index used the table-rewrite view');
    throw new Error(`unexpected PostgreSQL query: ${sql}`);
  }, {
    assert: ({ html, calls }) => {
      if (!html.includes('building index') || !html.includes('25.0%')) return 'constraint index progress missing';
      if (calls.some(c => String(c.args?.sql).includes('pg_stat_progress_cluster'))) return 'wrong PostgreSQL progress view';
    },
  }),

  target('IndexWatchSqlServerReorganize', 'sqlserver', args => {
    if (!String(args.sql).includes('sys.dm_exec_requests')) throw new Error('wrong SQL Server activity source');
    return result([[41, 'ALTER INDEX ix ON dbo.t REORGANIZE', 12.5, 'running', 'ALTER INDEX REORGANIZE', 42.5, 9000]]);
  }, {
    assert: ({ html, calls }) => {
      for (const text of ['ALTER INDEX REORGANIZE', '42.5%', 'server ETA 9 s']) {
        if (!html.includes(text)) return `missing ${text}`;
      }
      if (calls.filter(c => c.cmd === 'monitor_query').length !== 1) return 'SQL Server should need one request snapshot';
    },
  }),

  target('IndexWatchSqlServerCreate', 'sqlserver', sqlServerMetadataRouter({
    activity: result([sqlServerActivity('CREATE UNIQUE NONCLUSTERED INDEX ix ON dbo.t (a)')]),
  }), {
    assert: ({ html }) => {
      if (!html.includes('CREATE INDEX') || !html.includes('no server estimate')) return 'unsupported server percentage was not handled honestly';
      if (!html.includes('No completion percentage is exposed')) return 'empty metadata was not explained';
      if (!html.includes('blocked by session 73') || !html.includes('CPU 4.5 s')) return 'activity diagnostics missing';
      if (!html.includes('width:0%') && !html.includes('tpd-indeterminate')) return 'indeterminate progress bar missing';
    },
  }),

  target('IndexWatchSqlServerRebuild', 'sqlserver', sqlServerMetadataRouter({
    activity: result([sqlServerActivity('ALTER INDEX ALL ON dbo.t REBUILD WITH (ONLINE = ON)', 'ALTER INDEX')]),
  }), {
    assert: ({ html }) => {
      if (!html.includes('ALTER INDEX ALL ON dbo.t REBUILD')) return 'REBUILD statement missing';
      if (!html.includes('no server estimate')) return 'REBUILD invented an unsupported percentage';
    },
  }),

  target('IndexWatchSqlServerResumable', 'sqlserver', sqlServerMetadataRouter({
    activity: result([sqlServerActivity('CREATE INDEX ix ON dbo.t (a) WITH (ONLINE = ON, RESUMABLE = ON)')]),
    resumable: result([[1001, 1, 'ix', 'CREATE INDEX ix ON dbo.t (a) WITH (ONLINE = ON, RESUMABLE = ON)', 'Paused', 3, 42.5, 8192, null]]),
    events: () => { throw new Error('authoritative resumable progress did not short-circuit events'); },
    operators: () => { throw new Error('authoritative resumable progress did not short-circuit profiles'); },
  }), {
    assert: ({ html, calls }) => {
      for (const text of ['resumable index operation · paused', '42.5%', '8,192 pages', '3 min']) {
        if (!html.includes(text)) return `missing ${text}`;
      }
      if (calls.filter(c => c.cmd === 'monitor_query').length !== 2) return 'resumable precedence issued unnecessary probes';
    },
  }),

  target('IndexWatchSqlServerOnlineEvents', 'sqlserver', sqlServerMetadataRouter({
    events: result([
      ['index-watch', '2026-11-02T09:59:00Z', '<event><action name="session_id"><value>41</value></action><data name="event_subclass"><value>7</value></data></event>'],
      ['index-watch', '2026-11-02T10:00:01Z', '<event><action name="session_id"><value>41</value></action><data name="event_subclass"><value>2</value></data><data name="bigint_data1"><value>1250</value></data><data name="partition_number"><value>3</value></data></event>'],
      ['index-watch', '2026-11-02T10:00:02Z', '<event><action name="session_id"><value>99</value></action><data name="event_subclass"><value>7</value></data></event>'],
    ]),
    operators: () => { throw new Error('online events did not take precedence over operator estimates'); },
  }), {
    assert: ({ html }) => {
      for (const text of ['stage 1 · base object build', '1,250 rows inserted', 'partition 3', 'no server estimate']) {
        if (!html.includes(text)) return `missing ${text}`;
      }
      if (html.includes('stage 2') || html.includes('>done<')) return 'uncorrelated or old event leaked into the watch';
    },
  }),

  target('IndexWatchSqlServerOperatorEstimate', 'sqlserver', sqlServerMetadataRouter({
    operators: result([[1, 'Table Scan', 500, 1000, 2000, 100]]),
  }), {
    assert: ({ html }) => {
      for (const text of ['Table Scan · estimated operator progress', '50.0%', '500 / 1,000 rows', 'not total DDL completion']) {
        if (!html.includes(text)) return `missing ${text}`;
      }
    },
  }),

  target('IndexWatchSqlServerMetadataDenied', 'sqlserver', sqlServerMetadataRouter({
    resumable: () => { throw new Error('VIEW DATABASE STATE denied'); },
    events: () => { throw new Error('VIEW SERVER STATE denied'); },
    operators: () => { throw new Error('VIEW DATABASE PERFORMANCE STATE denied'); },
  }), {
    assert: ({ html }) => {
      if (!html.includes('3 optional metadata sources unavailable')) return 'metadata privilege failures were not reported';
      if (!html.includes('CREATE INDEX ix') || !html.includes('no server estimate')) return 'metadata failure discarded activity';
      if (html.includes('VIEW DATABASE STATE denied')) return 'optional probe failure became a whole-watch error';
    },
  }),

  (() => {
    let polls = 0;
    return target('IndexWatchPostgresCompletion', 'postgres', args => {
      const sql = String(args.sql);
      if (sql.includes('pg_stat_activity')) {
        polls += 1;
        return polls === 1 ? result([[41, 'CREATE INDEX CONCURRENTLY ix ON t(a)', 12.5, 'active']]) : result([]);
      }
      if (sql.includes('pg_stat_progress_create_index')) return result([['building index', 63, null]]);
      throw new Error(`unexpected PostgreSQL query: ${sql}`);
    }, {
      interact: ctx => click(ctx, 'Refresh'),
      assert: ({ html }) => {
        for (const text of [
          'Completed — final observed statistics', 'backend 41 finished after 12.5 s',
          'final observed phase building index', 'last observed progress 63.0%', 'Copy diagnostics',
        ]) if (!html.includes(text)) return `missing ${text}`;
        if (!html.includes('CREATE INDEX CONCURRENTLY ix')) return 'final statement was discarded';
      },
    });
  })(),

  (() => {
    let polls = 0;
    return target('IndexWatchSqlServerCompletion', 'sqlserver', sqlServerMetadataRouter({
      activity: () => {
        polls += 1;
        return polls === 1 ? result([sqlServerActivity('CREATE INDEX ix ON dbo.t(a) WITH (RESUMABLE = ON)')]) : result([]);
      },
      resumable: result([[1001, 1, 'ix', 'CREATE INDEX ix ON dbo.t(a) WITH (RESUMABLE = ON)', 'Running', 1, 42.5, 100, null]]),
    }), {
      interact: ctx => click(ctx, 'Refresh'),
      assert: ({ html }) => {
        for (const text of [
          'session 41 finished after 15.0 s', 'resumable index operation · running',
          'last observed progress 42.5%', 'CPU 4.5 s', 'Copy diagnostics',
        ]) if (!html.includes(text)) return `missing ${text}`;
      },
    });
  })(),

  (() => {
    let releaseOld;
    const old = new Promise(resolve => { releaseOld = () => resolve(result([mysqlRow({ id: 41, query: 'CREATE INDEX old_ix ON t (a)' })])); });
    return target('IndexWatchStaleResponse', 'mysql', mysqlRouter(sql => {
      if (sql.includes('p.ID = 41')) return old;
      if (sql.includes('p.ID = 202')) return result([mysqlRow({ id: 202, query: 'CREATE INDEX new_ix ON t (a)' })]);
      throw new Error(`unexpected watched id: ${sql}`);
    }), {
      interact: async ctx => {
        await enterThread(ctx, '202');
        await ctx.act(async () => { releaseOld(); await delay(); });
      },
      assert: ({ html, calls }) => {
        if (!html.includes('Thread 202') || !html.includes('new_ix')) return 'new watch did not finish';
        if (html.includes('old_ix')) return 'late response replaced the new watch';
        if (!calls.some(c => String(c.args?.sql).includes('p.ID = 202'))) return 'new thread was never polled';
      },
    });
  })(),

  (() => {
    let release;
    const pending = new Promise(resolve => { release = () => resolve(result([mysqlRow({ statementThreadId: null })])); });
    return target('IndexWatchNoOverlap', 'mysql', mysqlRouter(() => pending), {
      interact: async ctx => {
        await click(ctx, 'Refresh');
        await click(ctx, 'Refresh');
        await click(ctx, 'Refresh');
        const polls = () => ctx.hub.calls.filter(c => c.cmd === 'monitor_query' && String(c.args?.sql).includes('p.ID ='));
        if (polls().length !== 1) throw new Error('overlapping polls were issued');
        await ctx.act(async () => { release(); await delay(); });
      },
      assert: ({ html, calls }) => {
        if (!html.includes('CREATE INDEX ix')) return 'released poll did not render';
        if (calls.filter(c => c.cmd === 'monitor_query' && String(c.args?.sql).includes('p.ID =')).length !== 1) {
          return 'in-flight guard allowed duplicate queries';
        }
      },
    });
  })(),

  target('IndexWatchInvalidThread', 'mysql', () => { throw new Error('invalid input reached the backend'); }, {
    props: { session: session('IndexWatchInvalidThread'), initialThreadId: null, onClose: () => {} },
    interact: ctx => enterThread(ctx, '1 OR 1=1'),
    assert: ({ html, calls }) => {
      if (!html.includes('Enter a positive whole process/thread ID')) return 'invalid ID was not rejected';
      if (calls.some(c => c.cmd === 'monitor_query' && String(c.args?.sql).includes('p.ID ='))) {
        return 'invalid ID caused a monitoring query';
      }
    },
  }),

  target('IndexWatchUnsupportedEngine', 'duckdb', () => { throw new Error('unsupported engine queried'); }, {
    assert: ({ html, calls }) => {
      if (!html.includes('Thread progress is not available for duckdb')) return 'unsupported engine was not explained';
      if (calls.some(c => c.cmd === 'monitor_query')) return 'unsupported engine issued a probe';
    },
  }),

  (() => {
    let closed = 0;
    return target('IndexWatchCloseNeverKills', 'mysql', () => result([]), {
      props: { session: session('IndexWatchCloseNeverKills'), initialThreadId: null, onClose: () => { closed += 1; } },
      interact: ctx => click(ctx, '×'),
      assert: ({ calls }) => {
        if (closed !== 1) return 'close callback did not run exactly once';
        if (calls.some(c => /kill|cancel/.test(c.cmd))) return 'closing the dialog touched the server thread';
      },
    });
  })(),
];

const results = await runTargets(targets, { fixtures });

for (const scenario of targets) {
  test(scenario.name, () => {
    const outcome = results.get(scenario.name);
    assert.ok(outcome, `${scenario.name} did not run`);
    assert.equal(outcome.status, 'mounted', outcome.error ?? outcome.status);
    assert.deepEqual(outcome.consoleErrors ?? [], [], 'React logged an error while watching');
  });
}
