-- Fixture for src-tauri/src/db/mysql.rs `zero_date_tests`.
--
--   cd src-tauri && cargo test --lib zero_date -- --ignored --nocapture
--
-- Applying this by hand is NOT required: `fixture_pool()` builds the same
-- thing, so the tests work on a bare server and survive someone tidying the
-- database away. Keep the two in step. This file stays because it is the
-- readable version, and because it is handy for poking at the rows manually:
--
--   mysql -u root -proot -h 127.0.0.1 < dev/mysql_zerodate_fixture.sql
--
-- Why it exists: MySQL before NO_ZERO_DATE happily stored '0000-00-00', and
-- plenty of long-lived schemas still contain it. sqlx-mysql reports such a
-- value as SQL NULL (see `zero_date_literal` for the quote from its source),
-- so without a rescue a zero date and a real NULL render as the same empty
-- cell. These rows keep both cases, and their near-misses, on the table.

CREATE DATABASE IF NOT EXISTS txui_zerodate;
USE txui_zerodate;

-- A permissive sql_mode is required to *write* these rows. Reading them back
-- needs nothing special, which is the whole problem: any modern server can be
-- handed a legacy datadir full of them.
SET SESSION sql_mode = '';

DROP TABLE IF EXISTS legacy;
CREATE TABLE legacy (
  id INT PRIMARY KEY,
  d  DATE,
  dt DATETIME,
  ts TIMESTAMP NULL
);
INSERT INTO legacy VALUES
  -- all-zero: sqlx calls this NULL; the rescue path recovers it
  (1, '0000-00-00', '0000-00-00 00:00:00', NULL),
  -- ordinary values: must pass through the rescue path untouched
  (2, '2020-05-01', '2020-05-01 10:00:00', '2020-05-01 10:00:00'),
  -- partially zero: a different failure, and a documented gap
  (3, '2020-00-15', '2020-00-15 00:00:00', NULL),
  -- genuine NULL: must stay distinguishable from row 1
  (4, NULL, NULL, NULL);

-- Zero-length payloads that must NOT be mistaken for zero dates.
DROP TABLE IF EXISTS emptyish;
CREATE TABLE emptyish (
  id INT PRIMARY KEY,
  s  VARCHAR(20),
  b  BLOB,
  t  TIME,
  n  VARCHAR(20)
);
INSERT INTO emptyish VALUES
  (1, '', '', '00:00:00', NULL),
  (2, 'x', 'x', '01:02:03', 'y');
