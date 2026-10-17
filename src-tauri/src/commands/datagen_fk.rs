//! FK-correctness machinery for the data generator (next-gen Phase 4b).
//!
//! All pure — database access stays in `datagen.rs`, which feeds result rows
//! in. Four pieces:
//!
//! 1. **Composite FKs** — a child FK spanning several columns must pick ONE
//!    parent row, not independent per-column values. `fk_groups` groups the
//!    child columns that share `(fk_table, fk_group)`; the pool holds parent
//!    TUPLES and the lead column's pick index is shared with the group's other
//!    columns (the pick itself lives in `gen_row`).
//! 2. **Self-referencing FKs** — `manager_id → employees.id` inside the table
//!    being generated. No pool can be loaded (the table is empty when its run
//!    starts), and none is needed: the target is a `sequence` column, so row
//!    j's value is `start + j·step` — known arithmetically. `FkPool::SelfSeq`
//!    stands in for the loaded pool and the pick is bounded to strictly
//!    earlier rows, which IS the two-pass (the "first pass" is the sequence
//!    formula).
//! 3. **Cycle detection** — `topo_order` re-sorts a run's table list
//!    parents-first. It is STABLE: an input that is already a valid order
//!    comes back identical, so kit per-table seed offsets never move. A cycle
//!    refuses the run with a readable report (`a → b → c → a`) instead of
//!    hanging or silently generating orphans. Breaking a cycle automatically
//!    (deferrable-FK-style second-pass UPDATE) is NOT implemented — the kit
//!    format has no break-edge marker; the refusal message says how to break
//!    it by hand.
//! 4. **Pools past the cap** — the old silent `LIMIT 10000` ceiling is gone.
//!    Pools hold up to `FK_POOL_CAP` distinct tuples; a larger parent is
//!    subsampled server-side by `ORDER BY` a keyed hash of the tuple
//!    (`pool_sample_sql`), deterministic per (seed, data) — `TABLESAMPLE` /
//!    `ORDER BY RAND()` were rejected because "same seed → same world" is the
//!    generator's core promise, and an unseeded server draw breaks it. The
//!    client-side alternative (streaming reservoir sampling) was rejected on
//!    measured simplicity: the db layer has no streaming row API, so a
//!    reservoir would either materialize the whole parent set or need three
//!    new per-engine decoders; the hash-ordered sample is one query, O(pool)
//!    memory, and equally seed-stable.

use std::collections::HashMap;

use super::datagen::{ColumnSpec, GenValue};

/// Distinct parent tuples kept per FK pool. Past this, the parent is
/// subsampled (`pool_sample_sql`). 100k tuples ≈ a few MB — pool memory stays
/// O(cap) however large the parent table is. Raised from the old silent
/// 10,000 (Phase 4b); for parents within the cap the pool query's result is
/// exactly what the old query returned, so small-parent runs are unchanged.
pub const FK_POOL_CAP: usize = 100_000;

// ── Identifiers ───────────────────────────────────────────────────────────────

/// Split a possibly-quoted, possibly dot-qualified identifier into bare parts.
///
/// The fkTable wire format is inconsistent by history: schema kits send it
/// engine-quoted AND schema-qualified (`` `db`.`table` ``, `[db].[table]`),
/// the single-table panel sends whatever the user typed (usually bare
/// `db.table`), and the MSSQL live tests send bare-qualified `dbo.t`. Both
/// quoted and bare forms normalize to the same parts here, so the pool SQL
/// quotes exactly once. Before Phase 4b the quoted kit form was quoted AGAIN
/// by the pool loader — producing a single identifier with literal quote
/// characters in its name, so every kit FK pool failed to load with a
/// hard error. `quote` is '`', '"' or '[' (brackets close with ']').
pub fn ident_parts(raw: &str, quote: char) -> Vec<String> {
    let close = if quote == '[' { ']' } else { quote };
    if !raw.starts_with(quote) {
        return raw.split('.').map(str::to_string).collect();
    }
    let chars: Vec<char> = raw.chars().collect();
    let mut parts: Vec<String> = Vec::new();
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i] != quote {
            // Malformed mix (starts quoted, then isn't) — treat the whole
            // thing as bare rather than guessing.
            return raw.split('.').map(str::to_string).collect();
        }
        i += 1;
        let mut name = String::new();
        while i < chars.len() {
            if chars[i] == close {
                // A doubled close quote is an escaped literal, not the end.
                if i + 1 < chars.len() && chars[i + 1] == close {
                    name.push(close);
                    i += 2;
                } else {
                    i += 1;
                    break;
                }
            } else {
                name.push(chars[i]);
                i += 1;
            }
        }
        parts.push(name);
        if i < chars.len() && chars[i] == '.' {
            i += 1;
        } else {
            break;
        }
    }
    if parts.is_empty() { raw.split('.').map(str::to_string).collect() } else { parts }
}

