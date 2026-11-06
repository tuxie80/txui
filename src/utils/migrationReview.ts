import { reviewChanges } from './changeReview.ts';
import type { ChangeReviewEngine, ChangeReviewResult } from './changeReview.ts';
import { MYSQL_SNAPSHOT_SQL, PG_SNAPSHOT_SQL, buildSnapshot } from './schemaCollect.ts';
import type { Grid } from './schemaCollect.ts';
import type { SchemaSnapshot } from './schemaRules.ts';

export type MigrationGridRunner = (sql: string) => Promise<Grid | null>;

export interface MigrationReviewResult {
  review: ChangeReviewResult;
  catalog: SchemaSnapshot | null;
  catalogComplete: boolean;
}

export interface MigrationReviewOptions {
  sql: string;
  engine: ChangeReviewEngine;
  mariaDb: boolean;
  schema: string;
  runGrid: MigrationGridRunner;
  onLog: (message: string) => void;
  purpose?: 'before-state' | 'final-state';
}

export async function reviewMigrationWithCatalog(options: MigrationReviewOptions): Promise<MigrationReviewResult> {
  const { sql, engine, mariaDb, runGrid, onLog } = options;
  const purpose = options.purpose ?? 'before-state';
  const schema = options.schema.trim();
  let catalog: SchemaSnapshot | null = null;
  if (schema) {
    onLog(`Reading the ${purpose} catalog of \`${schema}\`…`);
    const snapshot = engine === 'mysql' ? MYSQL_SNAPSHOT_SQL : PG_SNAPSHOT_SQL;
    const [defaults, tables, columns, indexes, foreignKeys, sequences] = await Promise.all([
      runGrid(snapshot.defaults(schema)),
      runGrid(snapshot.tables(schema)),
      runGrid(snapshot.columns(schema)),
      runGrid(snapshot.indexes(schema)),
      runGrid(snapshot.foreignKeys(schema)),
      engine === 'mysql' ? Promise.resolve(null) : runGrid(PG_SNAPSHOT_SQL.sequences(schema)),
    ]);
    if (tables && columns && indexes && foreignKeys) {
      let stats = await runGrid(snapshot.stats(schema));
      let statsSource = engine === 'mysql'
        ? 'mysql.innodb_table_stats'
        : 'pg_stat_user_tables + pg_relation_size';
      if (!stats) {
        stats = await runGrid(snapshot.statsFallback(schema));
        statsSource = engine === 'mysql'
          ? 'information_schema.TABLES (estimated)'
          : 'pg_class.reltuples (estimated)';
      }
      catalog = buildSnapshot({
        schema, engine, defaults, tables, columns, indexes, foreignKeys,
        stats, statsSource, sequences,
      });
      onLog(purpose === 'before-state'
        ? `Seeded ${catalog.tables.length} live tables; applying migration statements in order.`
        : `Loaded ${catalog.tables.length} final-state tables for final-object comparison.`);
    } else {
      onLog(`Core catalog reads were incomplete — falling back to migration-only analysis, not a complete live ${purpose}.`);
    }
  } else {
    onLog('No DB selected — migration-only analysis. ALTER targets need an earlier CREATE or their model stays partial.');
  }
  const review = reviewChanges({ sql, engine, catalog: catalog ?? undefined, mariaDb });
  onLog(`Done — ${review.summary.supported}/${review.summary.statements} statements modeled, `
    + `${review.summary.unsupported} unsupported, ${review.findings.length} findings.`);
  return { review, catalog, catalogComplete: catalog !== null };
}
