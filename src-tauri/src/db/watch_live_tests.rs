//! Tiny, opt-in live watcher fixtures driven by `dbctl tmp`.
//!
//! Run all four from the repository root: `sh dev/watch_live_test.sh`.
//! No test starts a persistent server or downloads a dataset.

use rust_decimal::Decimal;
use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::{MySqlPool, Row};
use std::str::FromStr;
use std::time::Duration;

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("run this fixture through dbctl tmp")
}

fn mysql_url() -> String {
    format!("{}txui_watch", database_url())
}

async fn mysql_pool() -> MySqlPool {
    let root = MySqlPoolOptions::new()
        .max_connections(1)
        .connect(&database_url())
        .await
        .expect("MySQL root connection");
    sqlx::query("CREATE DATABASE txui_watch")
        .execute(&root)
        .await
        .unwrap();
    MySqlPoolOptions::new()
        .max_connections(4)
        .connect(&mysql_url())
        .await
        .expect("MySQL fixture connection")
}

#[tokio::test]
#[ignore = "requires dbctl tmp mysql@8.4 or mariadb@11.8"]
async fn dbctl_mysql_watch_lock_stages_completion_and_privileges() {
    let pool = mysql_pool().await;
    let version: String = sqlx::query_scalar("SELECT VERSION()")
        .fetch_one(&pool)
        .await
        .unwrap();
    println!("  watching {version}");

    sqlx::query("CREATE TABLE watch_test(id INTEGER PRIMARY KEY, value VARCHAR(32))")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO watch_test
        SELECT n, MD5(n) FROM (
          SELECT 1 + d1.x + 10 * d2.x + 100 * d3.x + 1000 * d4.x AS n
          FROM (SELECT 0 x UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
                UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) d1,
               (SELECT 0 x UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
                UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) d2,
               (SELECT 0 x UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
                UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) d3,
               (SELECT 0 x UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
                UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) d4
        ) numbers")
        .execute(&pool).await.unwrap();
    sqlx::query(
        "UPDATE performance_schema.setup_instruments SET ENABLED = 'YES', TIMED = 'YES'
                 WHERE NAME LIKE 'stage/innodb/alter%' OR NAME = 'stage/sql/copy to tmp table'",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE performance_schema.setup_consumers SET ENABLED = 'YES'
                 WHERE NAME LIKE 'events_stages_%'",
    )
    .execute(&pool)
    .await
    .unwrap();

    let ddl = MySqlPoolOptions::new()
        .max_connections(1)
        .connect(&mysql_url())
        .await
        .unwrap();
    let ddl_id: u64 = sqlx::query_scalar("SELECT CONNECTION_ID()")
        .fetch_one(&ddl)
        .await
        .unwrap();
    let ddl_thread_id: u64 = sqlx::query_scalar(
        "SELECT THREAD_ID FROM performance_schema.threads WHERE PROCESSLIST_ID = ?",
    )
    .bind(ddl_id)
    .fetch_one(&ddl)
    .await
    .unwrap();
    let blocker = MySqlPoolOptions::new()
        .max_connections(1)
        .connect(&mysql_url())
        .await
        .unwrap();
    sqlx::raw_sql("LOCK TABLES watch_test WRITE")
        .execute(&blocker)
        .await
        .unwrap();
    let running = tokio::spawn(async move {
        sqlx::query("ALTER TABLE watch_test ADD INDEX watch_locked_idx(value)")
            .execute(&ddl)
            .await
            .unwrap();
    });

    let mut saw_wait = false;
    for _ in 0..100 {
        let state: Option<String> = sqlx::query_scalar(
            "SELECT COALESCE(STATE, '') FROM information_schema.PROCESSLIST WHERE ID = ?",
        )
        .bind(ddl_id)
        .fetch_optional(&pool)
        .await
        .unwrap();
        if state
            .as_deref()
            .unwrap_or("")
            .to_lowercase()
            .contains("metadata lock")
        {
            saw_wait = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(saw_wait, "DDL never appeared waiting for the metadata lock");

    let limited_options = MySqlConnectOptions::from_str(&mysql_url())
        .unwrap()
        .username("watch_limited")
        .password("watch_only");
    sqlx::query("CREATE USER 'watch_limited'@'%' IDENTIFIED BY 'watch_only'")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("GRANT SELECT ON watch_test TO 'watch_limited'@'%'")
        .execute(&pool)
        .await
        .unwrap();
    let limited = MySqlPoolOptions::new()
        .max_connections(1)
        .connect_with(limited_options)
        .await
        .unwrap();
    let visible: Option<u64> =
        sqlx::query_scalar("SELECT ID FROM information_schema.PROCESSLIST WHERE ID = ?")
            .bind(ddl_id)
            .fetch_optional(&limited)
            .await
            .unwrap();
    assert_eq!(
        visible, None,
        "restricted account saw another user's statement"
    );
    let setup_denied = sqlx::query(
        "UPDATE performance_schema.setup_instruments SET ENABLED = 'YES' WHERE NAME = 'stage/innodb/alter table (insert)'")
        .execute(&limited).await;
    assert!(
        setup_denied.is_err(),
        "restricted account changed progress instrumentation"
    );

    sqlx::raw_sql("UNLOCK TABLES")
        .execute(&blocker)
        .await
        .unwrap();
    running.await.unwrap();
    let stages = sqlx::query(
        "SELECT EVENT_NAME, WORK_COMPLETED, WORK_ESTIMATED
         FROM performance_schema.events_stages_history_long
         WHERE THREAD_ID = ? AND EVENT_NAME LIKE 'stage/innodb/alter%'",
    )
    .bind(ddl_thread_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert!(
        !stages.is_empty(),
        "no real InnoDB stage history was retained"
    );
    for row in &stages {
        let name: String = row.get(0);
        let completed: Option<u64> = row.get(1);
        let estimated: Option<u64> = row.get(2);
        println!("  {name} · {completed:?}/{estimated:?}");
    }

    sqlx::query("ALTER TABLE watch_test ADD COLUMN note VARCHAR(32)")
        .execute(&pool)
        .await
        .unwrap();
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM watch_test")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 10000);
    let running_now: Option<u64> =
        sqlx::query_scalar("SELECT ID FROM information_schema.PROCESSLIST WHERE ID = ?")
            .bind(ddl_id)
            .fetch_optional(&pool)
            .await
            .unwrap();
    assert_eq!(
        running_now, None,
        "completed DDL remained visible as running"
    );

    if !version.to_lowercase().contains("mariadb") {
        sqlx::query(
            "CREATE TABLE compression_test(id INT PRIMARY KEY, value VARCHAR(255)) ENGINE=InnoDB",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO compression_test VALUES (1, REPEAT('x', 200)), (2, REPEAT('y', 200))",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("ALTER TABLE compression_test ROW_FORMAT=COMPRESSED")
            .execute(&pool)
            .await
            .unwrap();
        let row_format: String = sqlx::query_scalar(
            "SELECT ROW_FORMAT FROM information_schema.TABLES
             WHERE TABLE_SCHEMA = 'txui_watch' AND TABLE_NAME = 'compression_test'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row_format.to_uppercase(), "COMPRESSED");
        match sqlx::query("ALTER TABLE compression_test ROW_FORMAT=DYNAMIC COMPRESSION='ZLIB'")
            .execute(&pool)
            .await
        {
            Ok(_) => {
                let options: String = sqlx::query_scalar(
                    "SELECT CREATE_OPTIONS FROM information_schema.TABLES
                     WHERE TABLE_SCHEMA = 'txui_watch' AND TABLE_NAME = 'compression_test'",
                )
                .fetch_one(&pool)
                .await
                .unwrap();
                assert!(
                    options.to_uppercase().contains("ZLIB"),
                    "transparent compression missing: {options}"
                );
                println!("  verified {version} transparent compression: {options}");
            }
            Err(e) => {
                let message = e.to_string();
                assert!(
                    message.contains("4029") && message.contains("Punch hole"),
                    "unexpected transparent-compression failure: {message}"
                );
                println!("  {version} transparent compression refused by this filesystem: expected error 4029");
            }
        }
        sqlx::query("OPTIMIZE TABLE compression_test")
            .execute(&pool)
            .await
            .unwrap();
        println!("  verified {version} ROW_FORMAT=COMPRESSED and OPTIMIZE");
    }
}

#[tokio::test]
#[ignore = "requires dbctl tmp mariadb@11.8 with performance_schema=OFF"]
async fn dbctl_mariadb_native_vector_compression_live() {
    let pool = mysql_pool().await;
    let version: String = sqlx::query_scalar("SELECT VERSION()")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(version.to_lowercase().contains("mariadb"));

    let native = sqlx::query(
        "SELECT STAGE, MAX_STAGE, PROGRESS,
                CASE WHEN MAX_STAGE < 2 THEN PROGRESS
                     ELSE (STAGE - 1) / MAX_STAGE * 100 + PROGRESS / MAX_STAGE END
         FROM information_schema.PROCESSLIST WHERE ID = CONNECTION_ID()",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let stage: i64 = native.get(0);
    let max_stage: i64 = native.get(1);
    let stage_pct: Decimal = native.get(2);
    let total_pct: Decimal = native.get(3);
    assert_eq!(stage, 0);
    assert_eq!(max_stage, 0);
    assert_eq!(stage_pct, Decimal::ZERO);
    assert_eq!(total_pct, Decimal::ZERO);

    sqlx::query("CREATE TABLE items(id INT PRIMARY KEY, embedding VECTOR(2) NOT NULL)")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO items VALUES
        (1, VEC_FromText('[0.1,0.2]')), (2, VEC_FromText('[0.3,0.4]'))",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("CREATE VECTOR INDEX embedding_idx ON items(embedding) DISTANCE=cosine")
        .execute(&pool)
        .await
        .unwrap();
    let plan: String = sqlx::query_scalar(
        "ANALYZE FORMAT=JSON SELECT id FROM items
         ORDER BY VEC_DISTANCE_COSINE(embedding, VEC_FromText('[0.1,0.2]')) LIMIT 1",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(
        plan.contains("\"key\": \"embedding_idx\""),
        "vector index absent from measured plan: {plan}"
    );
    assert!(
        plan.contains("\"r_rows\": 1"),
        "measured vector rows absent: {plan}"
    );
    assert!(
        !plan.contains("\"using_filesort\": true"),
        "vector ordering used a filesort: {plan}"
    );

    sqlx::query("CREATE TABLE storage_test(id INT PRIMARY KEY, value VARCHAR(255)) ENGINE=InnoDB")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO storage_test VALUES (1, REPEAT('x', 200)), (2, REPEAT('y', 200))")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("ALTER TABLE storage_test ROW_FORMAT=COMPRESSED")
        .execute(&pool)
        .await
        .unwrap();
    let row_format: String = sqlx::query_scalar(
        "SELECT ROW_FORMAT FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = 'txui_watch' AND TABLE_NAME = 'storage_test'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row_format.to_uppercase(), "COMPRESSED");
    sqlx::query("ALTER TABLE storage_test ROW_FORMAT=DYNAMIC PAGE_COMPRESSED=1")
        .execute(&pool)
        .await
        .unwrap();
    let storage = sqlx::query(
        "SELECT CREATE_OPTIONS, DATA_FREE FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = 'txui_watch' AND TABLE_NAME = 'storage_test'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let options: String = storage.get(0);
    assert!(
        options
            .to_lowercase()
            .replace('`', "")
            .contains("page_compressed=1"),
        "compression option missing: {options}"
    );
    let allocated_free: Option<u64> = storage.get(1);
    println!("  native progress available with performance_schema=OFF; {options}; DATA_FREE={allocated_free:?}");
    sqlx::query("OPTIMIZE TABLE storage_test")
        .execute(&pool)
        .await
        .unwrap();
}

#[tokio::test]
#[ignore = "requires dbctl tmp postgresql@17"]
async fn dbctl_postgres_watch_lock_completion_and_privileges() {
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect(&database_url())
        .await
        .expect("PostgreSQL connection");
    let version: String = sqlx::query_scalar("SELECT VERSION()")
        .fetch_one(&pool)
        .await
        .unwrap();
    println!("  watching {version}");
    sqlx::query("CREATE TABLE watch_test(id INTEGER PRIMARY KEY, value TEXT)")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO watch_test VALUES (1, 'a'), (2, 'b'), (3, 'c')")
        .execute(&pool)
        .await
        .unwrap();

    let mut old_tx = pool.begin().await.unwrap();
    let old_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *old_tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO watch_test VALUES (4, 'held open')")
        .execute(&mut *old_tx)
        .await
        .unwrap();
    let index_pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&database_url())
        .await
        .unwrap();
    let index_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&index_pool)
        .await
        .unwrap();
    let running = tokio::spawn(async move {
        sqlx::query("CREATE INDEX CONCURRENTLY watch_value_idx ON watch_test(value)")
            .execute(&index_pool)
            .await
            .unwrap();
    });

    let mut saw_locker = false;
    for _ in 0..100 {
        let locker: Option<i64> = sqlx::query_scalar(
            "SELECT current_locker_pid FROM pg_stat_progress_create_index WHERE pid = $1",
        )
        .bind(index_pid)
        .fetch_optional(&pool)
        .await
        .unwrap()
        .flatten();
        if locker == Some(i64::from(old_pid)) {
            saw_locker = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(
        saw_locker,
        "concurrent index never named the older transaction"
    );

    sqlx::query("CREATE ROLE watch_limited LOGIN PASSWORD 'watch_only'")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("GRANT SELECT ON watch_test TO watch_limited")
        .execute(&pool)
        .await
        .unwrap();
    let limited_options = PgConnectOptions::from_str(&database_url())
        .unwrap()
        .username("watch_limited")
        .password("watch_only");
    let limited = PgPoolOptions::new()
        .max_connections(1)
        .connect_with(limited_options)
        .await
        .unwrap();
    let hidden_query: String =
        sqlx::query_scalar("SELECT query FROM pg_stat_activity WHERE pid = $1")
            .bind(old_pid)
            .fetch_one(&limited)
            .await
            .unwrap();
    assert_eq!(hidden_query, "<insufficient privilege>");

    old_tx.rollback().await.unwrap();
    running.await.unwrap();
    let remaining: Option<i32> =
        sqlx::query_scalar("SELECT pid FROM pg_stat_progress_create_index WHERE pid = $1")
            .bind(index_pid)
            .fetch_optional(&pool)
            .await
            .unwrap();
    assert_eq!(
        remaining, None,
        "completed index remained in the progress view"
    );
    sqlx::query("ALTER TABLE watch_test ADD COLUMN note TEXT")
        .execute(&pool)
        .await
        .unwrap();
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM watch_test")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 3);
}

#[tokio::test]
#[ignore = "requires TXUI_MSSQL_* and a live SQL Server"]
async fn mssql_watch_metadata_live() {
    let Some((config, password)) = super::sqlserver::live_tests::live_config() else {
        println!("no SQL Server endpoint configured — skipping");
        return;
    };
    let monitor = super::sqlserver::open(&config, password.clone()).await.unwrap();
    let blocker = super::sqlserver::open(&config, password.clone()).await.unwrap();
    let ddl = super::sqlserver::open(&config, password).await.unwrap();
    let execute = super::sqlserver::execute;

    execute(&monitor, "DROP TABLE IF EXISTS dbo.watch_live").await.unwrap();
    execute(&monitor, "CREATE TABLE dbo.watch_live(id INT PRIMARY KEY, value NVARCHAR(64))")
        .await.unwrap();
    execute(&monitor, "INSERT INTO dbo.watch_live
        SELECT TOP (100000) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)),
               CONVERT(NVARCHAR(64), NEWID())
        FROM sys.all_objects a CROSS JOIN sys.all_objects b").await.unwrap();

    execute(&blocker, "BEGIN TRAN; SELECT * FROM dbo.watch_live WITH (TABLOCKX)")
        .await.unwrap();
    let running = tokio::spawn(async move {
        execute(&ddl, "CREATE INDEX watch_live_value_idx ON dbo.watch_live(value)
                       WITH (ONLINE = ON, RESUMABLE = ON, MAXDOP = 1)").await
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    execute(&blocker, "ROLLBACK").await.unwrap();

    let mut observed = false;
    for _ in 0..500 {
        let rows = execute(&monitor,
            "SELECT state_desc, percent_complete, page_count
             FROM sys.index_resumable_operations WHERE sql_text LIKE '%watch_live%'")
            .await.unwrap();
        if let Some(row) = rows.rows.first() {
            if execute(&monitor, "ALTER INDEX watch_live_value_idx ON dbo.watch_live PAUSE").await.is_ok() {
                observed = true;
                println!("  resumable {:?} · {:?}% · {:?} pages", row[0], row[1], row[2]);
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(observed, "resumable index could not be paused and observed in its catalog view");
    if let Err(error) = running.await.unwrap() {
        let message = error.to_string();
        assert!(message.contains("1219") || message.contains("disconnected"),
            "unexpected CREATE INDEX failure: {message}");
        println!("  expected PAUSE-side DDL disconnect: {message}");
    }
    execute(&monitor, "ALTER INDEX watch_live_value_idx ON dbo.watch_live RESUME").await.unwrap();
    assert!(execute(&monitor,
        "SELECT object_id FROM sys.index_resumable_operations WHERE sql_text LIKE '%watch_live%'")
        .await.unwrap().rows.is_empty());

    let eligible = execute(&monitor,
        "SELECT s.name, t.name, i.name, i.type, i.is_disabled, i.has_filter,
                CASE WHEN i.type = 1 AND EXISTS (
                  SELECT 1 FROM sys.columns c JOIN sys.types ty ON ty.user_type_id = c.user_type_id
                  WHERE c.object_id = i.object_id AND ty.name IN ('text', 'ntext', 'image')
                ) THEN 1 ELSE 0 END AS legacy_lob
         FROM sys.indexes i
         JOIN sys.tables t ON t.object_id = i.object_id
         JOIN sys.schemas s ON s.schema_id = t.schema_id
         WHERE i.type > 0 AND (s.name = 'dbo' AND t.name = 'watch_live')")
        .await.unwrap();
    assert!(eligible.rows.len() >= 2, "per-index eligibility probe missed indexes");

    execute(&monitor, "DROP EVENT SESSION txui_watch_progress ON SERVER").await.ok();
    execute(&monitor, "CREATE EVENT SESSION txui_watch_progress ON SERVER
        ADD EVENT sqlserver.progress_report_online_index_operation(
          ACTION(sqlserver.session_id))
        ADD TARGET package0.ring_buffer(SET max_events_limit = 100);
        ALTER EVENT SESSION txui_watch_progress ON SERVER STATE = START")
        .await.unwrap();
    execute(&monitor, "ALTER INDEX watch_live_value_idx ON dbo.watch_live REBUILD WITH (ONLINE = ON)")
        .await.unwrap();
    let event_rows = execute(&monitor,
        "SELECT s.name,
                e.event_xml.value('(@timestamp)[1]', 'datetime2'),
                CAST(e.event_xml.query('.') AS nvarchar(max))
         FROM sys.dm_xe_sessions s
         JOIN sys.dm_xe_session_targets t ON t.event_session_address = s.address
         JOIN sys.dm_xe_session_events ev ON ev.event_session_address = s.address
         CROSS APPLY (SELECT CAST(t.target_data AS xml) AS target_xml) x
         CROSS APPLY x.target_xml.nodes('/RingBufferTarget/event[@name=\"progress_report_online_index_operation\"]') e(event_xml)
         WHERE t.target_name = 'ring_buffer'
           AND ev.event_name = 'progress_report_online_index_operation'
         ORDER BY 2").await.unwrap();
    assert!(!event_rows.rows.is_empty(), "online index Extended Event query returned no events");
    execute(&monitor, "ALTER EVENT SESSION txui_watch_progress ON SERVER STATE = STOP;
                       DROP EVENT SESSION txui_watch_progress ON SERVER").await.unwrap();

    execute(&monitor,
        "SELECT node_id, physical_operator_name,
                SUM(row_count), SUM(estimate_row_count),
                SUM(elapsed_time_ms), SUM(cpu_time_ms)
         FROM sys.dm_exec_query_profiles
         WHERE session_id = @@SPID
         GROUP BY node_id, physical_operator_name
         ORDER BY node_id").await.unwrap();
    execute(&monitor, "DROP TABLE IF EXISTS dbo.watch_live").await.unwrap();
}