/// Quote one bare identifier part. Brackets escape with `]]`, the other
/// quotes by doubling themselves.
fn quote_part(name: &str, quote: char) -> String {
    if quote == '[' {
        format!("[{}]", name.replace(']', "]]"))
    } else {
        format!("{q}{}{q}", name.replace(quote, &format!("{q}{q}", q = quote)), q = quote)
    }
}

/// Quote and join normalized parts back into a qualified name.
pub fn quote_qualified(parts: &[String], quote: char) -> String {
    parts.iter().map(|p| quote_part(p, quote)).collect::<Vec<_>>().join(".")
}

/// Comparison key for table identity: normalized parts joined with a unit
/// separator, so quoting style never affects equality and a bare `a.b` cannot
/// collide with the single identifier "a.b" (parts ["a","b"] vs ["a.b"]).
pub fn ident_key(raw: &str, quote: char) -> String {
    ident_parts(raw, quote).join("\u{1f}")
}

// ── Pool SQL ──────────────────────────────────────────────────────────────────

/// The DISTINCT tuple select, unlimited — the shared body of both pool
/// queries — plus the quoted column list for reuse in the sample wrapper.
fn distinct_sql(table: &str, columns: &[String], quote: char) -> (String, String) {
    let t = quote_qualified(&ident_parts(table, quote), quote);
    let quoted: Vec<String> = columns.iter()
        .map(|c| quote_qualified(&ident_parts(c, quote), quote))
        .collect();
    let cols = quoted.join(", ");
    let nn = quoted.iter().map(|c| format!("{c} IS NOT NULL")).collect::<Vec<_>>().join(" AND ");
    (format!("SELECT DISTINCT {cols} FROM {t} WHERE {nn}"), cols)
}

/// The plain pool query: every distinct parent tuple, capped at
/// `FK_POOL_CAP + 1` rows so the loader can tell "fits" from "needs sampling"
/// WITHOUT a separate COUNT(DISTINCT) probe — the extra row is the sentinel.
/// For parents within the cap the limit never binds and the result is exactly
/// the old `LIMIT 10000` query's result, so small-parent runs stay
/// bit-identical.
pub fn pool_select_sql(table: &str, columns: &[String], quote: char) -> String {
    let (inner, _) = distinct_sql(table, columns, quote);
    if quote == '[' {
        // `LIMIT` is not T-SQL; TOP goes between SELECT and DISTINCT.
        inner.replacen("SELECT DISTINCT", &format!("SELECT DISTINCT TOP ({})", FK_POOL_CAP + 1), 1)
    } else {
        format!("{inner} LIMIT {}", FK_POOL_CAP + 1)
    }
}

/// The >cap path: a seeded, deterministic subsample of the parent tuples.
/// `ORDER BY` a keyed hash of the tuple — same (seed, parent data) → same
/// pool on every rerun. The hash text casts differ per engine, so a sampled
/// pool is not promised identical ACROSS engines (the unscanned arrival order
/// of the old query never was either); within one engine and seed it is
/// stable. Zipf picks still skew toward early pool entries, i.e. a fixed
/// pseudo-random subset of parents owns most children.
pub fn pool_sample_sql(table: &str, columns: &[String], quote: char, seed: u32) -> String {
    let (inner, cols) = distinct_sql(table, columns, quote);
    let hash = match quote {
        // CONCAT casts numerics implicitly; CHAR(31) (unit separator) keeps
        // tuple boundaries unambiguous. NULLs are excluded by the WHERE.
        '`' => format!("MD5(CONCAT('fk{seed}', {}))", cols.split(", ").collect::<Vec<_>>().join(", CHAR(31), ")),
        '"' => format!(
            "MD5('fk{seed}' || {})",
            cols.split(", ").map(|c| format!("{c}::text")).collect::<Vec<_>>().join(" || chr(31) || ")),
        '[' => format!("HASHBYTES('MD5', CONCAT('fk{seed}', {}))", cols.split(", ").collect::<Vec<_>>().join(", CHAR(31), ")),
        _ => unreachable!("pool SQL knows three quote styles"),
    };
    // The DISTINCT must be computed before the hash ordering, and MySQL/PG
    // forbid ORDER BY on a non-selected expression in a DISTINCT query — so
    // the distinct set is an inner subquery and the sample wraps it.
    if quote == '[' {
        format!("SELECT TOP ({FK_POOL_CAP}) {cols} FROM ({inner}) AS pool_src ORDER BY {hash}")
    } else {
        format!("SELECT {cols} FROM ({inner}) AS pool_src ORDER BY {hash} LIMIT {FK_POOL_CAP}")
    }
}

