-- mgr_fixture_setup.sql — single-node MySQL Group Replication fixture on my84
-- (brew mysql@8.4, 127.0.0.1:3307, root/root, datadir /opt/homebrew/var/mysql-8.4).
--
-- Purpose: performance_schema.replication_group_members /
-- replication_group_member_stats / clone_status / clone_progress answer with
-- real data so TxUI's "⟡ Group replication" tab (utils/groupReplication.ts)
-- can be developed and verified live. Applied 2026-10-02 on MySQL 8.4.10.
--
-- Everything below uses SET PERSIST (mysqld-auto.cnf) — NO config-file
-- edits, so the whole fixture is reversible with RESET PERSIST (see
-- TEARDOWN at the bottom). `dbctl start my84` re-bootstraps the group
-- after every restart (a single-member group cannot re-form itself —
-- its only seed is its own group port, which is not listening while it
-- tries to join; group_replication_start_on_boot just retries and fails,
-- so it was deliberately left OFF).
--
-- ORIGINAL VALUES (recorded 2026-10-02, before any change):
--   server_id                  = 1            (unchanged, GR requirement met)
--   log_bin                    = ON           (unchanged, brew default)
--   binlog_format              = ROW          (unchanged, brew default)
--   binlog_checksum            = CRC32        → SET PERSIST NONE (GR refuses CRC32)
--   gtid_mode                  = OFF          → stepped up (see note below)
--   enforce_gtid_consistency   = OFF          → ON (required before gtid_mode ON)
--   group_replication plugin   = not installed
--   clone plugin               = not installed
--   group_replication_start_on_boot = OFF     (left OFF — dbctl owns the bootstrap)
--
-- Run:  /opt/homebrew/opt/mysql@8.4/bin/mysql -h127.0.0.1 -P3307 -uroot -proot < dev/mgr_fixture_setup.sql

-- ── 1. Binary log / GTID prerequisites ──────────────────────────────────
SET PERSIST binlog_checksum = 'NONE';
SET PERSIST enforce_gtid_consistency = ON;
-- gtid_mode moves exactly one step per statement (ERROR 1788 otherwise):
SET PERSIST gtid_mode = OFF_PERMISSIVE;
SET PERSIST gtid_mode = ON_PERMISSIVE;
SET PERSIST gtid_mode = ON;

-- ── 2. Plugins ──────────────────────────────────────────────────────────
-- group_replication is the engine; clone is installed so the
-- clone_status/clone_progress provisioning probe has tables to answer
-- (the MGR tab's SST-equivalent progress surface).
INSTALL PLUGIN group_replication SONAME 'group_replication.so';
INSTALL PLUGIN clone SONAME 'mysql_clone.so';

-- ── 3. Group identity ───────────────────────────────────────────────────
SET PERSIST group_replication_group_name = '3f8a1c4e-9d2b-4c7a-8e5f-1a2b3c4d5e6f';
SET PERSIST group_replication_local_address = '127.0.0.1:33061';
SET PERSIST group_replication_group_seeds = '127.0.0.1:33061';
SET PERSIST group_replication_single_primary_mode = ON;   -- the default, stated for the record

-- ── 4. Bootstrap the single-member group (dbctl start my84 does this) ───
SET GLOBAL group_replication_bootstrap_group = ON;
START GROUP_REPLICATION;
SET GLOBAL group_replication_bootstrap_group = OFF;

-- ── 5. Verify ───────────────────────────────────────────────────────────
SELECT MEMBER_ID, MEMBER_HOST, MEMBER_PORT, MEMBER_STATE, MEMBER_ROLE, MEMBER_VERSION
  FROM performance_schema.replication_group_members;          -- 1 row, ONLINE, PRIMARY
SELECT COUNT_TRANSACTIONS_CHECKED, COUNT_CONFLICTS_DETECTED,
       COUNT_TRANSACTIONS_REMOTE_IN_APPLIER_QUEUE, COUNT_TRANSACTIONS_REMOTE_APPLIED,
       COUNT_TRANSACTIONS_LOCAL_PROPOSED, COUNT_TRANSACTIONS_LOCAL_ROLLBACK
  FROM performance_schema.replication_group_member_stats;
SELECT @@group_replication_single_primary_mode AS single_primary;  -- 1

-- ── TEARDOWN (full undo, in order) ──────────────────────────────────────
--   STOP GROUP_REPLICATION;
--   RESET PERSIST group_replication_single_primary_mode;
--   RESET PERSIST group_replication_group_seeds;
--   RESET PERSIST group_replication_local_address;
--   RESET PERSIST group_replication_group_name;
--   UNINSTALL PLUGIN clone;
--   UNINSTALL PLUGIN group_replication;
--   -- GTID: step DOWN one step at a time, ONLY if nothing else on my84
--   -- has come to rely on GTIDs (@@gtid_executed non-empty is normal now —
--   -- stepping down is still legal; anonymous transactions were the only
--   -- casualty of turning it ON, and this instance had none of note).
--   SET PERSIST gtid_mode = ON_PERMISSIVE;
--   SET PERSIST gtid_mode = OFF_PERMISSIVE;
--   SET PERSIST gtid_mode = OFF;
--   SET PERSIST enforce_gtid_consistency = OFF;   -- original value
--   SET PERSIST binlog_checksum = 'CRC32';        -- original value
-- After teardown my84 is exactly the pre-fixture brew instance (datadir
-- untouched apart from mysqld-auto.cnf, which RESET PERSIST cleans).
