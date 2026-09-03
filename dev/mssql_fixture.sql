-- TxUI SQL Server test fixture — exercises every object type the schema tree
-- should render, plus the shapes the DBA panels and the type matrix need.
--
-- Target: SQL Server 2019+ (developed against 2022 CU26 in the container from
-- docs/MSSQL_DEV.md). Uses no Enterprise-only features.
--
--   docker exec -i sql2022 /opt/mssql-tools18/bin/sqlcmd \
--     -S localhost -U sa -P 'TxUI_dev_Passw0rd!' -C -i dev/mssql_fixture.sql
--
-- Idempotent: drops and recreates txui_demo every run.

-- sqlcmd defaults QUOTED_IDENTIFIER OFF, and filtered indexes, indexed views,
-- computed-column indexes and XML methods all refuse to be created without it
-- (Msg 1934). Set it explicitly so this file loads the same from sqlcmd, SSMS,
-- Azure Data Studio or TxUI itself.
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

IF DB_ID('txui_demo') IS NOT NULL
BEGIN
    ALTER DATABASE txui_demo SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
    DROP DATABASE txui_demo;
END
GO
CREATE DATABASE txui_demo;
GO
USE txui_demo;
GO
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

-- A second schema, so the tree has to qualify names rather than assume dbo.
CREATE SCHEMA sales;
GO

-- ── Sequence ─────────────────────────────────────────────────────────
-- SQL Server has real sequences (unlike MySQL) — the Sequences panel needs one.
CREATE SEQUENCE sales.invoice_seq AS bigint START WITH 1000 INCREMENT BY 1;
GO

-- ── Tables ───────────────────────────────────────────────────────────
-- Clustered PK + IDENTITY: the ordinary case.
CREATE TABLE sales.customers (
    id          int IDENTITY(1,1) CONSTRAINT pk_customers PRIMARY KEY CLUSTERED,
    name        nvarchar(120)     NOT NULL,
    email       nvarchar(200)     NULL,
    country     char(2)           NOT NULL DEFAULT 'CZ',
    created_at  datetime2(3)      NOT NULL DEFAULT SYSUTCDATETIME(),
    notes       nvarchar(max)     NULL
);
GO
CREATE NONCLUSTERED INDEX ix_customers_country ON sales.customers(country) INCLUDE (name);
-- Filtered index: SQL Server-specific, the designer must round-trip it.
CREATE NONCLUSTERED INDEX ix_customers_with_email
    ON sales.customers(email) WHERE email IS NOT NULL;
GO

CREATE TABLE sales.orders (
    id            bigint IDENTITY(1,1) CONSTRAINT pk_orders PRIMARY KEY CLUSTERED,
    customer_id   int            NOT NULL
        CONSTRAINT fk_orders_customer REFERENCES sales.customers(id),
    status        varchar(16)    NOT NULL
        CONSTRAINT ck_orders_status CHECK (status IN ('new','paid','shipped','cancelled')),
    total         decimal(10,2)  NOT NULL,
    -- Computed + persisted: another designer round-trip case.
    total_with_vat AS CAST(total * 1.21 AS decimal(12,2)) PERSISTED,
    currency      char(3)        NOT NULL DEFAULT 'EUR',
    placed_at     datetimeoffset(3) NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    row_ver       rowversion
);
GO
CREATE NONCLUSTERED INDEX ix_orders_customer ON sales.orders(customer_id);
CREATE NONCLUSTERED INDEX ix_orders_placed  ON sales.orders(placed_at DESC);
GO

-- A HEAP on purpose: no clustered index. The index/fragmentation views must
-- report it as a heap rather than skipping it or crashing on a null index name.
CREATE TABLE sales.audit_raw (
    event_id   uniqueidentifier NOT NULL DEFAULT NEWID(),
    payload    nvarchar(max)    NULL,
    logged_at  datetime2(3)     NOT NULL DEFAULT SYSUTCDATETIME()
);
GO