/// Rows → tuples, dropping short or undecodable rows (the WHERE already
/// excluded NULLs). For width 1 the pool holds exactly the values the legacy
/// single-value pool held, in the same arrival order.
pub fn rows_to_tuples(rows: Vec<Vec<serde_json::Value>>, width: usize) -> Vec<Vec<GenValue>> {
    rows.into_iter().filter_map(|row| {
        if row.len() < width { return None; }
        row.into_iter().take(width).map(|v| json_to_genvalue(Some(v))).collect::<Option<Vec<_>>>()
    }).collect()
}

/// JSON cell → generator value. A failed typed decode must not masquerade as
/// a value; the row is dropped by the caller (moved here from datagen.rs).
pub fn json_to_genvalue(v: Option<serde_json::Value>) -> Option<GenValue> {
    match v {
        Some(serde_json::Value::Number(n)) => n.as_i64().map(GenValue::Int)
            .or_else(|| n.as_f64().map(GenValue::Float)),
        Some(serde_json::Value::String(s)) => Some(GenValue::Str(s)),
        Some(serde_json::Value::Bool(b)) => Some(GenValue::Bool(b)),
        _ => None,
    }
}

// ── FK groups and pools ───────────────────────────────────────────────────────

/// What one spec column does at FK-pick time (see gen_row in datagen.rs).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FkSlot {
    /// Not an FK pick (also: an `fk` generator without table/column params —
    /// legacy behavior yields NULL).
    Plain,
    /// Independent single-column FK — the legacy shape, one pool per column.
    Single,
    /// First column (spec order) of a composite group: draws the shared pick
    /// index from the tuple pool and remembers it for the group.
    Lead(usize),
    /// Later column of a composite group (group id, tuple position): reads
    /// the remembered pick — NO RNG draw, so the tuple stays correlated.
    Member(usize, usize),
}

/// One FK pick unit: a single column, or the columns of a composite group in
/// tuple order (`members[0]` is the lead; the pool sits at `members[0]`).
#[derive(Debug, Clone)]
pub struct FkGroup {
    pub lead: usize,
    pub members: Vec<usize>,
    /// fk_table as sent (quoted or bare — normalize before use).
    pub table: String,
    /// fk_column per member, tuple order.
    pub columns: Vec<String>,
}

/// Group the `fk` columns of `specs` into pick units. Columns sharing
/// `(fk_table, fk_group)` form ONE composite group in spec order; a column
/// with no `fk_group` is always its own unit, even if several columns point
/// at the same parent column (legacy per-column behavior).
pub fn fk_groups(specs: &[ColumnSpec]) -> Vec<FkGroup> {
    let mut groups: Vec<FkGroup> = Vec::new();
    let mut named: HashMap<(String, String), usize> = HashMap::new();
    for (i, spec) in specs.iter().enumerate() {
        if spec.generator != "fk" { continue; }
        let (Some(t), Some(c)) = (&spec.params.fk_table, &spec.params.fk_column) else { continue };
        match &spec.params.fk_group {
            None => groups.push(FkGroup { lead: i, members: vec![i], table: t.clone(), columns: vec![c.clone()] }),
            Some(g) => {
                let key = (t.clone(), g.clone());
                if let Some(&gi) = named.get(&key) {
                    groups[gi].members.push(i);
                    groups[gi].columns.push(c.clone());
                } else {
                    named.insert(key, groups.len());
                    groups.push(FkGroup { lead: i, members: vec![i], table: t.clone(), columns: vec![c.clone()] });
                }
            }
        }
    }
    groups
}

/// The FK state for one table's generation: per-spec pools (a composite
/// group's tuple pool sits at its LEAD index), the slot each column plays,
/// and group bookkeeping for the pick memory.
#[derive(Debug, Clone)]
pub struct FkPools {
    pub pools: Vec<Option<FkPool>>,
    pub slots: Vec<FkSlot>,
    /// group id → spec index holding the group's pool.
    pub group_lead: Vec<usize>,
    pub groups: Vec<FkGroup>,
}

