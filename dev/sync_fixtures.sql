-- Fixture schemas for the sync conformance vectors.
--
-- `dev/gen_sync_vectors.mjs` reads every `SHOW CREATE TABLE` from the live
-- servers on 3306 and 3307 and uses the servers' own rendering as golden
-- vectors. That is the point — a parser checked only against DDL its author
-- wrote is checked against their assumptions, and it is what caught
-- `UNIQUE KEY `x`` losing its name in the Rust port.
--
-- But it means the conformance test depends on server state, which without
-- this file exists only on the machine that first created it. Run this against
-- 3306 to recreate the source schemas, then regenerate:
--
--   mysql -h 127.0.0.1 -P 3306 -u root -p < dev/sync_fixtures.sql
--   npm run sync:vectors
--
-- Each table exists to carry a case the others do not.

-- ── txui_sync_src: the kitchen sink ─────────────────────────────────────────
-- Composite PK, unique key, two plain keys, a fulltext key, a foreign key, a
-- check constraint, a stored generated column, a virtual one, an
-- AUTO_INCREMENT counter, and a DEFAULT containing a comma.
DROP DATABASE IF EXISTS txui_sync_src;
CREATE DATABASE txui_sync_src;
USE txui_sync_src;

CREATE TABLE customer (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(20) NOT NULL,
  UNIQUE KEY uq_code (code)
) ENGINE=InnoDB;

CREATE TABLE invoice (
  id BIGINT AUTO_INCREMENT,
  customer_id INT NOT NULL,
  email VARCHAR(120) NOT NULL,
  notes TEXT,
  amount DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  ratio DOUBLE DEFAULT NULL,                      -- excluded from checksums
  issued_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,  -- DEFAULT_GENERATED
  meta JSON DEFAULT NULL,
  flags BIT(8) DEFAULT NULL,
  state ENUM('draft','sent','paid') NOT NULL DEFAULT 'draft',
  -- A generated column cannot reference an AUTO_INCREMENT column (error 3109),
  -- so this is derived from `amount` rather than `id`.
  doubled DECIMAL(14,4) GENERATED ALWAYS AS ((amount * 2)) STORED,
  lower_email VARCHAR(120) GENERATED ALWAYS AS (lower(email)) VIRTUAL,
  PRIMARY KEY (id, customer_id),
  UNIQUE KEY uq_email (email),
  KEY ix_customer (customer_id),
  KEY ix_amount (amount, issued_at),
  FULLTEXT KEY ft_notes (notes),
  CONSTRAINT fk_customer FOREIGN KEY (customer_id) REFERENCES customer (id) ON DELETE CASCADE,
  CONSTRAINT ck_amount CHECK ((amount >= 0))
) ENGINE=InnoDB AUTO_INCREMENT=4711 DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_0900_ai_ci ROW_FORMAT=DYNAMIC COMMENT='sync fixture';

-- ── txui_types: every awkward type at once ──────────────────────────────────
-- Binary with 0x00/0xFF, emoji and CJK, tabs/newlines/CR inside TEXT, a literal
-- backslash-N, extreme dates, negative TIME, DECIMAL(30,10), BIT(16), JSON.
DROP DATABASE IF EXISTS txui_types;
CREATE DATABASE txui_types CHARACTER SET utf8mb4;
USE txui_types;

CREATE TABLE torture (
  id INT PRIMARY KEY,
  label VARCHAR(80),
  t_text TEXT, t_blob BLOB, t_varbin VARBINARY(255), t_bin BINARY(8),
  t_ts TIMESTAMP NULL, t_dt DATETIME(6) NULL, t_date DATE NULL, t_time TIME(6) NULL,
  t_dec DECIMAL(30,10) NULL, t_bit BIT(16) NULL, t_json JSON NULL,
  t_enum ENUM('a','b'), t_set SET('x','y','z')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO torture VALUES
 (1,'ascii','hello',0x00010203FF,0xDEADBEEF,0x0102030405060708,
  '2026-01-15 10:30:00','2026-01-15 10:30:00.123456','2026-01-15','10:30:00.123456',
  12345678901234567890.1234567890,b'1010101010101010','{"k":"v"}','a','x,z'),
 (2,'emoji + CJK','😀 漢字 café ñ',0xFF00FF00,'',0x0000000000000000,
  '2026-06-30 23:59:59','1000-01-01 00:00:00.000001','1000-01-01','-838:59:59.000000',
  -0.0000000001,b'0',JSON_OBJECT('emoji','🎉','cjk','漢'),'b','y'),
 (3,'nulls+empty','','','',0x0000000000000000,
  NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,''),
 (4,'tabs/newlines',CONCAT('a',CHAR(9),'b',CHAR(10),'c',CHAR(13),'d'),
  CHAR(0),CHAR(92),0x5C5C5C5C5C5C5C5C,
  '2038-01-19 03:14:07','9999-12-31 23:59:59.999999','9999-12-31','838:59:59.000000',
  99999999999999999999.9999999999,b'1111111111111111','[1,null,true,"\\"q\\""]','a','x,y,z'),
 (5,'backslash-N',CONCAT('lit',CHAR(92),'N'),0x0A0D09,0x2C,0x0908070605040302,
  '1970-01-02 00:00:01','2026-03-01 00:00:00.000000',NULL,'00:00:00.000001',
  0.0000000001,b'1',NULL,NULL,NULL);

-- ── txui_nopk: the chunker's refusal cases ──────────────────────────────────
-- `heap` has no key at all; `uniq_only` has a NOT NULL unique index and no PK,
-- which is the fallback path.
DROP DATABASE IF EXISTS txui_nopk;
CREATE DATABASE txui_nopk;
USE txui_nopk;

CREATE TABLE heap (a INT, b VARCHAR(10)) ENGINE=InnoDB;
CREATE TABLE uniq_only (
  a INT NOT NULL, b VARCHAR(10), UNIQUE KEY uq_a (a)
) ENGINE=InnoDB;
INSERT INTO heap VALUES (1,'x'),(1,'x');
INSERT INTO uniq_only VALUES (1,'x'),(2,'y');