-- ── The type matrix ──────────────────────────────────────────────────
-- One row per decoding decision in plan-sqlserver.md §1.1. Every column here
-- is a case the row decoder has to get right, and several have no MySQL or
-- PostgreSQL analogue at all.
CREATE TABLE dbo.type_matrix (
    id                int IDENTITY(1,1) PRIMARY KEY,
    c_bit             bit              NULL,
    c_tinyint         tinyint          NULL,
    c_smallint        smallint         NULL,
    c_int             int              NULL,
    c_bigint          bigint           NULL,
    c_decimal         decimal(38,10)   NULL,   -- never through f64
    c_numeric         numeric(18,4)    NULL,
    c_money           money            NULL,   -- no MySQL/PG analogue
    c_smallmoney      smallmoney       NULL,
    c_float           float            NULL,   -- NaN / ±Inf sentinels
    c_real            real             NULL,
    c_date            date             NULL,
    c_time            time(7)          NULL,
    c_datetime        datetime         NULL,
    c_datetime2       datetime2(7)     NULL,   -- precision preserved
    c_smalldatetime   smalldatetime    NULL,
    c_datetimeoffset  datetimeoffset(7) NULL,  -- offset preserved, NOT normalised
    c_char            char(8)          NULL,
    c_varchar         varchar(50)      NULL,
    c_varchar_max     varchar(max)     NULL,   -- streamed
    c_nchar           nchar(8)         NULL,
    c_nvarchar        nvarchar(50)     NULL,
    c_nvarchar_max    nvarchar(max)    NULL,
    c_binary          binary(4)        NULL,
    c_varbinary       varbinary(50)    NULL,
    c_uniqueidentifier uniqueidentifier NULL,  -- exact string
    c_xml             xml              NULL,
    c_geography       geography        NULL,   -- absent from Azure SQL Edge
    c_geometry        geometry         NULL,
    c_hierarchyid     hierarchyid      NULL,   -- absent from Azure SQL Edge
    c_sql_variant     sql_variant      NULL
);
GO

-- Row 1: representative values. Row 2: all NULL — NULL must be checked before
-- any typed decode, so an all-null row is the cheapest regression test there is.
INSERT INTO dbo.type_matrix (
    c_bit, c_tinyint, c_smallint, c_int, c_bigint, c_decimal, c_numeric,
    c_money, c_smallmoney, c_float, c_real, c_date, c_time, c_datetime,
    c_datetime2, c_smalldatetime, c_datetimeoffset, c_char, c_varchar,
    c_varchar_max, c_nchar, c_nvarchar, c_nvarchar_max, c_binary, c_varbinary,
    c_uniqueidentifier, c_xml, c_geography, c_geometry, c_hierarchyid, c_sql_variant)
VALUES (
    1, 255, -32768, -2147483648, 9223372036854775807,
    12345678901234567890.1234567890, 1234.5678,
    922337203685477.5807, 214748.3647,
    1.7976931348623157E+308, 3.4E+38,
    '2026-08-28', '13:45:30.1234567', '2026-08-28T13:45:30.123',
    '2026-08-28T13:45:30.1234567', '2026-08-28T13:45:00',
    '2026-08-28T13:45:30.1234567+02:00',
    'fixed   ', 'varchar value', REPLICATE('x', 9000),
    N'nchar   ', N'Příliš žluťoučký kůň', REPLICATE(N'ú', 9000),
    0xDEADBEEF, 0x0102030405,
    '6F9619FF-8B86-D011-B42D-00C04FC964FF',
    '<root><item id="1">text</item></root>',
    geography::Point(50.0755, 14.4378, 4326),
    geometry::STGeomFromText('LINESTRING(0 0, 10 10)', 0),
    hierarchyid::Parse('/1/2/'),
    CAST(N'variant text' AS sql_variant));
GO
INSERT INTO dbo.type_matrix DEFAULT VALUES;   -- the all-NULL row
GO