impl FkPools {
    /// No pools at all (preview, tests): every `fk` column yields NULL,
    /// exactly as the legacy empty-pool behavior did.
    pub fn none(n: usize) -> Self {
        Self {
            pools: (0..n).map(|_| None).collect(),
            slots: vec![FkSlot::Plain; n],
            group_lead: Vec::new(),
            groups: Vec::new(),
        }
    }

    /// Slots and groups computed, pools empty — the loaders fill them.
    pub fn planned(specs: &[ColumnSpec]) -> Self {
        let groups = fk_groups(specs);
        let mut slots = vec![FkSlot::Plain; specs.len()];
        let mut group_lead = Vec::with_capacity(groups.len());
        for (gi, g) in groups.iter().enumerate() {
            group_lead.push(g.lead);
            if g.members.len() == 1 {
                slots[g.lead] = FkSlot::Single;
            } else {
                slots[g.lead] = FkSlot::Lead(gi);
                for (pos, &m) in g.members.iter().enumerate().skip(1) {
                    slots[m] = FkSlot::Member(gi, pos);
                }
            }
        }
        Self { pools: (0..specs.len()).map(|_| None).collect(), slots, group_lead, groups }
    }
}

/// A parent pool: loaded tuples, or an arithmetic self-reference.
#[derive(Debug, Clone)]
pub enum FkPool {
    /// Loaded (or seeded-sampled) parent tuples; 1-tuples for single FKs.
    Tuples(Vec<Vec<GenValue>>),
    /// Self-reference onto a `sequence` column of the table being generated:
    /// row j's value is `start + j·step` — known without touching the DB.
    /// gen_row bounds the pick to strictly-earlier rows, which is the
    /// two-pass: the sequence formula IS the first pass.
    SelfSeq { start: i64, step: i64 },
}

/// Context for detecting self-references while loading one table's pools:
/// the table being generated (normalized key) and its sequence base.
pub struct SelfRefCtx<'a> {
    pub table_key: String,
    pub seq_start: i64,
    pub specs: &'a [ColumnSpec],
}

/// If `group` points at the table being generated, resolve the self-reference
/// WITHOUT a query (the table is empty at load time; a loaded pool would be
/// empty and every child row would silently get NULL — worse, NOT NULL
/// columns would fail mid-run). Ok(None) = not a self-reference, load from
/// the database as usual.
pub fn self_ref_pool(group: &FkGroup, ctx: &SelfRefCtx, quote: char) -> Result<Option<FkPool>, String> {
    if ident_key(&group.table, quote) != ctx.table_key {
        return Ok(None);
    }
    let col_name = |i: usize| ctx.specs.get(i).map(|s| s.name.as_str()).unwrap_or("?");
    if group.columns.len() != 1 {
        return Err(format!(
            "composite self-referencing FK ('{}') is not supported — \
             a self-reference must target a single sequence column",
            col_name(group.lead)));
    }
    let target = ident_parts(&group.columns[0], quote).join(".");
    let col = ctx.specs.iter().find(|s| s.name == target).ok_or_else(|| format!(
        "self-referencing FK '{}' targets '{target}', which is not a column of this table",
        col_name(group.lead)))?;
    if col.generator != "sequence" {
        return Err(format!(
            "self-referencing FK '{}' targets '{target}', whose generator is '{}' — \
             self-references need a sequence column so earlier rows' ids are known",
            col_name(group.lead), col.generator));
    }
    // Same step normalization as the sequence generator itself, or the pool
    // would invent values the sequence never produces.
    let step = col.params.step.unwrap_or(1.0).round().max(1.0) as i64;
    Ok(Some(FkPool::SelfSeq { start: ctx.seq_start, step }))
}

// ── Topological order ─────────────────────────────────────────────────────────

/// One table in the FK graph: normalized identity, display label, and the
/// normalized parents its FKs reference.
pub struct TopoTable {
    pub key: String,
    pub label: String,
    pub refs: Vec<String>,
}

/// Stable topological sort of a run's tables, parents before children.
///
/// STABLE means: an input that is already a valid parents-first order comes
/// back IDENTICAL (at every step the lowest-index ready node is taken, which
/// for a valid input is exactly the next input node), so kit runs keep their
/// per-table seed offsets and progress order. Self-references and parents
/// outside the run are not ordering constraints (self-FKs resolve row-locally
/// via `FkPool::SelfSeq`; external parents already hold data).
///
/// A cycle is REFUSED with a readable report — the alternative (silently
/// picking an order) inserts children before their parents and fails
/// mid-run after DDL has already landed. Automatic cycle-breaking
/// (deferrable-FK-style NULL now, UPDATE in a second pass) is not
/// implemented: the kit format has no break-edge marker.
pub fn topo_order(tables: &[TopoTable]) -> Result<Vec<usize>, String> {
    let n = tables.len();
    let mut index: HashMap<&str, usize> = HashMap::with_capacity(n);
    for (i, t) in tables.iter().enumerate() {
        if index.insert(t.key.as_str(), i).is_some() {
            return Err(format!("duplicate table '{}' in the generation run", t.label));
        }
    }
    // child → its in-run parents (self/external refs skipped, refs deduped).
    let mut preds: Vec<Vec<usize>> = vec![Vec::new(); n];
    for (i, t) in tables.iter().enumerate() {
        let mut seen = std::collections::HashSet::new();
        for r in &t.refs {
            if *r == t.key || !seen.insert(r.clone()) { continue; }
            if let Some(&p) = index.get(r.as_str()) {
                preds[i].push(p);
            }
        }
    }
    let mut done = vec![false; n];
    let mut order = Vec::with_capacity(n);
    for _ in 0..n {
        let pick = (0..n).find(|&i| !done[i] && preds[i].iter().all(|&p| done[p]));
        match pick {
            Some(i) => { done[i] = true; order.push(i); }
            None => break,
        }
    }
    if order.len() == n {
        return Ok(order);
    }
    // Every leftover node has a leftover predecessor — walk predecessors from
    // the lowest leftover index until a node repeats; that segment is a cycle.
    let start = (0..n).find(|&i| !done[i]).expect("leftover nodes exist");
    let mut path: Vec<usize> = Vec::new();
    let mut cur = start;
    while !path.contains(&cur) {
        path.push(cur);
        cur = *preds[cur].iter().find(|&&p| !done[p])
            .expect("a leftover node has a leftover predecessor");
    }
    let cyc = &path[path.iter().position(|&x| x == cur).unwrap()..];
    // The walk went child→parent; present it parent→child and close the loop.
    let mut names: Vec<&str> = cyc.iter().rev().map(|&i| tables[i].label.as_str()).collect();
    if let Some(first) = names.first().copied() {
        names.push(first);
    }
    Err(format!(
        "foreign-key dependency cycle: {} — generation refused: no parents-first \
         insert order exists. Break the cycle by making one of these FK columns \
         nullable and leaving it NULL, or drop one constraint, then regenerate.",
        names.join(" → ")))
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::datagen::GenParams;

    fn spec(name: &str, generator: &str) -> ColumnSpec {
        ColumnSpec {
            name: name.into(), type_name: "BIGINT".into(),
            generator: generator.into(), unique: false,
            params: GenParams {
                min: 0.0, max: 100.0, date_from: "2024-01-01".into(), date_to: "2024-12-31".into(),
                list: String::new(), null_pct: 0.0, dist: None,
                fk_table: None, fk_column: None, fk_group: None,
                step: None, jitter_pct: None, ride_pings: None, ping_sec: None,
                valid: None, brand: None, iban_country: None,
                lat: None, lon: None, radius_km: None, expr: None,
            },
        }
    }

    fn fk_spec(name: &str, table: &str, column: &str, group: Option<&str>) -> ColumnSpec {
        let mut s = spec(name, "fk");
        s.params.fk_table = Some(table.into());
        s.params.fk_column = Some(column.into());
        s.params.fk_group = group.map(str::to_string);
        s
    }

    // ── identifiers ───────────────────────────────────────────────────────

    #[test]
    fn ident_parts_reads_every_wire_form() {
        // Bare (the panel form and the MSSQL live tests).
        assert_eq!(ident_parts("orders", '`'), ["orders"]);
        assert_eq!(ident_parts("dbo.zz_parent", '['), ["dbo", "zz_parent"]);
        // Quoted + qualified (the kit form).
        assert_eq!(ident_parts("`retail_demo`.`customers`", '`'), ["retail_demo", "customers"]);
        assert_eq!(ident_parts("\"hr_demo\".\"employees\"", '"'), ["hr_demo", "employees"]);
        assert_eq!(ident_parts("[retail_demo].[customers]", '['), ["retail_demo", "customers"]);
        // Quoted name with a dot INSIDE it is one part.
        assert_eq!(ident_parts("[sales.orders]", '['), ["sales.orders"]);
        // Escaped quotes survive.
        assert_eq!(ident_parts("`a``b`", '`'), ["a`b"]);
        assert_eq!(ident_parts("[we]]ird]", '['), ["we]ird"]);
    }

    #[test]
    fn quoting_normalizes_both_forms_to_the_same_sql() {
        // The regression that lived here since the kit path shipped: the
        // quoted-qualified kit form was quoted AGAIN, producing one identifier
        // with literal backticks in its name — every kit FK pool failed.
        for raw in ["customers", "`customers`"] {
            assert_eq!(quote_qualified(&ident_parts(raw, '`'), '`'), "`customers`");
        }
        for raw in ["db.customers", "`db`.`customers`"] {
            assert_eq!(quote_qualified(&ident_parts(raw, '`'), '`'), "`db`.`customers`");
        }
        assert_eq!(quote_qualified(&ident_parts("[dbo].[t]", '['), '['), "[dbo].[t]");
        assert_eq!(quote_qualified(&ident_parts("a.b", '"'), '"'), "\"a\".\"b\"");
    }

    #[test]
    fn ident_keys_compare_regardless_of_quoting() {
        assert_eq!(ident_key("`db`.`t`", '`'), ident_key("db.t", '`'));
        assert_ne!(ident_key("`db.t`", '`'), ident_key("db.t", '`'),
                   "one quoted identifier with a dot ≠ two bare parts");
    }

    // ── pool SQL ──────────────────────────────────────────────────────────

    #[test]
    fn pool_select_sql_quotes_and_caps() {
        // Same shape as the legacy fk_pool_sql; only the cap moved (10k →
        // FK_POOL_CAP + 1 sentinel row, so "fits" needs no COUNT probe).
        assert_eq!(
            pool_select_sql("order", &["key".into()], '`'),
            "SELECT DISTINCT `key` FROM `order` WHERE `key` IS NOT NULL LIMIT 100001");
        assert_eq!(
            pool_select_sql("`db`.`order`", &["`key`".into()], '`'),
            "SELECT DISTINCT `key` FROM `db`.`order` WHERE `key` IS NOT NULL LIMIT 100001");
        assert_eq!(
            pool_select_sql("Order", &["user".into()], '"'),
            "SELECT DISTINCT \"user\" FROM \"Order\" WHERE \"user\" IS NOT NULL LIMIT 100001");
        assert_eq!(
            pool_select_sql("dbo.t", &["c".into()], '['),
            "SELECT DISTINCT TOP (100001) [c] FROM [dbo].[t] WHERE [c] IS NOT NULL");
        // Composite: one DISTINCT over the tuple, all columns null-filtered.
        assert_eq!(
            pool_select_sql("db.t", &["a".into(), "b".into()], '`'),
            "SELECT DISTINCT `a`, `b` FROM `db`.`t` WHERE `a` IS NOT NULL AND `b` IS NOT NULL LIMIT 100001");
    }

    #[test]
    fn pool_sample_sql_is_seeded_and_deterministic() {
        let my = pool_sample_sql("db.t", &["c".into()], '`', 42);
        assert_eq!(my,
            "SELECT `c` FROM (SELECT DISTINCT `c` FROM `db`.`t` WHERE `c` IS NOT NULL) AS pool_src \
             ORDER BY MD5(CONCAT('fk42', `c`)) LIMIT 100000");
        // Same seed → identical statement (same world); another seed → a
        // different subsample.
        assert_eq!(my, pool_sample_sql("db.t", &["c".into()], '`', 42));
        assert_ne!(my, pool_sample_sql("db.t", &["c".into()], '`', 43));
        let pg = pool_sample_sql("db.t", &["a".into(), "b".into()], '"', 7);
        assert_eq!(pg,
            "SELECT \"a\", \"b\" FROM (SELECT DISTINCT \"a\", \"b\" FROM \"db\".\"t\" \
             WHERE \"a\" IS NOT NULL AND \"b\" IS NOT NULL) AS pool_src \
             ORDER BY MD5('fk7' || \"a\"::text || chr(31) || \"b\"::text) LIMIT 100000");
        let ms = pool_sample_sql("dbo.t", &["c".into()], '[', 7);
        assert_eq!(ms,
            "SELECT TOP (100000) [c] FROM (SELECT DISTINCT [c] FROM [dbo].[t] \
             WHERE [c] IS NOT NULL) AS pool_src ORDER BY HASHBYTES('MD5', CONCAT('fk7', [c]))");
    }

    #[test]
    fn rows_to_tuples_drops_short_and_undecodable_rows() {
        let rows = vec![
            vec![serde_json::json!(1), serde_json::json!("a")],
            vec![serde_json::json!(2)],                    // short
            vec![serde_json::Value::Null, serde_json::json!("b")], // undecodable cell
            vec![serde_json::json!(3), serde_json::json!("c")],
        ];
        let t = rows_to_tuples(rows, 2);
        assert_eq!(t.len(), 2);
        assert!(matches!(t[0][0], GenValue::Int(1)));
        assert!(matches!(&t[1][1], GenValue::Str(s) if s == "c"));
        // Width 1 is the legacy pool shape: values in arrival order.
        let t1 = rows_to_tuples(vec![vec![serde_json::json!(7)], vec![serde_json::json!(8)]], 1);
        assert_eq!(t1.len(), 2);
        assert!(matches!(t1[0][0], GenValue::Int(7)));
        assert!(matches!(t1[1][0], GenValue::Int(8)));
    }

    // ── groups and slots ──────────────────────────────────────────────────

    #[test]
    fn ungrouped_fk_columns_stay_independent() {
        // Two columns pointing at the SAME parent column must not merge —
        // that is the legacy per-column behavior and it stays bit-identical.
        let specs = vec![
            spec("id", "sequence"),
            fk_spec("order_id", "db.orders", "id", None),
            fk_spec("parent_order", "db.orders", "id", None),
        ];
        let fk = FkPools::planned(&specs);
        assert_eq!(fk.groups.len(), 2);
        assert_eq!(fk.slots[1], FkSlot::Single);
        assert_eq!(fk.slots[2], FkSlot::Single);
        assert_eq!(fk.slots[0], FkSlot::Plain);
    }

    #[test]
    fn grouped_columns_share_one_pick_unit() {
        let specs = vec![
            spec("id", "sequence"),
            fk_spec("a", "db.t", "x", Some("g")),
            spec("note", "words"),
            fk_spec("b", "db.t", "y", Some("g")),
            fk_spec("c", "db.t", "z", Some("g")),
        ];
        let fk = FkPools::planned(&specs);
        assert_eq!(fk.groups.len(), 1);
        assert_eq!(fk.groups[0].members, vec![1, 3, 4], "spec order, not source order");
        assert_eq!(fk.slots[1], FkSlot::Lead(0));
        assert_eq!(fk.slots[3], FkSlot::Member(0, 1));
        assert_eq!(fk.slots[4], FkSlot::Member(0, 2));
        assert_eq!(fk.group_lead, vec![1]);
    }

    #[test]
    fn group_names_do_not_merge_across_parent_tables() {
        // Same group name, different parent table: two independent groups,
        // matching the per-table DDL constraints.
        let specs = vec![
            fk_spec("a", "db.t1", "x", Some("g")),
            fk_spec("b", "db.t2", "y", Some("g")),
        ];
        let fk = FkPools::planned(&specs);
        assert_eq!(fk.groups.len(), 2);
        assert_eq!(fk.slots[0], FkSlot::Single);
        assert_eq!(fk.slots[1], FkSlot::Single);
    }

    #[test]
    fn an_fk_without_params_is_plain_and_yields_null() {
        let specs = vec![spec("x", "fk")];
        let fk = FkPools::planned(&specs);
        assert!(fk.groups.is_empty());
        assert_eq!(fk.slots[0], FkSlot::Plain);
    }

    // ── self-references ───────────────────────────────────────────────────

    fn employees() -> Vec<ColumnSpec> {
        vec![spec("id", "sequence"), fk_spec("manager_id", "`hr`.`employees`", "`id`", None)]
    }

    fn ctx(specs: &[ColumnSpec]) -> SelfRefCtx<'_> {
        SelfRefCtx { table_key: ident_key("`hr`.`employees`", '`'), seq_start: 1, specs }
    }

    #[test]
    fn a_self_reference_becomes_a_sequence_pool() {
        let specs = employees();
        let groups = fk_groups(&specs);
        let pool = self_ref_pool(&groups[0], &ctx(&specs), '`').unwrap();
        assert!(matches!(pool, Some(FkPool::SelfSeq { start: 1, step: 1 })));
    }

    #[test]
    fn self_ref_step_matches_the_sequence_generator() {
        let mut specs = employees();
        specs[0].params.step = Some(2.7);
        let groups = fk_groups(&specs);
        let pool = self_ref_pool(&groups[0], &ctx(&specs), '`').unwrap();
        // 2.7 rounds to 3, exactly as the sequence generator normalizes it.
        assert!(matches!(pool, Some(FkPool::SelfSeq { step: 3, .. })));
    }

    #[test]
    fn other_tables_are_not_self_references() {
        let specs = employees();
        let groups = fk_groups(&[fk_spec("x", "`hr`.`departments`", "`id`", None)]);
        let pool = self_ref_pool(&groups[0], &ctx(&specs), '`').unwrap();
        assert!(pool.is_none());
    }

    #[test]
    fn self_ref_to_a_non_sequence_column_is_a_clear_error() {
        let specs = vec![spec("name", "fullName"), fk_spec("manager", "`hr`.`employees`", "`name`", None)];
        let groups = fk_groups(&specs);
        let err = self_ref_pool(&groups[0], &ctx(&specs), '`').unwrap_err();
        assert!(err.contains("whose generator is 'fullName'"), "{err}");
    }

    #[test]
    fn a_composite_self_reference_is_refused() {
        let specs = vec![
            spec("id", "sequence"),
            fk_spec("m1", "`hr`.`employees`", "`id`", Some("g")),
            fk_spec("m2", "`hr`.`employees`", "`id`", Some("g")),
        ];
        let groups = fk_groups(&specs);
        let err = self_ref_pool(&groups[0], &ctx(&specs), '`').unwrap_err();
        assert!(err.contains("composite self-referencing FK"), "{err}");
    }

    // ── topological order ─────────────────────────────────────────────────

    fn tt(key: &str, refs: &[&str]) -> TopoTable {
        TopoTable {
            key: key.into(), label: key.into(),
            refs: refs.iter().map(|r| r.to_string()).collect(),
        }
    }

    #[test]
    fn a_valid_input_order_comes_back_identical() {
        // Stability is the bit-identity guarantee: kit tables already arrive
        // parents-first, and their per-table seed offsets key off the index.
        let tables = [tt("a", &[]), tt("b", &["a"]), tt("c", &["a"]), tt("d", &["b", "c"])];
        assert_eq!(topo_order(&tables).unwrap(), vec![0, 1, 2, 3]);
        let diamond_shuffled = [tt("a", &[]), tt("c", &["a"]), tt("b", &["a"]), tt("d", &["b", "c"])];
        assert_eq!(topo_order(&diamond_shuffled).unwrap(), vec![0, 1, 2, 3]);
    }

    #[test]
    fn a_child_before_its_parent_is_reordered() {
        let tables = [tt("child", &["parent"]), tt("parent", &[])];
        assert_eq!(topo_order(&tables).unwrap(), vec![1, 0]);
    }

    #[test]
    fn self_references_and_external_parents_are_not_constraints() {
        let tables = [tt("employees", &["employees", "other_schema.depts"]), tt("x", &[])];
        assert_eq!(topo_order(&tables).unwrap(), vec![0, 1]);
    }

    #[test]
    fn a_cycle_is_refused_with_a_readable_report() {
        let tables = [
            tt("orders", &["shipments"]),
            tt("order_items", &["orders"]),
            tt("shipments", &["order_items"]),
        ];
        let err = topo_order(&tables).unwrap_err();
        // The cycle, parent → child, closed; rotation is free but the three
        // names and the refusal must all be there.
        assert!(err.contains("orders → order_items → shipments → orders")
            || err.contains("order_items → shipments → orders → order_items")
            || err.contains("shipments → orders → order_items → shipments"), "{err}");
        assert!(err.contains("generation refused"), "{err}");
        assert!(err.contains("nullable"), "{err}");
    }

    #[test]
    fn a_two_node_cycle_and_a_self_loop_behave_differently() {
        // Two-node cycles refuse (any rotation of the report is correct)…
        let tables = [tt("a", &["b"]), tt("b", &["a"])];
        let err = topo_order(&tables).unwrap_err();
        assert!(err.contains("a → b → a") || err.contains("b → a → b"), "{err}");
        // …a bare self-loop does not (row-local self-FK).
        let tables = [tt("a", &["a"])];
        assert_eq!(topo_order(&tables).unwrap(), vec![0]);
    }

    #[test]
    fn duplicate_tables_are_an_error_not_a_coin_flip() {
        let tables = [tt("a", &[]), tt("a", &[])];
        assert!(topo_order(&tables).unwrap_err().contains("duplicate"));
    }
}