-- ── Volume: enough rows for index_physical_stats to be interesting ───
-- 50k orders across 2k customers, then a deliberately fragmented index, so the
-- Index fragmentation view and the future maintenance actions have real work.
INSERT INTO sales.customers (name, email, country)
SELECT TOP (2000)
       CONCAT(N'Customer ', ROW_NUMBER() OVER (ORDER BY (SELECT NULL))),
       CASE WHEN ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) % 3 = 0
            THEN NULL
            ELSE CONCAT('c', ROW_NUMBER() OVER (ORDER BY (SELECT NULL)), '@example.test') END,
       CASE ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) % 4
            WHEN 0 THEN 'CZ' WHEN 1 THEN 'DE' WHEN 2 THEN 'GB' ELSE 'US' END
FROM sys.all_objects a CROSS JOIN sys.all_objects b;
GO
INSERT INTO sales.orders (customer_id, status, total, currency)
SELECT TOP (50000)
       1 + ABS(CHECKSUM(NEWID())) % 2000,
       CASE ABS(CHECKSUM(NEWID())) % 4
            WHEN 0 THEN 'new' WHEN 1 THEN 'paid'
            WHEN 2 THEN 'shipped' ELSE 'cancelled' END,
       CAST(ABS(CHECKSUM(NEWID())) % 100000 / 100.0 AS decimal(10,2)),
       'EUR'
FROM sys.all_objects a CROSS JOIN sys.all_objects b;
GO
-- Fragment ix_orders_placed: delete a scattered third, then update in place.
DELETE FROM sales.orders WHERE id % 3 = 0;
UPDATE sales.orders SET placed_at = DATEADD(day, id % 900, placed_at);
GO

-- ── View ─────────────────────────────────────────────────────────────
CREATE VIEW sales.v_order_totals AS
SELECT c.id AS customer_id, c.name, c.country,
       COUNT(o.id) AS order_count, SUM(o.total) AS lifetime_total
FROM sales.customers c
LEFT JOIN sales.orders o ON o.customer_id = c.id
GROUP BY c.id, c.name, c.country;
GO

-- ── Scalar function ──────────────────────────────────────────────────
CREATE FUNCTION sales.fn_order_total_with_vat(@order_id bigint)
RETURNS decimal(12,2)
AS
BEGIN
    DECLARE @t decimal(12,2);
    SELECT @t = total * 1.21 FROM sales.orders WHERE id = @order_id;
    RETURN @t;
END;
GO

-- ── Table-valued function ────────────────────────────────────────────
CREATE FUNCTION sales.tvf_orders_for_customer(@customer_id int)
RETURNS TABLE
AS
RETURN (SELECT id, status, total, placed_at FROM sales.orders WHERE customer_id = @customer_id);
GO

-- ── Stored procedure, with parameters ────────────────────────────────
CREATE PROCEDURE sales.usp_close_orders
    @older_than_days int = 90,
    @closed          int OUTPUT
AS
BEGIN
    SET NOCOUNT ON;
    UPDATE sales.orders
       SET status = 'cancelled'
     WHERE status = 'new'
       AND placed_at < DATEADD(day, -@older_than_days, SYSDATETIMEOFFSET());
    SET @closed = @@ROWCOUNT;
END;
GO

-- ── Trigger ──────────────────────────────────────────────────────────
CREATE TRIGGER sales.trg_orders_audit
ON sales.orders
AFTER INSERT
AS
BEGIN
    SET NOCOUNT ON;
    INSERT INTO sales.audit_raw (payload)
    SELECT CONCAT('order ', CAST(id AS varchar(20)), ' inserted') FROM inserted;
END;
GO

-- ── Statistics so the plan visualiser has real estimates ─────────────
UPDATE STATISTICS sales.customers;
UPDATE STATISTICS sales.orders;
GO

PRINT 'txui_demo fixture ready';
GO
SELECT
    (SELECT COUNT(*) FROM sales.customers)  AS customers,
    (SELECT COUNT(*) FROM sales.orders)     AS orders,
    (SELECT COUNT(*) FROM dbo.type_matrix)  AS type_matrix_rows;
GO
