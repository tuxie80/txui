//! Parquet — a file, and not even a query engine.
//!
//! Every other engine in this app answers SQL. Parquet does not: it is an
//! immutable columnar file with a rich footer. So this module deliberately
//! does two things and refuses everything else:
//!
//! 1. **Expose the footer.** Row groups, column chunks, codecs, encodings,
//!    min/max statistics, null and distinct counts, page-index presence,
//!    bloom filters, the writer that produced the file and its key/value
//!    metadata. That footer is the interesting part of a Parquet file and no
//!    general-purpose tool shows it.
//! 2. **Page through rows**, reading only the row groups a page actually
//!    needs — a 40 GiB file must open as fast as a 4 MiB one.
//!
//! Commands are a fixed vocabulary (see [`execute`]), not SQL. The DBA-views
//! panel drives them the same way it drives Redis commands: the view's `sql`
//! field carries the command, and the driver interprets it. Anything that
//! looks like SQL is rejected with a message saying so, rather than being
//! half-parsed into something that silently returns the wrong rows.
//!
//! ## Datasets
//!
//! A connection's `file_path` may also be a **directory**: a partitioned
//! dataset (`ParquetSource::Dataset`). Opening one walks the tree for
//! Parquet files (capped, see [`MAX_DATASET_FILES`]), reads every footer —
//! still O(footer) per file — and collects the hive `key=value` path segments
//! as partition columns. The footer commands then run per file with a leading
//! `file` column, and FILEINFO summarises the whole.
//!
//! Rows are the one thing footers cannot page across files, so a dataset
//! additionally holds a **read-only in-memory DuckDB session** with a single
//! temp view:
//!
//! ```sql
//! CREATE TEMP VIEW dataset AS SELECT * FROM read_parquet(
//!     ['<root>/**/*.parquet', …], hive_partitioning = true,
//!     union_by_name = true, filename = true)
//! ```
//!
//! and the data browser routes through it (filters and sort become real
//! pushdown SQL instead of an in-memory scan). That is ALL the view is used
//! for: the SQL editor stays refused on dataset sessions in v1 — ad-hoc SQL
//! over Parquet already exists via the DuckDB `:memory:` engine. (DuckDB
//! cannot launch an in-memory database in read-only mode, so the session is
//! an ordinary scratch one; the read-only posture is structural — no user
//! text ever reaches it, only the browser's parameterised SELECTs.) The glob
//! is re-expanded per query, so files added after open appear in the browser
//! automatically; the footer forensics are from open time — reconnect to
//! re-walk.
//!
//! ## GeoParquet
//!
//! A GeoParquet file (spec 1.x) carries a `geo` key in the file-level
//! key/value metadata — a JSON object naming the primary geometry column and
//! describing each geometry column's encoding, geometry types, CRS and bbox.
//! That key is parsed (tolerantly: unknown fields are ignored), surfaced
//! parsed in FILEINFO — the raw value still shows verbatim under KEYVALUE —
//! and used to annotate geometry columns in the tree and the grid headers.
//! WKB is the encoding the row path renders (cells reach the frontend as hex
//! strings, which it parses); the 1.1 native GeoArrow encodings are labelled
//! honestly as not renderable yet.

use anyhow::{anyhow, bail, Result};
use arrow_array::ArrayRef;
use parquet::basic::{Compression, Encoding};
use parquet::file::metadata::ParquetMetaData;
use parquet::file::reader::FileReader;
use parquet::file::serialized_reader::SerializedFileReader;
use parquet::file::statistics::Statistics;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use super::types::{ColumnInfo, ConnectionConfig, PingResult, QueryResult, Row, SchemaNode};

/// An opened Parquet file: the path plus its footer, read once.
///
/// Parquet is immutable, so there is no connection to hold and nothing can
/// change underneath us. Re-reading the footer per query would be pure waste.
pub struct ParquetFile {
    pub path: PathBuf,
    pub metadata: Arc<ParquetMetaData>,
    /// Bytes on disk — the denominator for every "how well does this compress"
    /// question, and not derivable from the footer alone.
    pub file_size: u64,
}

impl std::fmt::Debug for ParquetFile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ParquetFile")
            .field("path", &self.path)
            .field("row_groups", &self.metadata.num_row_groups())
            .field("rows", &self.num_rows())
            .finish()
    }
}

impl ParquetFile {
    pub fn num_rows(&self) -> i64 {
        self.metadata.file_metadata().num_rows()
    }

    /// Leaf columns, in file order. Parquet stores leaves — a struct or list
    /// column is several of them — and the leaf is what carries a codec, an
    /// encoding and statistics, so the leaf is the useful unit here.
    pub fn leaf_names(&self) -> Vec<String> {
        self.metadata
            .file_metadata()
            .schema_descr()
            .columns()
            .iter()
            .map(|c| c.path().string())
            .collect()
    }
}

/// What a Parquet connection opened: one file, or a directory of them.
///
/// Single files keep the pure arrow/parquet path unchanged. A dataset carries
/// everything the footer commands need (every file's footer, the hive
/// partition columns) plus the read-only DuckDB session the row path uses.
pub enum ParquetSource {
    Single(ParquetFile),
    Dataset(ParquetDataset),
}

impl std::fmt::Debug for ParquetSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ParquetSource::Single(file) => f.debug_tuple("Single").field(file).finish(),
            ParquetSource::Dataset(d) => f.debug_tuple("Dataset").field(d).finish(),
        }
    }
}

/// An opened dataset: the root directory, every file's footer, the hive
/// partition keys found in the paths, and the DuckDB session the `dataset`
/// view lives on (see the module docs).
pub struct ParquetDataset {
    pub root: PathBuf,
    pub files: Vec<ParquetFile>,
    /// Hive `key=value` directory names, in first-seen order. Empty when no
    /// path segment of any file has that shape.
    pub partition_cols: Vec<String>,
    pub duck: Arc<super::duckdb::DuckDbSession>,
    /// The exact CREATE VIEW statement run at open — kept as the dataset's
    /// DDL answer (it IS the dataset's definition).
    view_sql: String,
}

impl std::fmt::Debug for ParquetDataset {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ParquetDataset")
            .field("root", &self.root)
            .field("files", &self.files.len())
            .field("partition_cols", &self.partition_cols)
            .field("rows", &self.num_rows())
            .finish()
    }
}

impl ParquetDataset {
    /// Total rows across every file — exact and free: each count is in its
    /// file's footer, not counted.
    pub fn num_rows(&self) -> i64 {
        self.files.iter().map(|f| f.num_rows()).sum()
    }

    /// The directory's own name — the dataset's database/table name in the
    /// tree, the way [`file_stem`] names a single file.
    pub fn name(&self) -> String {
        self.root
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "dataset".into())
    }

    /// A member file's path relative to the root — the value the leading
    /// `file` column carries in the per-file views.
    pub fn relative_path(&self, file: &ParquetFile) -> String {
        file.path
            .strip_prefix(&self.root)
            .unwrap_or(&file.path)
            .to_string_lossy()
            .into_owned()
    }
}

/// Hard cap on files in one dataset. Footer reads are O(1) each, but a
/// wrongly picked root (a home directory, a mount point) must not mean
/// opening a million files — past the cap the error names it.
const MAX_DATASET_FILES: usize = 10_000;

/// Escape a single-quoted SQL string literal.
fn sql_str(v: &str) -> String {
    v.replace('\'', "''")
}

/// Every Parquet file under `root`, recursively, sorted for a stable order.
/// Extensions matched case-insensitively: .parquet, .parq, .pq.
fn walk_parquet_files(root: &Path, cap: usize) -> Result<Vec<PathBuf>> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir)
            .map_err(|e| anyhow!("cannot list {}: {e}", dir.display()))?
        {
            let path = entry.map_err(|e| anyhow!("cannot list {}: {e}", dir.display()))?.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_ascii_lowercase());
            if matches!(ext.as_deref(), Some("parquet") | Some("parq") | Some("pq")) {
                out.push(path);
                if out.len() > cap {
                    bail!(
                        "more than {cap} Parquet files under {} — that is the dataset cap; \
                         open a smaller subtree",
                        root.display()
                    );
                }
            }
        }
    }
    out.sort();
    Ok(out)
}

/// Hive partition keys: the `key` of every `key=value` path segment between
/// the root and a file, in first-seen order across the whole walk.
fn partition_columns(root: &Path, files: &[PathBuf]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for f in files {
        let Ok(rel) = f.strip_prefix(root) else { continue };
        for seg in rel.components().map(|c| c.as_os_str().to_string_lossy()) {
            if let Some((key, value)) = seg.split_once('=') {
                if !key.is_empty() && !value.is_empty() && !out.iter().any(|k| k == key) {
                    out.push(key.to_string());
                }
            }
        }
    }
    out
}

/// Open a directory as a partitioned dataset. See the module docs for the
/// shape; the short version: walk, read every footer, build the DuckDB view.
pub fn open_dataset(root: &Path) -> Result<ParquetDataset> {
    let paths = walk_parquet_files(root, MAX_DATASET_FILES)?;
    if paths.is_empty() {
        bail!("no Parquet files (*.parquet, *.parq, *.pq) under {}", root.display());
    }
    let mut files = Vec::with_capacity(paths.len());
    for p in &paths {
        // A corrupt member must name itself — "not a readable Parquet file"
        // about a 400-file dataset is no help at all.
        files.push(open_path(p).map_err(|e| anyhow!("{}: {e:#}", p.display()))?);
    }
    let partition_cols = partition_columns(root, &paths);

    // DuckDB cannot launch an in-memory database in read-only mode at all
    // ("Cannot launch in-memory database in read-only mode"), so the session
    // is an ordinary scratch one. The read-only posture is structural
    // instead: the only statements this session ever runs are the browser's
    // parameterised SELECT builder, the PREVIEW verb's inlined integer LIMIT,
    // and COPY … TO for export — no user text reaches it.
    let duck = super::duckdb::open_memory_sync(false)?;
    // A read_parquet list fails wholesale when ANY glob matches nothing, so
    // the patterns are built from the extensions the walk actually found —
    // never a speculative `*.parq` about a directory that has none.
    let mut exts: Vec<String> = Vec::new();
    for p in &paths {
        if let Some(e) = p.extension().and_then(|e| e.to_str()) {
            if !exts.iter().any(|x| x == e) {
                exts.push(e.to_string());
            }
        }
    }
    let globs = exts
        .iter()
        .map(|ext| format!("'{}/**/*.{ext}'", sql_str(&root.to_string_lossy())))
        .collect::<Vec<_>>()
        .join(", ");
    let view_sql = format!(
        "CREATE TEMP VIEW dataset AS SELECT * FROM read_parquet([{globs}], \
         hive_partitioning = true, union_by_name = true, filename = true)"
    );
    super::duckdb::execute_params_blocking(&duck, &view_sql, &[])?;

    Ok(ParquetDataset {
        root: root.to_path_buf(),
        files,
        partition_cols,
        duck: Arc::new(duck),
        view_sql,
    })
}

pub fn open(config: &ConnectionConfig) -> Result<ParquetSource> {
    let path = config
        .file_path
        .as_deref()
        .filter(|p| !p.trim().is_empty())
        .ok_or_else(|| anyhow!("no Parquet file chosen for this connection"))?;
    let p = Path::new(path);
    // A directory is a partitioned dataset; anything else is one file.
    if p.is_dir() {
        Ok(ParquetSource::Dataset(open_dataset(p)?))
    } else {
        Ok(ParquetSource::Single(open_path(p)?))
    }
}

pub fn open_path(path: &Path) -> Result<ParquetFile> {
    if !path.exists() {
        bail!("no such file: {}", path.display());
    }
    let file = File::open(path)?;
    let file_size = file.metadata().map(|m| m.len()).unwrap_or(0);
    // Reading only the footer; the data pages are never touched here, so this
    // is O(footer) regardless of how large the file is.
    // The page index (per-page min/max/null counts) lives in its own section
    // and is NOT read by default. It is what makes the PAGES view possible and
    // what lets a reader skip individual pages, so it is worth the extra read;
    // files written without one simply report absent.
    let opts = parquet::file::serialized_reader::ReadOptionsBuilder::new()
        .with_page_index()
        .build();
    let reader = SerializedFileReader::new_with_options(file, opts)
        .map_err(|e| anyhow!("not a readable Parquet file: {e}"))?;
    Ok(ParquetFile {
        path: path.to_path_buf(),
        metadata: reader.metadata().clone().into(),
        file_size,
    })
}

pub fn ping(src: &ParquetSource) -> PingResult {
    match src {
        ParquetSource::Single(f) => ping_file(f),
        ParquetSource::Dataset(d) => {
            let start = Instant::now();
            PingResult {
                ok: true,
                latency_ms: start.elapsed().as_millis() as u64,
                server_version: Some(format!("Parquet dataset · {} files", d.files.len())),
                error: None,
            }
        }
    }
}

fn ping_file(file: &ParquetFile) -> PingResult {
    let start = Instant::now();
    let created = file
        .metadata
        .file_metadata()
        .created_by()
        .unwrap_or("unknown writer")
        .to_string();
    let geo = match geo_state(file) {
        GeoState::Parsed(m) if !m.version.is_empty() => format!(" · GeoParquet {}", m.version),
        GeoState::Parsed(_) => " · GeoParquet".to_string(),
        _ => String::new(),
    };
    PingResult {
        ok: true,
        latency_ms: start.elapsed().as_millis() as u64,
        server_version: Some(format!(
            "Parquet v{} · {created}{geo}",
            file.metadata.file_metadata().version()
        )),
        error: None,
    }
}

// ── Schema tree ──────────────────────────────────────────────────────────────

/// A Parquet file has no databases and no tables. The tree is therefore one
/// synthetic "table" named after the file, whose children are its columns —
/// which is what makes the data browser and the column list work unchanged.
/// A dataset is the same shape named after the directory, with the summed
/// row count of every file's footer.
pub fn list_schema(src: &ParquetSource, context: Option<&str>) -> Vec<SchemaNode> {
    match src {
        ParquetSource::Single(f) => match context {
            None => vec![SchemaNode::Database { name: file_stem(f) }],
            Some(_) => vec![SchemaNode::Table {
                name: file_stem(f),
                schema: Some(file_stem(f)),
                row_count: Some(f.num_rows()),
                partition_of: None,
                temporal: false,
            }],
        },
        ParquetSource::Dataset(d) => match context {
            None => vec![SchemaNode::Database { name: d.name() }],
            Some(_) => vec![SchemaNode::Table {
                name: d.name(),
                schema: Some(d.name()),
                row_count: Some(d.num_rows()),
                partition_of: None,
                temporal: false,
            }],
        },
    }
}

/// Turn one schema field into a tree node. A primitive is a leaf Column; a
/// group (struct, or list/map, which Parquet models as groups) is a
/// StructColumn carrying its full dotted `path` so its children can be fetched.
fn field_to_node(t: &parquet::schema::types::Type, parent_path: &str) -> SchemaNode {
    use parquet::basic::Repetition;
    let name = t.name().to_string();
    let path = if parent_path.is_empty() { name.clone() } else { format!("{parent_path}.{name}") };
    let rep = t.get_basic_info().repetition();
    let nullable = !matches!(rep, Repetition::REQUIRED);
    if t.is_group() {
        SchemaNode::StructColumn {
            name,
            type_name: if matches!(rep, Repetition::REPEATED) { "list<struct>".into() } else { "struct".into() },
            nullable,
            path,
        }
    } else {
        SchemaNode::Column {
            name,
            type_name: t.get_physical_type().to_string(),
            nullable,
            primary_key: false,
            spatial: None,
        }
    }
}

/// Top-level columns of the file — nested groups appear as expandable
/// StructColumns rather than being flattened to dotted leaves. Columns the
/// GeoParquet metadata names are re-labelled as geometry (see geo_type_label).
fn file_columns(file: &ParquetFile) -> Vec<SchemaNode> {
    let root = file.metadata.file_metadata().schema_descr().root_schema();
    let mut nodes: Vec<SchemaNode> =
        root.get_fields().iter().map(|c| field_to_node(c, "")).collect();
    if let Some(meta) = geo_meta(file) {
        annotate_geo_nodes(&mut nodes, &meta);
    }
    nodes
}

fn node_name(n: &SchemaNode) -> &str {
    match n {
        SchemaNode::Column { name, .. } | SchemaNode::StructColumn { name, .. } => name,
        _ => "",
    }
}

/// Column list for the tree. A dataset's is the merged top-level schema —
/// first file wins on a name conflict — with the hive partition columns and
/// the view's source-file column appended, tagged as what they are (the
/// browser can filter and sort on all of them).
pub fn list_columns(src: &ParquetSource) -> Vec<SchemaNode> {
    match src {
        ParquetSource::Single(f) => file_columns(f),
        ParquetSource::Dataset(d) => {
            let mut seen: std::collections::HashSet<String> = Default::default();
            let mut out = Vec::new();
            for f in &d.files {
                for node in file_columns(f) {
                    if seen.insert(node_name(&node).to_string()) {
                        out.push(node);
                    }
                }
            }
            for pc in &d.partition_cols {
                if seen.insert(pc.clone()) {
                    out.push(SchemaNode::Column {
                        name: pc.clone(),
                        type_name: "VARCHAR · partition".into(),
                        nullable: true,
                        primary_key: false,
                        spatial: None,
                    });
                }
            }
            if seen.insert("filename".to_string()) {
                out.push(SchemaNode::Column {
                    name: "filename".into(),
                    type_name: "VARCHAR · source file".into(),
                    nullable: false,
                    primary_key: false,
                    spatial: None,
                });
            }
            out
        }
    }
}

/// The group a dotted `path` resolves to, if it resolves to a group at all.
fn resolve_group<'a>(
    file: &'a ParquetFile,
    path: &str,
) -> Option<&'a parquet::schema::types::Type> {
    let mut cur = file.metadata.file_metadata().schema_descr().root_schema();
    for seg in path.split('.') {
        cur = cur.get_fields().iter().find(|c| c.name() == seg)?;
    }
    cur.is_group().then_some(cur)
}

/// Children of a nested column identified by its dotted `path` from the root.
/// Empty when the path does not resolve or is not a group. On a dataset the
/// first file whose schema resolves the path answers — the same first-wins
/// rule as the merged column list.
pub fn struct_children(src: &ParquetSource, path: &str) -> Vec<SchemaNode> {
    match src {
        ParquetSource::Single(f) => resolve_group(f, path)
            .map(|g| g.get_fields().iter().map(|c| field_to_node(c, path)).collect())
            .unwrap_or_default(),
        ParquetSource::Dataset(d) => d
            .files
            .iter()
            .find_map(|f| {
                resolve_group(f, path)
                    .map(|g| g.get_fields().iter().map(|c| field_to_node(c, path)).collect())
            })
            .unwrap_or_default(),
    }
}

/// The file name without its extension — used as both database and table name
/// so the tree reads `orders › orders › columns…` rather than showing a path.
pub fn file_stem(file: &ParquetFile) -> String {
    file.path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "parquet".into())
}

pub fn get_ddl(src: &ParquetSource) -> String {
    match src {
        ParquetSource::Single(f) => {
            // Parquet's own schema language, which is what the footer actually holds —
            // printing a CREATE TABLE would be inventing something that never existed.
            let mut buf = Vec::new();
            parquet::schema::printer::print_schema(&mut buf, f.metadata.file_metadata().schema());
            String::from_utf8_lossy(&buf).into_owned()
        }
        ParquetSource::Dataset(d) => {
            // The CREATE VIEW is the dataset's actual definition. The merged
            // schema follows as a comment, since the view text names no columns.
            let mut out = format!(
                "-- Parquet dataset: {} files under {}\n{};\n",
                d.files.len(),
                d.root.display(),
                d.view_sql
            );
            if !d.partition_cols.is_empty() {
                out.push_str(&format!("-- partition columns: {}\n", d.partition_cols.join(", ")));
            }
            out
        }
    }
}

// ── Commands ─────────────────────────────────────────────────────────────────

/// The complete vocabulary. Anything else is an error — including SQL, which
/// is rejected by name so the message is "Parquet is not a query engine"
/// rather than a parse failure.
pub const COMMANDS: &[&str] = &[
    "FILEINFO", "SCHEMA", "ROWGROUPS", "COLUMNCHUNKS", "STATS", "KEYVALUE", "PREVIEW",
    "PAGES", "ENCODINGS", "CODECS", "NULLS", "CARDINALITY", "SKEW", "SORTING",
    "BLOOM", "HEALTH",
];

pub fn execute(src: &ParquetSource, command: &str) -> Result<QueryResult> {
    match src {
        ParquetSource::Single(f) => execute_file(f, command),
        ParquetSource::Dataset(d) => execute_dataset(d, command),
    }
}

/// The dataset form of every verb: per-file views run per file with a leading
/// `file` column (the path relative to the root), FILEINFO summarises the
/// whole dataset, and PREVIEW reads through the DuckDB view — the one verb
/// that was already a row read, so it gains files and partition columns for
/// free.
fn execute_dataset(d: &ParquetDataset, command: &str) -> Result<QueryResult> {
    let start = Instant::now();
    let trimmed = command.trim().trim_end_matches(';').trim();
    let mut parts = trimmed.split_whitespace();
    let verb = parts.next().unwrap_or("").to_ascii_uppercase();
    let arg = parts.next();

    let (columns, rows) = match verb.as_str() {
        "FILEINFO" => dataset_file_info(d),
        "SCHEMA" => per_file(d, schema_rows),
        "ROWGROUPS" => per_file(d, row_groups),
        "COLUMNCHUNKS" => per_file(d, column_chunks),
        "STATS" => per_file(d, stats),
        "KEYVALUE" => per_file(d, key_value),
        "PAGES" => per_file(d, pages),
        "ENCODINGS" => per_file(d, encodings),
        "CODECS" => per_file(d, codecs),
        "NULLS" => per_file(d, nulls),
        "CARDINALITY" => per_file(d, cardinality),
        "SKEW" => per_file(d, skew),
        "SORTING" => per_file(d, sorting),
        "BLOOM" => per_file(d, bloom),
        "HEALTH" => per_file(d, health),
        "PREVIEW" => {
            let n = arg.and_then(|a| a.parse::<usize>().ok()).unwrap_or(100);
            // `n` is a parsed usize — nothing to inject, same rule as the
            // browser's inlined LIMIT.
            let mut r = super::duckdb::execute_params_blocking(
                &d.duck,
                &format!("SELECT * FROM dataset LIMIT {n}"),
                &[],
            )?;
            r.execution_ms = start.elapsed().as_millis() as u64;
            // The DuckDB view knows nothing of the GeoParquet footers, so the
            // map's viewport hint is attached here from the union of the
            // member files' bboxes.
            r.geo_bbox = dataset_geo_bbox(d);
            return Ok(r);
        }
        other if is_sql_ish(other) => bail!(
            "Parquet is a file, not a query engine — `{other}` cannot be run against it. \
             Use the data browser to page through rows, or one of: {}",
            COMMANDS.join(", ")
        ),
        other => bail!("unknown Parquet command `{other}`. Try one of: {}", COMMANDS.join(", ")),
    };

    Ok(QueryResult {
        columns,
        rows,
        rows_affected: None,
        execution_ms: start.elapsed().as_millis() as u64,
        fetch_ms: 0,
        warnings: vec![],
        truncated: false,
        geo_bbox: None,
    })
}

/// Run one per-file view over every file in the dataset, prepending the
/// file's path relative to the root as the leading `file` column.
fn per_file(
    d: &ParquetDataset,
    view: fn(&ParquetFile) -> (Vec<ColumnInfo>, Vec<Row>),
) -> (Vec<ColumnInfo>, Vec<Row>) {
    let mut columns: Option<Vec<ColumnInfo>> = None;
    let mut rows: Vec<Row> = Vec::new();
    for f in &d.files {
        let (c, r) = view(f);
        let rel = d.relative_path(f);
        columns.get_or_insert_with(|| {
            let mut c = c;
            c.insert(0, ColumnInfo { name: "file".into(), type_name: "text".into(), nullable: false });
            c
        });
        for mut row in r {
            row.insert(0, s(rel.clone()));
            rows.push(row);
        }
    }
    (columns.unwrap_or_else(|| cols(&["file"])), rows)
}

/// Dataset-wide summary — the FILEINFO answer for a directory.
fn dataset_file_info(d: &ParquetDataset) -> (Vec<ColumnInfo>, Vec<Row>) {
    let total_size: u64 = d.files.iter().map(|f| f.file_size).sum();
    let total_groups: usize = d.files.iter().map(|f| f.metadata.num_row_groups()).sum();
    let mut rows: Vec<Row> = vec![
        vec![s("root"), s(d.root.to_string_lossy())],
        vec![s("files"), n(d.files.len() as i64)],
        vec![s("rows"), n(d.num_rows())],
        vec![s("row groups"), n(total_groups as i64)],
        vec![s("size on disk"), s(human_bytes(total_size as i64))],
        vec![
            s("partition columns"),
            s(if d.partition_cols.is_empty() {
                "(none — flat directory)".to_string()
            } else {
                d.partition_cols.join(", ")
            }),
        ],
    ];
    // A member file's GeoParquet headline, named by its path relative to the
    // root — the same naming the per-file views use.
    for f in &d.files {
        if let GeoState::Parsed(meta) = geo_state(f) {
            let mut geo_rows = geo_info_rows(&meta);
            geo_rows[0][0] = s(format!("geo · {}", d.relative_path(f)));
            rows.extend(geo_rows);
        }
    }
    (cols(&["property", "value"]), rows)
}

fn execute_file(file: &ParquetFile, command: &str) -> Result<QueryResult> {
    let start = Instant::now();
    let trimmed = command.trim().trim_end_matches(';').trim();
    let mut parts = trimmed.split_whitespace();
    let verb = parts.next().unwrap_or("").to_ascii_uppercase();
    let arg = parts.next();

    let (columns, rows) = match verb.as_str() {
        "FILEINFO" => file_info(file),
        "SCHEMA" => schema_rows(file),
        "ROWGROUPS" => row_groups(file),
        "COLUMNCHUNKS" => column_chunks(file),
        "STATS" => stats(file),
        "KEYVALUE" => key_value(file),
        "PAGES" => pages(file),
        "ENCODINGS" => encodings(file),
        "CODECS" => codecs(file),
        "NULLS" => nulls(file),
        "CARDINALITY" => cardinality(file),
        "SKEW" => skew(file),
        "SORTING" => sorting(file),
        "BLOOM" => bloom(file),
        "HEALTH" => health(file),
        "PREVIEW" => {
            let n = arg.and_then(|a| a.parse::<usize>().ok()).unwrap_or(100);
            return preview(file, n, 0).map(|mut r| {
                r.execution_ms = start.elapsed().as_millis() as u64;
                r
            });
        }
        other if is_sql_ish(other) => bail!(
            "Parquet is a file, not a query engine — `{other}` cannot be run against it. \
             Use the data browser to page through rows, or one of: {}",
            COMMANDS.join(", ")
        ),
        other => bail!("unknown Parquet command `{other}`. Try one of: {}", COMMANDS.join(", ")),
    };

    Ok(QueryResult {
        columns,
        rows,
        rows_affected: None,
        execution_ms: start.elapsed().as_millis() as u64,
        fetch_ms: 0,
        warnings: vec![],
        truncated: false,
        geo_bbox: None,
    })
}

/// Does this look like someone tried to run SQL? Used only to pick a clearer
/// error message.
fn is_sql_ish(verb: &str) -> bool {
    matches!(
        verb,
        "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "CREATE" | "DROP" | "ALTER"
            | "WITH" | "SHOW" | "DESCRIBE" | "DESC" | "EXPLAIN" | "TRUNCATE" | "MERGE"
    )
}

fn cols(names: &[&str]) -> Vec<ColumnInfo> {
    names
        .iter()
        .map(|n| ColumnInfo { name: (*n).to_string(), type_name: "text".into(), nullable: true })
        .collect()
}

fn s(v: impl Into<String>) -> serde_json::Value {
    serde_json::Value::String(v.into())
}
fn n(v: i64) -> serde_json::Value {
    serde_json::Value::Number(v.into())
}

fn file_info(f: &ParquetFile) -> (Vec<ColumnInfo>, Vec<Row>) {
    let fm = f.metadata.file_metadata();
    let total_compressed: i64 = f.metadata.row_groups().iter().map(|rg| rg.compressed_size()).sum();
    let total_raw: i64 = f.metadata.row_groups().iter().map(|rg| rg.total_byte_size()).sum();
    let mut rows: Vec<Row> = vec![
        vec![s("path"), s(f.path.to_string_lossy())],
        vec![s("file size"), s(human_bytes(f.file_size as i64))],
        vec![s("format version"), s(fm.version().to_string())],
        vec![s("created by"), s(fm.created_by().unwrap_or("(not recorded)"))],
        vec![s("rows"), n(fm.num_rows())],
        vec![s("row groups"), n(f.metadata.num_row_groups() as i64)],
        vec![s("leaf columns"), n(fm.schema_descr().num_columns() as i64)],
        vec![s("compressed"), s(human_bytes(total_compressed))],
        vec![s("uncompressed"), s(human_bytes(total_raw))],
        vec![s("compression ratio"), s(ratio(total_raw, total_compressed))],
        vec![
            s("column index"),
            s(if f.metadata.column_index().is_some() { "present" } else { "absent" }),
        ],
        vec![
            s("offset index"),
            s(if f.metadata.offset_index().is_some() { "present" } else { "absent" }),
        ],
    ];
    match geo_state(f) {
        GeoState::Absent => {}
        GeoState::Parsed(meta) => rows.extend(geo_info_rows(&meta)),
        GeoState::Invalid(e) => rows.push(vec![
            s("geo"),
            s(format!("present but not valid GeoParquet JSON ({e}) — the raw value is under KEYVALUE")),
        ]),
    }
    (cols(&["property", "value"]), rows)
}

fn schema_rows(f: &ParquetFile) -> (Vec<ColumnInfo>, Vec<Row>) {
    let descr = f.metadata.file_metadata().schema_descr();
    let rows = descr
        .columns()
        .iter()
        .enumerate()
        .map(|(i, c)| {
            vec![
                n(i as i64),
                s(c.path().string()),
                s(physical_type(c)),
                s(c.logical_type_ref()
                    .map(|l| format!("{l:?}"))
                    .or_else(|| c.converted_type().to_string().into())
                    .unwrap_or_default()),
                s(if c.max_def_level() > 0 { "OPTIONAL" } else { "REQUIRED" }),
                n(c.max_def_level() as i64),
                n(c.max_rep_level() as i64),
            ]
        })
        .collect();
    (
        cols(&["#", "column", "physical_type", "logical_type", "repetition", "def_level", "rep_level"]),
        rows,
    )
}

fn row_groups(f: &ParquetFile) -> (Vec<ColumnInfo>, Vec<Row>) {
    let rows = f
        .metadata
        .row_groups()
        .iter()
        .enumerate()
        .map(|(i, rg)| {
            vec![
                n(i as i64),
                n(rg.num_rows()),
                n(rg.num_columns() as i64),
                s(human_bytes(rg.compressed_size())),
                s(human_bytes(rg.total_byte_size())),
                s(ratio(rg.total_byte_size(), rg.compressed_size())),
                rg.file_offset().map(n).unwrap_or(serde_json::Value::Null),
            ]
        })
        .collect();
    (
        cols(&["row_group", "rows", "columns", "compressed", "uncompressed", "ratio", "file_offset"]),
        rows,
    )
}

fn column_chunks(f: &ParquetFile) -> (Vec<ColumnInfo>, Vec<Row>) {
    let mut rows = Vec::new();
    for (gi, rg) in f.metadata.row_groups().iter().enumerate() {
        for cc in rg.columns() {
            let (min, max, nulls, distinct) = stat_parts(cc.statistics());
            rows.push(vec![
                n(gi as i64),
                s(cc.column_path().string()),
                s(codec_name(cc.compression())),
                s(cc.encodings().map(|e| encoding_name(&e)).collect::<Vec<_>>().join(", ")),
                s(human_bytes(cc.compressed_size())),
                s(human_bytes(cc.uncompressed_size())),
                s(ratio(cc.uncompressed_size(), cc.compressed_size())),
                min,
                max,
                nulls,
                distinct,
                s(if cc.bloom_filter_offset().is_some() { "yes" } else { "" }),
            ]);
        }
    }
    (
        cols(&[
            "row_group", "column", "codec", "encodings", "compressed", "uncompressed", "ratio",
            "min", "max", "nulls", "distinct", "bloom",
        ]),
        rows,
    )
}

/// Per-column totals across every row group — the "what is this file made of"
/// view. Min/max are folded across groups as strings, which is exact for
/// numbers of equal width and indicative otherwise; the per-chunk view has the
/// unfolded truth.
fn stats(f: &ParquetFile) -> (Vec<ColumnInfo>, Vec<Row>) {
    let leaves = f.leaf_names();
    let mut rows = Vec::new();
    for (li, name) in leaves.iter().enumerate() {
        let mut compressed = 0i64;
        let mut raw = 0i64;
        let mut nulls = 0i64;
        let mut have_nulls = false;
        let mut codecs: Vec<String> = Vec::new();
        for rg in f.metadata.row_groups() {
            let Some(cc) = rg.columns().get(li) else { continue };
            compressed += cc.compressed_size();
            raw += cc.uncompressed_size();
            if let Some(st) = cc.statistics() {
                if let Some(nc) = st.null_count_opt() {
                    nulls += nc as i64;
                    have_nulls = true;
                }
            }
            let c = codec_name(cc.compression()).to_string();
            if !codecs.contains(&c) {
                codecs.push(c);
            }
        }
        rows.push(vec![
            s(name.clone()),
            s(codecs.join(", ")),
            s(human_bytes(compressed)),
            s(human_bytes(raw)),
            s(ratio(raw, compressed)),
            if have_nulls { n(nulls) } else { serde_json::Value::Null },
            s(pct(compressed, f.metadata.row_groups().iter().map(|r| r.compressed_size()).sum())),
        ]);
    }
    rows.sort_by_key(|r| std::cmp::Reverse(unhuman(r[2].as_str().unwrap_or("0"))));
    (
        cols(&["column", "codec", "compressed", "uncompressed", "ratio", "nulls", "share_of_file"]),
        rows,
    )
}

fn key_value(f: &ParquetFile) -> (Vec<ColumnInfo>, Vec<Row>) {
    let rows = f
        .metadata
        .file_metadata()
        .key_value_metadata()
        .map(|kv| {
            kv.iter()
                .map(|e| vec![s(e.key.clone()), s(e.value.clone().unwrap_or_default())])
                .collect()
        })
        .unwrap_or_default();
    (cols(&["key", "value"]), rows)
}

// ── GeoParquet ───────────────────────────────────────────────────────────────

/// The parsed `geo` metadata (spec 1.x). Unknown fields are ignored, so a
/// newer producer's extras never break the read, and the spec version string
/// is captured verbatim so 1.0 and 1.1 files both read.
#[derive(Debug, Clone, Default, serde::Deserialize)]
struct GeoMeta {
    #[serde(default)]
    version: String,
    #[serde(default)]
    primary_column: String,
    #[serde(default)]
    columns: std::collections::BTreeMap<String, GeoColumnMeta>,
}

/// The CRS statement of one geometry column. The spec keeps three cases apart
/// and so do we: the field ABSENT means OGC:CRS84 (lon/lat WGS 84 — the
/// default drawable case), an explicit null means the producer does not know,
/// and an object is PROJJSON.
#[derive(Debug, Clone, Default)]
enum Crs {
    #[default]
    DefaultCrs84,
    Unknown,
    Projjson(serde_json::Value),
}

/// `deserialize_with` runs whenever the key is present — including when its
/// value is null — while the `Default` covers absence. That pairing is what
/// keeps null and absent distinct (a plain Option cannot).
fn deserialize_crs<'de, D>(d: D) -> std::result::Result<Crs, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(match <Option<serde_json::Value> as serde::Deserialize>::deserialize(d)? {
        Some(v) => Crs::Projjson(v),
        None => Crs::Unknown,
    })
}

/// One entry of the `geo` columns map. Keys are top-level column names.
#[derive(Debug, Clone, Default, serde::Deserialize)]
struct GeoColumnMeta {
    /// "WKB", or a 1.1 native GeoArrow encoding ("point", "linestring", …).
    #[serde(default)]
    encoding: String,
    /// May be empty when the writer did not record them.
    #[serde(default)]
    geometry_types: Vec<String>,
    #[serde(default, deserialize_with = "deserialize_crs")]
    crs: Crs,
    /// RFC 7946 order: [west, south, east, north], plus an optional z pair.
    #[serde(default)]
    bbox: Option<Vec<f64>>,
    #[serde(default)]
    orientation: Option<String>,
    #[serde(default)]
    edges: Option<String>,
    /// 1.1: pointer to a per-row bbox struct column.
    #[serde(default)]
    covering: Option<serde_json::Value>,
}

/// The `geo` key, parsed. A present-but-unparseable value is reported as such
/// rather than silently treated as absent — its raw string stays readable
/// under KEYVALUE.
enum GeoState {
    Absent,
    Parsed(GeoMeta),
    Invalid(String),
}

fn geo_state(f: &ParquetFile) -> GeoState {
    let Some(kv) = f.metadata.file_metadata().key_value_metadata() else {
        return GeoState::Absent;
    };
    let Some(raw) = kv.iter().find(|e| e.key == "geo").and_then(|e| e.value.as_deref()) else {
        return GeoState::Absent;
    };
    match serde_json::from_str::<GeoMeta>(raw) {
        Ok(m) => GeoState::Parsed(m),
        Err(e) => GeoState::Invalid(e.to_string()),
    }
}

/// The parsed metadata, or None when the key is absent or invalid.
fn geo_meta(f: &ParquetFile) -> Option<GeoMeta> {
    match geo_state(f) {
        GeoState::Parsed(m) => Some(m),
        _ => None,
    }
}

/// The CRS as one human phrase, honouring the absent/null/object distinction.
fn crs_summary(crs: &Crs) -> String {
    match crs {
        Crs::DefaultCrs84 => "WGS 84 lon/lat (OGC:CRS84 — GeoParquet default)".into(),
        Crs::Unknown => "unknown CRS".into(),
        Crs::Projjson(v) => projjson_name(v),
    }
}

/// A short name for a PROJJSON object: its authority id when it carries one
/// ("EPSG:4326"), else its own name, else an honest fallback.
fn projjson_name(v: &serde_json::Value) -> String {
    if let Some(id) = v.get("id") {
        let code = id
            .get("code")
            .and_then(|c| c.as_u64().map(|n| n.to_string()).or_else(|| c.as_str().map(String::from)));
        let authority = id.get("authority").and_then(|a| a.as_str());
        match (authority, code) {
            (Some(a), Some(c)) => return format!("{a}:{c}"),
            (None, Some(c)) => return format!("code {c}"),
            _ => {}
        }
    }
    if let Some(name) = v.get("name").and_then(|n| n.as_str()) {
        return format!("{name} (PROJJSON)");
    }
    "custom CRS (PROJJSON)".into()
}

/// The type label a geometry column carries in the tree and the grid headers.
/// WKB is the encoding the row path renders — cells reach the frontend as hex
/// strings it parses. The 1.1 native GeoArrow encodings are nested structs the
/// map cannot draw yet, and the label says so rather than promising.
fn geo_type_label(col: &GeoColumnMeta) -> String {
    if col.encoding.eq_ignore_ascii_case("wkb") {
        "GEOMETRY · GeoParquet WKB".into()
    } else if col.encoding.is_empty() {
        "GEOMETRY · GeoParquet".into()
    } else {
        format!("GEOMETRY · GeoParquet {} — not renderable yet", col.encoding)
    }
}

/// One-line summary of a geometry column for FILEINFO: encoding, geometry
/// types, CRS, bbox and covering, in that order, omitting what is absent.
fn geo_column_summary(col: &GeoColumnMeta) -> String {
    let mut parts = vec![if col.encoding.is_empty() {
        "(encoding not recorded)".to_string()
    } else {
        col.encoding.clone()
    }];
    if !col.geometry_types.is_empty() {
        parts.push(col.geometry_types.join(", "));
    }
    parts.push(crs_summary(&col.crs));
    if let Some(bbox) = &col.bbox {
        let nums = bbox.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(", ");
        parts.push(format!("bbox [{nums}]"));
    }
    if let Some(o) = &col.orientation {
        parts.push(format!("orientation: {o}"));
    }
    if let Some(e) = &col.edges {
        parts.push(format!("{e} edges"));
    }
    if col.covering.is_some() {
        parts.push("has covering bbox column".into());
    }
    parts.join(" · ")
}

/// The primary column's bbox as [west, south, east, north] — what a map view
/// would take as its initial viewport. RFC 7946 order; a 3D bbox (six
/// numbers) contributes its first four. Non-finite values reject the hint:
/// a viewport fit must never see NaN.
pub fn geo_bbox(f: &ParquetFile) -> Option<[f64; 4]> {
    let meta = geo_meta(f)?;
    let col = meta.columns.get(&meta.primary_column)?;
    let b = col.bbox.as_ref()?;
    if b.len() >= 4 && b[..4].iter().all(|v| v.is_finite()) {
        Some([b[0], b[1], b[2], b[3]])
    } else {
        None
    }
}

/// A dataset's viewport hint: the union of every member file's bbox. Cheap by
/// construction — the footers are already in memory from open time. A member
/// without a bbox contributes nothing; a dataset with none returns None.
pub fn dataset_geo_bbox(d: &ParquetDataset) -> Option<[f64; 4]> {
    let mut out: Option<[f64; 4]> = None;
    for f in &d.files {
        let Some(b) = geo_bbox(f) else { continue };
        out = Some(match out {
            None => b,
            Some(acc) => [
                acc[0].min(b[0]),
                acc[1].min(b[1]),
                acc[2].max(b[2]),
                acc[3].max(b[3]),
            ],
        });
    }
    out
}

/// Re-label geometry columns per the parsed `geo` metadata, in place. Both
/// plain leaves (WKB is a BYTE_ARRAY) and struct columns (the 1.1 native
/// encodings) are covered.
fn annotate_geo_nodes(nodes: &mut [SchemaNode], meta: &GeoMeta) {
    for node in nodes.iter_mut() {
        let name = node_name(node).to_string();
        if let Some(col) = meta.columns.get(&name) {
            let label = geo_type_label(col);
            match node {
                SchemaNode::Column { type_name, .. } | SchemaNode::StructColumn { type_name, .. } => {
                    *type_name = label;
                }
                _ => {}
            }
        }
    }
}

/// The same annotation for a result grid's column headers.
fn annotate_geo_columns(columns: &mut [ColumnInfo], meta: &GeoMeta) {
    for c in columns.iter_mut() {
        if let Some(col) = meta.columns.get(&c.name) {
            c.type_name = geo_type_label(col);
        }
    }
}

/// The FILEINFO rows a GeoParquet file adds: one headline (version + primary
/// column) plus one row per geometry column.
fn geo_info_rows(meta: &GeoMeta) -> Vec<Row> {
    let mut rows = vec![vec![
        s("geo"),
        s(format!(
            "GeoParquet {} · primary column: {}",
            if meta.version.is_empty() { "(version not recorded)" } else { &meta.version },
            if meta.primary_column.is_empty() { "(none named)" } else { &meta.primary_column },
        )),
    ]];
    for (name, col) in &meta.columns {
        rows.push(vec![s(format!("geo · {name}")), s(geo_column_summary(col))]);
    }
    rows
}

// ── Row reading ──────────────────────────────────────────────────────────────

/// Does this type need [`cell_json`] rather than the plain Arrow formatter?
fn is_nested(dt: &arrow_schema::DataType) -> bool {
    use arrow_schema::DataType::*;
    matches!(dt, Struct(_) | List(_) | LargeList(_) | FixedSizeList(_, _) | Map(_, _))
}

/// One cell of a nested (struct/list/map) column as real JSON.
///
/// Arrow's display format renders a struct as `{city: nyc, zip: 10001}` —
/// not JSON, not parseable, and the grid's JSON cell viewer has nothing to
/// grab. Nested values become `Value::Object` / `Value::Array` instead, which
/// the grid stringifies compactly and the cell viewer opens as a tree.
/// Primitive leaves still go through the Arrow formatter, so timestamps stay
/// ISO and decimals stay exact text — the same rendering a scalar column gets.
fn cell_json(array: &ArrayRef, row: usize) -> Result<serde_json::Value> {
    use arrow_array::{
        Array, FixedSizeListArray, LargeListArray, ListArray, MapArray, StructArray,
    };
    use arrow_schema::DataType;

    // NULL is checked before anything else: a NULL struct and a struct whose
    // fields all happen to be NULL are different rows and must stay different.
    if array.is_null(row) {
        return Ok(serde_json::Value::Null);
    }
    match array.data_type() {
        DataType::Struct(_) => {
            let st = array.as_any().downcast_ref::<StructArray>().unwrap();
            let mut obj = serde_json::Map::with_capacity(st.num_columns());
            for (i, field) in st.fields().iter().enumerate() {
                obj.insert(field.name().clone(), cell_json(st.column(i), row)?);
            }
            Ok(serde_json::Value::Object(obj))
        }
        DataType::List(_) => {
            let l = array.as_any().downcast_ref::<ListArray>().unwrap();
            list_json(&l.value(row))
        }
        DataType::LargeList(_) => {
            let l = array.as_any().downcast_ref::<LargeListArray>().unwrap();
            list_json(&l.value(row))
        }
        DataType::FixedSizeList(_, _) => {
            let l = array.as_any().downcast_ref::<FixedSizeListArray>().unwrap();
            list_json(&l.value(row))
        }
        DataType::Map(_, _) => {
            let m = array.as_any().downcast_ref::<MapArray>().unwrap();
            let offsets = m.offsets();
            let (from, to) = (offsets[row] as usize, offsets[row + 1] as usize);
            let mut obj = serde_json::Map::with_capacity(to - from);
            // Map keys are never null by construction; they render the same
            // way a scalar cell would.
            for i in from..to {
                obj.insert(leaf_text(m.keys(), i)?, cell_json(m.values(), i)?);
            }
            Ok(serde_json::Value::Object(obj))
        }
        _ => Ok(s(leaf_text(array, row)?)),
    }
}

/// A list slice (one row's elements) as a JSON array.
fn list_json(values: &ArrayRef) -> Result<serde_json::Value> {
    use arrow_array::Array;
    let mut out = Vec::with_capacity(values.len());
    for i in 0..values.len() {
        out.push(cell_json(values, i)?);
    }
    Ok(serde_json::Value::Array(out))
}

/// A primitive leaf through the Arrow formatter — the same text a scalar
/// column produces. NULLs are the caller's business, never formatted here.
fn leaf_text(array: &ArrayRef, row: usize) -> Result<String> {
    use arrow_cast::display::{ArrayFormatter, FormatOptions};
    let fmt = ArrayFormatter::try_new(array.as_ref(), &FormatOptions::default())?;
    Ok(fmt.value(row).to_string())
}

/// Read `limit` rows starting at `offset`.
///
/// Row groups whose row range falls entirely before the offset are skipped
/// outright, so paging deep into a large file does not decode everything
/// before it. Within the remaining groups the reader still decodes from the
/// group boundary — Parquet has no row-level index — but that is bounded by
/// the group size rather than by the file size.
pub fn preview(f: &ParquetFile, limit: usize, offset: usize) -> Result<QueryResult> {
    use arrow_cast::display::{ArrayFormatter, FormatOptions};
    use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;

    let start = Instant::now();
    let file = File::open(&f.path)?;
    let builder = ParquetRecordBatchReaderBuilder::try_new(file)?;

    // Skip whole row groups that end before the offset.
    let mut skip_groups = Vec::new();
    let mut rows_before = 0i64;
    for (i, rg) in f.metadata.row_groups().iter().enumerate() {
        if rows_before + rg.num_rows() <= offset as i64 {
            skip_groups.push(i);
            rows_before += rg.num_rows();
        } else {
            break;
        }
    }
    let keep: Vec<usize> = (0..f.metadata.num_row_groups())
        .filter(|i| !skip_groups.contains(i))
        .collect();
    let within = offset - rows_before as usize;

    let schema = builder.schema().clone();
    let mut reader = builder
        .with_row_groups(keep)
        .with_batch_size(1024.min(limit.max(1) + within).max(1))
        .build()?;

    // Geometry columns carry their GeoParquet label into the grid header,
    // not the bare arrow type (Binary) — same annotation as the schema tree.
    let mut columns: Vec<ColumnInfo> = schema
        .fields()
        .iter()
        .map(|fld| ColumnInfo {
            name: fld.name().clone(),
            type_name: fld.data_type().to_string(),
            nullable: fld.is_nullable(),
        })
        .collect();
    if let Some(meta) = geo_meta(f) {
        annotate_geo_columns(&mut columns, &meta);
    }
    let nested: Vec<bool> = schema.fields().iter().map(|f| is_nested(f.data_type())).collect();

    let opts = FormatOptions::default().with_null("");
    let mut out: Vec<Row> = Vec::new();
    let mut seen = 0usize;
    while out.len() < limit {
        let Some(batch) = reader.next() else { break };
        let batch = batch?;
        let fmts: Vec<ArrayFormatter> = batch
            .columns()
            .iter()
            .map(|c| ArrayFormatter::try_new(c.as_ref(), &opts))
            .collect::<std::result::Result<_, _>>()?;
        for r in 0..batch.num_rows() {
            if seen < within {
                seen += 1;
                continue;
            }
            if out.len() >= limit {
                break;
            }
            let mut row: Row = Vec::with_capacity(fmts.len());
            for (ci, fm) in fmts.iter().enumerate() {
                // NULL must stay NULL rather than becoming the empty string —
                // the two are different and the grid renders them differently.
                if batch.column(ci).is_null(r) {
                    row.push(serde_json::Value::Null);
                } else if nested[ci] {
                    // Structs/lists/maps go out as real JSON objects/arrays,
                    // not arrow's display text, so the grid and the cell
                    // viewer's JSON tree can read them.
                    row.push(cell_json(batch.column(ci), r)?);
                } else {
                    row.push(s(fm.value(r).to_string()));
                }
            }
            out.push(row);
        }
    }

    Ok(QueryResult {
        columns,
        rows: out,
        rows_affected: None,
        execution_ms: start.elapsed().as_millis() as u64,
        fetch_ms: 0,
        warnings: vec![],
        truncated: false,
        // The footer knows the file's whole extent; the page we just read
        // does not. The map fits its first viewport to this.
        geo_bbox: geo_bbox(f),
    })
}

// ── In-memory filtered / sorted scan ─────────────────────────────────────────

/// Cap on rows scanned into memory for a filtered/sorted page. A Parquet file
/// has no query engine, so filtering means a full scan; this bounds the memory
/// and time of that scan, and the caller warns when it bites.
const SCAN_CAP: usize = 1_000_000;

/// Match a value against a SQL `LIKE` pattern (`%` = any run, `_` = one char).
/// Case-insensitive, to match how the SQL engines' browsers behave in practice.
fn like_match(value: &str, pattern: &str) -> bool {
    let v: Vec<char> = value.to_lowercase().chars().collect();
    let p: Vec<char> = pattern.to_lowercase().chars().collect();
    // Classic two-pointer LIKE with backtracking over `%`.
    let (mut vi, mut pi) = (0usize, 0usize);
    let (mut star, mut mark) = (usize::MAX, 0usize);
    while vi < v.len() {
        if pi < p.len() && (p[pi] == '_' || p[pi] == v[vi]) {
            vi += 1; pi += 1;
        } else if pi < p.len() && p[pi] == '%' {
            star = pi; mark = vi; pi += 1;
        } else if star != usize::MAX {
            pi = star + 1; mark += 1; vi = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '%' { pi += 1; }
    pi == p.len()
}

/// Compare two cell strings numerically when both parse as numbers, else
/// lexically. ISO dates and timestamps sort correctly under the lexical branch.
fn cell_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    match (a.parse::<f64>(), b.parse::<f64>()) {
        (Ok(x), Ok(y)) => x.partial_cmp(&y).unwrap_or(std::cmp::Ordering::Equal),
        _ => a.cmp(b),
    }
}

fn passes(cell: &serde_json::Value, f: &crate::db::types::FilterClause) -> bool {
    use crate::db::types::FilterOp::*;
    let is_null = cell.is_null();
    match f.op {
        IsNull => return is_null,
        IsNotNull => return !is_null,
        _ => {}
    }
    if is_null { return false; } // a NULL never satisfies a value comparison
    // Non-string cells (a nested column's JSON object/array) compare against
    // their compact JSON — the same text the grid shows for them.
    let json_owned;
    let cv: &str = match cell {
        serde_json::Value::String(st) => st,
        other => { json_owned = other.to_string(); &json_owned }
    };
    let want = f.value.as_deref().unwrap_or("");
    match f.op {
        Eq  => cell_cmp(cv, want) == std::cmp::Ordering::Equal,
        Neq => cell_cmp(cv, want) != std::cmp::Ordering::Equal,
        Lt  => cell_cmp(cv, want) == std::cmp::Ordering::Less,
        Lte => cell_cmp(cv, want) != std::cmp::Ordering::Greater,
        Gt  => cell_cmp(cv, want) == std::cmp::Ordering::Greater,
        Gte => cell_cmp(cv, want) != std::cmp::Ordering::Less,
        Like => like_match(cv, want),
        NotLike => !like_match(cv, want),
        IsNull | IsNotNull => unreachable!(),
    }
}

/// Are this chunk's statistics written in the same notation as the cells the
/// scan compares against?
///
/// Pushdown compares the filter string against the min/max strings with the
/// same `cell_cmp` the row filter uses, which is only sound when both sides
/// share a representation. Plain integers, floats, booleans and UTF-8 strings
/// qualify. Anything the Arrow formatter renders differently from the raw
/// statistic does not: timestamps and dates are epoch integers in the footer
/// but ISO text in the grid, decimals are scaled bytes, int96 and
/// fixed-len-byte-array bounds print as hex. For those the group is always
/// kept and the scan decides — a missed skip costs time, a wrong skip costs
/// rows.
fn stats_match_cell_format(cc: &parquet::file::metadata::ColumnChunkMetaData) -> bool {
    use parquet::basic::{LogicalType, Type as Physical};
    let descr = cc.column_descr();
    match descr.physical_type() {
        Physical::BOOLEAN => true,
        Physical::INT32 | Physical::INT64 | Physical::FLOAT | Physical::DOUBLE => {
            descr.logical_type_ref().is_none()
        }
        Physical::BYTE_ARRAY => matches!(descr.logical_type_ref(), Some(LogicalType::String)),
        _ => false,
    }
}

/// Can this row group be skipped entirely for these (ANDed) filters?
///
/// Conservative min/max pushdown: returns true only when a group's statistics
/// *prove* no row can satisfy some filter. Anything uncertain — no stats,
/// inexact (deprecated/truncated) stats, a stats representation that doesn't
/// match the cell format, an op that can't be bounded (Neq / LIKE / NULL
/// checks), a column the group doesn't name at this exact path — keeps the
/// group. Never skips a group that might contain a match.
fn rg_excluded(
    rg: &parquet::file::metadata::RowGroupMetaData,
    filters: &[crate::db::types::FilterClause],
) -> bool {
    use crate::db::types::FilterOp::*;
    use std::cmp::Ordering;
    for f in filters {
        // Match the full dotted path: a nested leaf named like a top-level
        // column must not volunteer its bounds for that column's filter.
        let Some(cc) = rg.columns().iter().find(|c| c.column_path().string() == f.column) else { continue };
        if !stats_match_cell_format(cc) { continue; }
        let Some(st) = cc.statistics() else { continue; };
        // Only exact bounds may skip. A stat the writer marks inexact can be
        // narrower than the data it describes, and skipping on it would drop
        // real matches.
        if !st.min_is_exact() || !st.max_is_exact() { continue; }
        let (min, max) = (format_stat_min(st), format_stat_max(st));
        if min.is_empty() || max.is_empty() { continue; }
        let want = f.value.as_deref().unwrap_or("");
        let excluded = match f.op {
            Eq  => cell_cmp(want, &min) == Ordering::Less || cell_cmp(want, &max) == Ordering::Greater,
            Lt  => cell_cmp(&min, want) != Ordering::Less,     // min >= want → none is < want
            Lte => cell_cmp(&min, want) == Ordering::Greater,  // min > want
            Gt  => cell_cmp(&max, want) != Ordering::Greater,  // max <= want
            Gte => cell_cmp(&max, want) == Ordering::Less,     // max < want
            _ => false, // Neq / Like / NotLike / IsNull / IsNotNull: not bounded by min/max
        };
        if excluded { return true; }
    }
    false
}

/// Read a page with in-memory filters and sort. With neither, falls back to the
/// row-group-skipping `preview` fast path. Otherwise it scans (up to SCAN_CAP)
/// the whole file, filters, sorts, then slices [offset, offset+limit) — the
/// "in-memory scan" a file without a query engine has to do.
pub fn preview_filtered(
    f: &ParquetFile,
    limit: usize,
    offset: usize,
    filters: &[crate::db::types::FilterClause],
    sort: &[crate::db::types::SortClause],
) -> Result<QueryResult> {
    if filters.is_empty() && sort.is_empty() {
        return preview(f, limit, offset);
    }
    use arrow_cast::display::{ArrayFormatter, FormatOptions};
    use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;

    let start = Instant::now();
    let file = File::open(&f.path)?;
    let builder = ParquetRecordBatchReaderBuilder::try_new(file)?;
    let schema = builder.schema().clone();

    let mut columns: Vec<ColumnInfo> = schema.fields().iter().map(|fld| ColumnInfo {
        name: fld.name().clone(),
        type_name: fld.data_type().to_string(),
        nullable: fld.is_nullable(),
    }).collect();
    if let Some(meta) = geo_meta(f) {
        annotate_geo_columns(&mut columns, &meta);
    }
    let nested: Vec<bool> = schema.fields().iter().map(|f| is_nested(f.data_type())).collect();
    let col_index = |name: &str| columns.iter().position(|c| c.name == name);

    // Resolve filter/sort columns up front; an unknown column is an error the
    // user can act on rather than a silently empty result.
    let filt: Vec<(usize, &crate::db::types::FilterClause)> = filters.iter()
        .map(|f| col_index(&f.column).map(|i| (i, f))
            .ok_or_else(|| anyhow!("no such column: {}", f.column)))
        .collect::<Result<_>>()?;
    let sorts: Vec<(usize, bool)> = sort.iter()
        .map(|s| col_index(&s.column).map(|i| (i, matches!(s.direction, crate::db::types::SortDir::Desc)))
            .ok_or_else(|| anyhow!("no such column: {}", s.column)))
        .collect::<Result<_>>()?;

    // Min/max pushdown: drop whole row groups whose statistics prove they hold
    // no matching row before decoding any of them.
    let keep: Vec<usize> = f.metadata.row_groups().iter().enumerate()
        .filter(|(_, rg)| !rg_excluded(rg, filters))
        .map(|(i, _)| i)
        .collect();
    let reader = builder.with_row_groups(keep).with_batch_size(8192).build()?;
    let opts = FormatOptions::default().with_null("");
    let mut all: Vec<Row> = Vec::new();
    let mut capped = false;
    'read: for batch in reader {
        let batch = batch?;
        let fmts: Vec<ArrayFormatter> = batch.columns().iter()
            .map(|c| ArrayFormatter::try_new(c.as_ref(), &opts))
            .collect::<std::result::Result<_, _>>()?;
        for r in 0..batch.num_rows() {
            let mut row: Row = Vec::with_capacity(fmts.len());
            for (ci, fm) in fmts.iter().enumerate() {
                if batch.column(ci).is_null(r) {
                    row.push(serde_json::Value::Null);
                } else if nested[ci] {
                    row.push(cell_json(batch.column(ci), r)?);
                } else {
                    row.push(s(fm.value(r).to_string()));
                }
            }
            if filt.iter().all(|(i, f)| passes(&row[*i], f)) {
                all.push(row);
                if all.len() >= SCAN_CAP { capped = true; break 'read; }
            }
        }
    }

    if !sorts.is_empty() {
        all.sort_by(|a, b| {
            for (i, desc) in &sorts {
                let av = a[*i].as_str().unwrap_or("");
                let bv = b[*i].as_str().unwrap_or("");
                // NULLs sort last on ASC (largest), first is symmetric on DESC.
                let ord = match (a[*i].is_null(), b[*i].is_null()) {
                    (true, true) => std::cmp::Ordering::Equal,
                    (true, false) => std::cmp::Ordering::Greater,
                    (false, true) => std::cmp::Ordering::Less,
                    (false, false) => cell_cmp(av, bv),
                };
                let ord = if *desc { ord.reverse() } else { ord };
                if ord != std::cmp::Ordering::Equal { return ord; }
            }
            std::cmp::Ordering::Equal
        });
    }

    let total = all.len();
    let page: Vec<Row> = all.into_iter().skip(offset).take(limit).collect();
    let warnings = if capped {
        vec![format!("scan capped at {SCAN_CAP} matching rows — results may be incomplete")]
    } else { vec![] };

    Ok(QueryResult {
        columns,
        rows: page,
        rows_affected: Some(total as u64),
        execution_ms: start.elapsed().as_millis() as u64,
        fetch_ms: 0,
        warnings,
        truncated: capped,
        geo_bbox: geo_bbox(f),
    })
}

/// CSV/TSV field quoting: wrap in quotes and double internal quotes when the
/// value holds the separator, a quote or a newline.
fn delim_field(s: &str, sep: char) -> String {
    if s.contains(sep) || s.contains('"') || s.contains('\n') || s.contains('\r') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// Stream the whole Parquet file to `out_path` as csv / tsv / (nd)json, one row
/// group at a time — the rows never all live in memory at once, so this handles
/// files far larger than a grid page or a normal export could hold. Returns the
/// row count written.
pub fn export_to_file(f: &ParquetFile, out_path: &Path, format: &str) -> Result<u64> {
    use std::io::Write;
    use arrow_cast::display::{ArrayFormatter, FormatOptions};
    use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;

    let file = File::open(&f.path)?;
    let builder = ParquetRecordBatchReaderBuilder::try_new(file)?;
    let schema = builder.schema().clone();
    let names: Vec<String> = schema.fields().iter().map(|x| x.name().clone()).collect();
    let nested: Vec<bool> = schema.fields().iter().map(|f| is_nested(f.data_type())).collect();
    let reader = builder.with_batch_size(8192).build()?;

    let out = File::create(out_path)
        .map_err(|e| anyhow!("cannot write {}: {e}", out_path.display()))?;
    let mut w = std::io::BufWriter::new(out);

    let json = format == "json" || format == "ndjson";
    let sep = if format == "tsv" { '\t' } else { ',' };
    let sep_s = sep.to_string();
    let opts = FormatOptions::default().with_null("");

    if !json {
        let header = names.iter().map(|n| delim_field(n, sep)).collect::<Vec<_>>().join(&sep_s);
        writeln!(w, "{header}")?;
    }

    let mut rows: u64 = 0;
    for batch in reader {
        let batch = batch?;
        let fmts: Vec<ArrayFormatter> = batch.columns().iter()
            .map(|c| ArrayFormatter::try_new(c.as_ref(), &opts))
            .collect::<std::result::Result<_, _>>()?;
        for r in 0..batch.num_rows() {
            if json {
                let mut obj = serde_json::Map::with_capacity(fmts.len());
                for (ci, fm) in fmts.iter().enumerate() {
                    let v = if batch.column(ci).is_null(r) {
                        serde_json::Value::Null
                    } else if nested[ci] {
                        // ndjson embeds the JSON natively — the object stays
                        // an object, not a string that looks like one.
                        cell_json(batch.column(ci), r)?
                    } else {
                        serde_json::Value::String(fm.value(r).to_string())
                    };
                    obj.insert(names[ci].clone(), v);
                }
                writeln!(w, "{}", serde_json::Value::Object(obj))?;
            } else {
                let line = (0..fmts.len()).map(|ci| {
                    if batch.column(ci).is_null(r) { return Ok(String::new()); }
                    let text = if nested[ci] {
                        // csv/tsv have no nesting; the JSON text is the cell.
                        cell_json(batch.column(ci), r)?.to_string()
                    } else {
                        fmts[ci].value(r).to_string()
                    };
                    Ok(delim_field(&text, sep))
                }).collect::<Result<Vec<_>>>()?.join(&sep_s);
                writeln!(w, "{line}")?;
            }
            rows += 1;
        }
    }
    w.flush()?;
    Ok(rows)
}

/// Stream a whole dataset to csv / tsv / (nd)json through the DuckDB view's
/// own `COPY … TO` — DuckDB streams the scan, so like [`export_to_file`] the
/// rows never all live in memory. A read-only DuckDB connection may still
/// export: COPY TO writes a new file, never the database. Returns the row
/// count written (the sum of the footers — what a full scan must produce).
pub fn export_dataset_to_file(d: &ParquetDataset, out_path: &Path, format: &str) -> Result<u64> {
    let options = match format {
        "csv" => "FORMAT CSV, HEADER",
        "tsv" => "FORMAT CSV, DELIMITER '\t', HEADER",
        "json" | "ndjson" => "FORMAT JSON",
        other => bail!("unknown export format: {other}"),
    };
    let sql = format!(
        "COPY (SELECT * FROM dataset) TO '{}' ({options})",
        sql_str(&out_path.to_string_lossy())
    );
    super::duckdb::execute_params_blocking(&d.duck, &sql, &[])?;
    Ok(d.num_rows() as u64)
}

// ── Formatting helpers ───────────────────────────────────────────────────────

fn physical_type(c: &parquet::schema::types::ColumnDescriptor) -> String {
    c.physical_type().to_string()
}

fn codec_name(c: Compression) -> &'static str {
    match c {
        Compression::UNCOMPRESSED => "UNCOMPRESSED",
        Compression::SNAPPY => "SNAPPY",
        Compression::GZIP(_) => "GZIP",
        Compression::LZO => "LZO",
        Compression::BROTLI(_) => "BROTLI",
        Compression::LZ4 => "LZ4",
        Compression::ZSTD(_) => "ZSTD",
        Compression::LZ4_RAW => "LZ4_RAW",
    }
}

fn encoding_name(e: &Encoding) -> String {
    format!("{e}")
}

fn stat_parts(
    st: Option<&Statistics>,
) -> (serde_json::Value, serde_json::Value, serde_json::Value, serde_json::Value) {
    let Some(st) = st else {
        return (
            serde_json::Value::Null,
            serde_json::Value::Null,
            serde_json::Value::Null,
            serde_json::Value::Null,
        );
    };
    // min/max are only meaningful when the writer actually set them — an
    // unset bound must read as NULL, not as an empty string that looks like
    // a value.
    let (min, max) = if st.min_is_exact() || st.max_is_exact() {
        (s(format_stat_min(st)), s(format_stat_max(st)))
    } else {
        (serde_json::Value::Null, serde_json::Value::Null)
    };
    (
        min,
        max,
        st.null_count_opt().map(|v| n(v as i64)).unwrap_or(serde_json::Value::Null),
        st.distinct_count_opt().map(|v| n(v as i64)).unwrap_or(serde_json::Value::Null),
    )
}

macro_rules! stat_bound {
    ($fn_name:ident, $accessor:ident) => {
        fn $fn_name(st: &Statistics) -> String {
            match st {
                Statistics::Boolean(v) => v.$accessor().map(|x| x.to_string()).unwrap_or_default(),
                Statistics::Int32(v) => v.$accessor().map(|x| x.to_string()).unwrap_or_default(),
                Statistics::Int64(v) => v.$accessor().map(|x| x.to_string()).unwrap_or_default(),
                Statistics::Int96(v) => v.$accessor().map(|x| x.to_string()).unwrap_or_default(),
                Statistics::Float(v) => v.$accessor().map(|x| x.to_string()).unwrap_or_default(),
                Statistics::Double(v) => v.$accessor().map(|x| x.to_string()).unwrap_or_default(),
                Statistics::ByteArray(v) => v
                    .$accessor()
                    .map(|x| String::from_utf8_lossy(x.data()).into_owned())
                    .unwrap_or_default(),
                Statistics::FixedLenByteArray(v) => v
                    .$accessor()
                    .map(|x| hex(x.data()))
                    .unwrap_or_default(),
            }
        }
    };
}
stat_bound!(format_stat_min, min_opt);
stat_bound!(format_stat_max, max_opt);

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn human_bytes(v: i64) -> String {
    const UNITS: [&str; 5] = ["B", "KiB", "MiB", "GiB", "TiB"];
    let mut f = v as f64;
    let mut u = 0;
    while f >= 1024.0 && u < UNITS.len() - 1 {
        f /= 1024.0;
        u += 1;
    }
    if u == 0 {
        format!("{v} B")
    } else {
        format!("{f:.2} {}", UNITS[u])
    }
}

/// Parse back what `human_bytes` produced — used only to sort the stats view.
fn unhuman(s: &str) -> i64 {
    let mut it = s.split_whitespace();
    let num: f64 = it.next().and_then(|x| x.parse().ok()).unwrap_or(0.0);
    let mult = match it.next().unwrap_or("B") {
        "KiB" => 1024.0,
        "MiB" => 1024.0 * 1024.0,
        "GiB" => 1024.0 * 1024.0 * 1024.0,
        "TiB" => 1024.0 * 1024.0 * 1024.0 * 1024.0,
        _ => 1.0,
    };
    (num * mult) as i64
}

fn ratio(raw: i64, compressed: i64) -> String {
    if compressed <= 0 {
        return String::new();
    }
    format!("{:.1}x", raw as f64 / compressed as f64)
}

fn pct(part: i64, whole: i64) -> String {
    if whole <= 0 {
        return String::new();
    }
    format!("{:.1}%", part as f64 / whole as f64 * 100.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use arrow_array::{ArrayRef, Int64Array, RecordBatch, StringArray};
    use arrow_schema::{DataType, Field, Schema};
    use parquet::arrow::ArrowWriter;
    use parquet::basic::Compression as Codec;
    use parquet::file::properties::WriterProperties;

    /// Build a small multi-row-group file to read back.
    fn fixture(name: &str, rows: usize, group: usize) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("txui-parquet-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        let _ = std::fs::remove_file(&path);

        let schema = Arc::new(Schema::new(vec![
            Field::new("id", DataType::Int64, false),
            Field::new("label", DataType::Utf8, true),
        ]));
        let props = WriterProperties::builder()
            .set_compression(Codec::ZSTD(Default::default()))
            .set_max_row_group_row_count(Some(group))
            .build();
        let file = File::create(&path).unwrap();
        let mut w = ArrowWriter::try_new(file, schema.clone(), Some(props)).unwrap();

        let ids: Vec<i64> = (0..rows as i64).collect();
        // Every third label is NULL, so null handling is actually exercised.
        let labels: Vec<Option<String>> = (0..rows)
            .map(|i| if i % 3 == 0 { None } else { Some(format!("row-{i}")) })
            .collect();
        let batch = RecordBatch::try_new(
            schema,
            vec![
                Arc::new(Int64Array::from(ids)) as ArrayRef,
                Arc::new(StringArray::from(labels)) as ArrayRef,
            ],
        )
        .unwrap();
        w.write(&batch).unwrap();
        w.close().unwrap();
        path
    }

    #[test]
    fn a_missing_file_is_an_error() {
        let err = open_path(Path::new("/nope/missing.parquet")).unwrap_err().to_string();
        assert!(err.contains("no such file"), "{err}");
    }

    #[test]
    fn a_non_parquet_file_says_so_instead_of_panicking() {
        let dir = std::env::temp_dir().join(format!("txui-parquet-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("not.parquet");
        std::fs::write(&path, b"this is plainly not a parquet file").unwrap();
        let err = open_path(&path).unwrap_err().to_string();
        assert!(err.contains("not a readable Parquet file"), "{err}");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn footer_reports_rows_groups_and_columns() {
        let path = fixture("meta.parquet", 250, 100);
        let f = open_path(&path).unwrap();
        assert_eq!(f.num_rows(), 250);
        assert_eq!(f.metadata.num_row_groups(), 3); // 100 + 100 + 50
        assert_eq!(f.leaf_names(), vec!["id", "label"]);

        // Nullability comes from the repetition level, not from a flag.
        let cols = list_columns(&ParquetSource::Single(f));
        assert!(cols.iter().any(|c| matches!(c,
            SchemaNode::Column { name, nullable: false, .. } if name == "id")));
        assert!(cols.iter().any(|c| matches!(c,
            SchemaNode::Column { name, nullable: true, .. } if name == "label")));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn nested_struct_columns_expand_by_path() {
        use arrow_array::StructArray;
        use arrow_schema::Fields;
        let dir = std::env::temp_dir().join(format!("txui-parquet-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("nested.parquet");
        let _ = std::fs::remove_file(&path);

        let addr_fields = Fields::from(vec![
            Field::new("city", DataType::Utf8, true),
            Field::new("zip", DataType::Int64, false),
        ]);
        let schema = Arc::new(Schema::new(vec![
            Field::new("id", DataType::Int64, false),
            Field::new("addr", DataType::Struct(addr_fields.clone()), true),
        ]));
        let addr = StructArray::new(
            addr_fields,
            vec![
                Arc::new(StringArray::from(vec![Some("nyc"), Some("la")])) as ArrayRef,
                Arc::new(Int64Array::from(vec![10001i64, 90001])) as ArrayRef,
            ],
            None,
        );
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![Arc::new(Int64Array::from(vec![1i64, 2])) as ArrayRef, Arc::new(addr) as ArrayRef],
        )
        .unwrap();
        let file = File::create(&path).unwrap();
        let mut w = ArrowWriter::try_new(file, schema, None).unwrap();
        w.write(&batch).unwrap();
        w.close().unwrap();

        let src = ParquetSource::Single(open_path(&path).unwrap());
        let top = list_columns(&src);
        // Top level: a leaf `id` and an expandable struct `addr`.
        assert!(top.iter().any(|c| matches!(c, SchemaNode::Column { name, .. } if name == "id")));
        assert!(top.iter().any(|c| matches!(c,
            SchemaNode::StructColumn { name, path, .. } if name == "addr" && path == "addr")));
        // Expanding `addr` yields its two child fields, with nullability preserved.
        let kids = struct_children(&src, "addr");
        assert!(kids.iter().any(|c| matches!(c,
            SchemaNode::Column { name, nullable: true, .. } if name == "city")));
        assert!(kids.iter().any(|c| matches!(c,
            SchemaNode::Column { name, nullable: false, .. } if name == "zip")));
        // An unknown path resolves to nothing rather than panicking.
        assert!(struct_children(&src, "nope").is_empty());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn commands_produce_grids_and_the_codec_is_reported() {
        let path = fixture("cmd.parquet", 250, 100);
        let f = open_path(&path).unwrap();

        let rg = execute_file(&f, "ROWGROUPS").unwrap();
        assert_eq!(rg.rows.len(), 3);

        let cc = execute_file(&f, "COLUMNCHUNKS").unwrap();
        assert_eq!(cc.rows.len(), 6); // 3 row groups x 2 leaf columns
        let codec_idx = cc.columns.iter().position(|c| c.name == "codec").unwrap();
        assert!(cc.rows.iter().all(|r| r[codec_idx] == serde_json::json!("ZSTD")));

        let st = execute_file(&f, "STATS").unwrap();
        assert_eq!(st.rows.len(), 2);
        // Every third label is NULL — 84 of 250 (i = 0, 3, … 249).
        let nulls_idx = st.columns.iter().position(|c| c.name == "nulls").unwrap();
        let col_idx = st.columns.iter().position(|c| c.name == "column").unwrap();
        let label = st.rows.iter().find(|r| r[col_idx] == serde_json::json!("label")).unwrap();
        assert_eq!(label[nulls_idx], serde_json::json!(84));

        assert!(!execute_file(&f, "FILEINFO").unwrap().rows.is_empty());
        assert!(!execute_file(&f, "SCHEMA").unwrap().rows.is_empty());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn sql_is_refused_with_a_message_that_explains_why() {
        let path = fixture("sql.parquet", 10, 10);
        let f = open_path(&path).unwrap();
        let err = execute_file(&f, "SELECT * FROM t").unwrap_err().to_string();
        assert!(err.contains("not a query engine"), "{err}");
        // And the message tells you what you CAN do.
        assert!(err.contains("ROWGROUPS"), "{err}");

        let unknown = execute_file(&f, "WOBBLE").unwrap_err().to_string();
        assert!(unknown.contains("unknown Parquet command"), "{unknown}");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn paging_returns_the_right_rows_and_keeps_nulls() {
        let path = fixture("page.parquet", 250, 100);
        let f = open_path(&path).unwrap();

        let first = preview(&f, 5, 0).unwrap();
        assert_eq!(first.rows.len(), 5);
        assert_eq!(first.rows[0][0], serde_json::json!("0"));
        // NULL must stay NULL, not become "".
        assert_eq!(first.rows[0][1], serde_json::Value::Null);
        assert_eq!(first.rows[1][1], serde_json::json!("row-1"));

        // An offset landing inside the third row group: rows 0..199 are in
        // groups skipped whole, so this exercises both skip paths.
        let deep = preview(&f, 3, 205).unwrap();
        assert_eq!(deep.rows.len(), 3);
        assert_eq!(deep.rows[0][0], serde_json::json!("205"));
        assert_eq!(deep.rows[2][0], serde_json::json!("207"));

        // Reading past the end returns what exists, not an error.
        let tail = preview(&f, 50, 240).unwrap();
        assert_eq!(tail.rows.len(), 10);
        assert_eq!(tail.rows[9][0], serde_json::json!("249"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn human_bytes_and_ratio_read_the_way_a_dba_expects() {
        assert_eq!(human_bytes(512), "512 B");
        assert_eq!(human_bytes(1024), "1.00 KiB");
        assert_eq!(human_bytes(1536), "1.50 KiB");
        assert_eq!(ratio(1000, 100), "10.0x");
        // Never divide by zero — an empty column chunk is legal.
        assert_eq!(ratio(1000, 0), "");
        assert_eq!(pct(25, 100), "25.0%");
        assert_eq!(pct(1, 0), "");
    }
}

/// GeoParquet (spec 1.x): the `geo` key-value metadata parsed, surfaced parsed
/// in FILEINFO (the raw value still verbatim under KEYVALUE), and used to
/// annotate geometry columns. Fixtures are generated with the parquet crate —
/// hand-built `geo` JSON through WriterProperties, no external files.
#[cfg(test)]
mod geoparquet_tests {
    use super::*;
    use arrow_array::{ArrayRef, BinaryArray, Float64Array, Int64Array, RecordBatch, StructArray};
    use arrow_schema::{DataType, Field, Fields, Schema};
    use parquet::arrow::ArrowWriter;
    use parquet::file::properties::WriterProperties;
    use parquet::file::metadata::KeyValue;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("txui-pqgeo-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        let _ = std::fs::remove_file(&p);
        p
    }

    /// A little-endian WKB POINT(1 2) — what GeoPandas/GDAL would write.
    const WKB_POINT: [u8; 21] = [
        0x01, 0x01, 0x00, 0x00, 0x00, // byte order LE, type Point
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x3f, // x = 1.0
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40, // y = 2.0
    ];

    /// One file with `id` + a Binary `geom` column and the given `geo`
    /// key/value metadata (None = a plain file with no geo key at all).
    fn geo_fixture(name: &str, geo_json: Option<&str>) -> PathBuf {
        let path = tmp(name);
        let schema = Arc::new(Schema::new(vec![
            Field::new("id", DataType::Int64, false),
            Field::new("geom", DataType::Binary, true),
        ]));
        let props = WriterProperties::builder()
            .set_key_value_metadata(geo_json.map(|j| {
                vec![KeyValue::new("geo".to_string(), Some(j.to_string()))]
            }))
            .build();
        let file = File::create(&path).unwrap();
        let mut w = ArrowWriter::try_new(file, schema.clone(), Some(props)).unwrap();
        w.write(&RecordBatch::try_new(schema, vec![
            Arc::new(Int64Array::from(vec![1i64, 2])) as ArrayRef,
            Arc::new(BinaryArray::from(vec![Some(&WKB_POINT[..]), None])) as ArrayRef,
        ]).unwrap()).unwrap();
        w.close().unwrap();
        path
    }

    /// The value column of a FILEINFO-style property/value grid.
    fn prop(rows: &[Row], key: &str) -> Option<String> {
        rows.iter()
            .find(|r| r[0] == serde_json::json!(key))
            .map(|r| r[1].as_str().unwrap_or("").to_string())
    }

    /// Full 1.1 metadata: version, primary column, WKB encoding, geometry
    /// types, a PROJJSON CRS with an EPSG id, bbox, orientation, edges and a
    /// covering pointer — plus made-up fields a newer spec might add, which
    /// must be ignored rather than breaking the parse.
    const FULL_GEO: &str = r#"{
        "version": "1.1.0",
        "primary_column": "geom",
        "made_up_future_field": {"anything": true},
        "columns": {
            "geom": {
                "encoding": "WKB",
                "geometry_types": ["Point", "Polygon"],
                "crs": {
                    "$schema": "https://proj.org/schemas/v0.7/projjson.json",
                    "type": "GeographicCRS",
                    "name": "WGS 84",
                    "id": {"authority": "EPSG", "code": 4979}
                },
                "orientation": "counterclockwise",
                "edges": "spherical",
                "bbox": [-10.5, 41.0, 30.25, 71.9],
                "epoch": 2015,
                "covering": {"bbox": {"xmin": ["bbox", "xmin"], "ymin": ["bbox", "ymin"],
                                      "xmax": ["bbox", "xmax"], "ymax": ["bbox", "ymax"]}},
                "future_extra": 42
            }
        }
    }"#;

    #[test]
    fn full_1_1_metadata_parses_and_surfaces_in_fileinfo_and_the_tree() {
        let path = geo_fixture("geo-full.parquet", Some(FULL_GEO));
        let f = open_path(&path).unwrap();

        // Parsed: version captured verbatim, unknown fields ignored.
        let meta = geo_meta(&f).expect("geo metadata must parse");
        assert_eq!(meta.version, "1.1.0");
        assert_eq!(meta.primary_column, "geom");
        assert_eq!(meta.columns["geom"].geometry_types, vec!["Point", "Polygon"]);

        // FILEINFO shows the parsed headline and the per-column summary…
        let fi = execute_file(&f, "FILEINFO").unwrap();
        let headline = prop(&fi.rows, "geo").expect("FILEINFO must have a geo row");
        assert!(headline.contains("GeoParquet 1.1.0"), "{headline}");
        assert!(headline.contains("primary column: geom"), "{headline}");
        let col = prop(&fi.rows, "geo · geom").expect("per-column geo row");
        assert!(col.contains("WKB"), "{col}");
        assert!(col.contains("Point, Polygon"), "{col}");
        assert!(col.contains("EPSG:4979"), "{col}");
        assert!(col.contains("bbox [-10.5, 41, 30.25, 71.9]"), "{col}");
        assert!(col.contains("counterclockwise"), "{col}");
        assert!(col.contains("spherical edges"), "{col}");
        assert!(col.contains("covering"), "{col}");

        // …while the raw JSON stays verbatim under KEYVALUE.
        let kv = execute_file(&f, "KEYVALUE").unwrap();
        let raw = prop(&kv.rows, "geo").expect("KEYVALUE must keep the raw geo row");
        assert!(raw.contains("made_up_future_field"), "raw value must be untouched: {raw}");

        // The tree and the grid headers call the column a geometry, not BYTE_ARRAY.
        let cols = list_columns(&ParquetSource::Single(open_path(&path).unwrap()));
        assert!(cols.iter().any(|c| matches!(c,
            SchemaNode::Column { name, type_name, .. }
                if name == "geom" && type_name == "GEOMETRY · GeoParquet WKB")),
            "{cols:?}");
        let page = preview(&f, 5, 0).unwrap();
        let geom = page.columns.iter().find(|c| c.name == "geom").unwrap();
        assert_eq!(geom.type_name, "GEOMETRY · GeoParquet WKB");
        // …and the WKB cell still arrives as the hex string the frontend parses.
        assert_eq!(page.rows[0][1], serde_json::json!(hex(&WKB_POINT)));
        assert_eq!(page.rows[1][1], serde_json::Value::Null);

        // The primary column's bbox is the map's initial viewport hint.
        assert_eq!(geo_bbox(&f), Some([-10.5, 41.0, 30.25, 71.9]));

        // Ping names the format, so the connect log does too.
        let p = ping_file(&f);
        assert!(p.server_version.unwrap().contains("GeoParquet 1.1.0"));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn crs_absent_means_crs84_and_crs_null_means_unknown() {
        // Absent field: the spec default — OGC:CRS84, lon/lat WGS 84.
        let absent = r#"{"version":"1.1.0","primary_column":"geom",
            "columns":{"geom":{"encoding":"WKB","bbox":[0,0,1,1,2,3]}}}"#;
        let path = geo_fixture("geo-crs-absent.parquet", Some(absent));
        let f = open_path(&path).unwrap();
        let fi = execute_file(&f, "FILEINFO").unwrap();
        let col = prop(&fi.rows, "geo · geom").unwrap();
        assert!(col.contains("WGS 84 lon/lat (OGC:CRS84"), "{col}");
        // A 3D bbox (six numbers, RFC 7946) contributes its first four.
        assert_eq!(geo_bbox(&f), Some([0.0, 0.0, 1.0, 1.0]));
        let _ = std::fs::remove_file(&path);

        // Explicit null: the producer does NOT know — a different statement.
        let null = r#"{"version":"1.1.0","primary_column":"geom",
            "columns":{"geom":{"encoding":"WKB","crs":null}}}"#;
        let path = geo_fixture("geo-crs-null.parquet", Some(null));
        let f = open_path(&path).unwrap();
        let fi = execute_file(&f, "FILEINFO").unwrap();
        let col = prop(&fi.rows, "geo · geom").unwrap();
        assert!(col.contains("unknown CRS"), "{col}");
        let _ = std::fs::remove_file(&path);

        // Same distinction at the parse level, no file involved.
        let meta: GeoMeta = serde_json::from_str(absent).unwrap();
        assert!(matches!(meta.columns["geom"].crs, Crs::DefaultCrs84));
        let meta: GeoMeta = serde_json::from_str(null).unwrap();
        assert!(matches!(meta.columns["geom"].crs, Crs::Unknown));
        let meta: GeoMeta = serde_json::from_str(FULL_GEO).unwrap();
        assert!(matches!(meta.columns["geom"].crs, Crs::Projjson(_)));
    }

    /// The row paths carry the footer bbox on the result itself — the map's
    /// first viewport fit must not depend on which page happens to be loaded.
    #[test]
    fn row_paths_carry_the_footer_bbox() {
        let path = geo_fixture("geo-bbox-channel.parquet", Some(FULL_GEO));
        let f = open_path(&path).unwrap();
        let page = preview(&f, 5, 0).unwrap();
        assert_eq!(page.geo_bbox, Some([-10.5, 41.0, 30.25, 71.9]));
        let filtered = preview_filtered(&f, 5, 0, &[], &[]).unwrap();
        assert_eq!(filtered.geo_bbox, Some([-10.5, 41.0, 30.25, 71.9]));
        let _ = std::fs::remove_file(&path);

        // No geo key → no hint, and the field stays off the wire (serde skip).
        let path = geo_fixture("no-geo-bbox-channel.parquet", None);
        let f = open_path(&path).unwrap();
        let page = preview(&f, 5, 0).unwrap();
        assert_eq!(page.geo_bbox, None);
        assert!(!serde_json::to_string(&page).unwrap().contains("geo_bbox"));
        let _ = std::fs::remove_file(&path);
    }

    /// A dataset's hint is the union of its member bboxes — a page of one
    /// member would otherwise fit the map to a fraction of the data.
    #[test]
    fn a_dataset_bbox_is_the_union_of_its_members() {
        let dir = std::env::temp_dir().join(format!("txui-pqgeo-union-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // Two members with disjoint extents; one with geo metadata but NO bbox.
        // (geometry_types is required: DuckDB's reader refuses a geo column
        // without it. And a member with NO geo key at all breaks DuckDB's
        // union-by-name cast — BLOB vs GEOMETRY('OGC:CRS84') — so "no bbox"
        // is the honest stand-in for "contributes nothing".)
        for (name, geo) in [
            ("a.parquet", Some(r#"{"version":"1.1.0","primary_column":"geom",
                "columns":{"geom":{"encoding":"WKB","geometry_types":["Point"],"bbox":[0,0,10,10]}}}"#)),
            ("b.parquet", Some(r#"{"version":"1.1.0","primary_column":"geom",
                "columns":{"geom":{"encoding":"WKB","geometry_types":["Point"],"bbox":[-5,20,1,30]}}}"#)),
            ("c.parquet", Some(r#"{"version":"1.1.0","primary_column":"geom",
                "columns":{"geom":{"encoding":"WKB","geometry_types":["Point"]}}}"#)),
        ] {
            let path = dir.join(name);
            let schema = Arc::new(Schema::new(vec![
                Field::new("id", DataType::Int64, false),
                Field::new("geom", DataType::Binary, true),
            ]));
            let props = WriterProperties::builder()
                .set_key_value_metadata(geo.map(|j| {
                    vec![KeyValue::new("geo".to_string(), Some(j.to_string()))]
                }))
                .build();
            let file = File::create(&path).unwrap();
            let mut w = ArrowWriter::try_new(file, schema.clone(), Some(props)).unwrap();
            w.write(&RecordBatch::try_new(schema, vec![
                Arc::new(Int64Array::from(vec![1i64])) as ArrayRef,
                Arc::new(BinaryArray::from(vec![Some(&WKB_POINT[..])])) as ArrayRef,
            ]).unwrap()).unwrap();
            w.close().unwrap();
        }
        let d = open_dataset(&dir).unwrap();
        assert_eq!(dataset_geo_bbox(&d), Some([-5.0, 0.0, 10.0, 30.0]));
        // (No PREVIEW-through-DuckDB assertion here: when the spatial
        // extension is present, DuckDB casts the WKB column to
        // GEOMETRY('OGC:CRS84') — the decode of that type is the DuckDB
        // spatial wave's story, not this channel's.)
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_without_the_geo_key_is_untouched() {
        let path = geo_fixture("no-geo.parquet", None);
        let f = open_path(&path).unwrap();
        assert!(matches!(geo_state(&f), GeoState::Absent));

        // No geo rows in FILEINFO, no annotation anywhere, ping unchanged.
        let fi = execute_file(&f, "FILEINFO").unwrap();
        assert!(prop(&fi.rows, "geo").is_none());
        let cols = list_columns(&ParquetSource::Single(open_path(&path).unwrap()));
        assert!(cols.iter().any(|c| matches!(c,
            SchemaNode::Column { name, type_name, .. } if name == "geom" && type_name == "BYTE_ARRAY")));
        let page = preview(&f, 5, 0).unwrap();
        assert_eq!(page.columns.iter().find(|c| c.name == "geom").unwrap().type_name, "Binary");
        assert!(!ping_file(&f).server_version.unwrap().contains("GeoParquet"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_native_encoding_column_is_labelled_honestly_not_promised_as_renderable() {
        // GeoParquet 1.1 native encodings are nested structs (point = {x, y}),
        // which the map cannot draw yet — the label must say so.
        let path = tmp("geo-native.parquet");
        let pt_fields = Fields::from(vec![
            Field::new("x", DataType::Float64, true),
            Field::new("y", DataType::Float64, true),
        ]);
        let schema = Arc::new(Schema::new(vec![
            Field::new("id", DataType::Int64, false),
            Field::new("geom", DataType::Struct(pt_fields.clone()), true),
        ]));
        let geo = r#"{"version":"1.1.0","primary_column":"geom",
            "columns":{"geom":{"encoding":"point","geometry_types":["Point"]}}}"#;
        let props = WriterProperties::builder()
            .set_key_value_metadata(Some(vec![KeyValue::new("geo".to_string(), Some(geo.to_string()))]))
            .build();
        let pts = StructArray::new(
            pt_fields,
            vec![
                Arc::new(Float64Array::from(vec![Some(1.5), None])) as ArrayRef,
                Arc::new(Float64Array::from(vec![Some(2.5), None])) as ArrayRef,
            ],
            None,
        );
        let batch = RecordBatch::try_new(schema.clone(), vec![
            Arc::new(Int64Array::from(vec![1i64, 2])) as ArrayRef,
            Arc::new(pts) as ArrayRef,
        ]).unwrap();
        let file = File::create(&path).unwrap();
        let mut w = ArrowWriter::try_new(file, schema, Some(props)).unwrap();
        w.write(&batch).unwrap();
        w.close().unwrap();

        let f = open_path(&path).unwrap();
        let cols = list_columns(&ParquetSource::Single(open_path(&path).unwrap()));
        let label = cols.iter().find_map(|c| match c {
            SchemaNode::StructColumn { name, type_name, .. } if name == "geom" => Some(type_name.clone()),
            _ => None,
        }).expect("geom must be a struct column");
        assert!(label.contains("GeoParquet point"), "{label}");
        assert!(label.contains("not renderable yet"), "{label}");

        // The grid header carries the same honest label; the cell itself is
        // the nested-JSON the struct path already produces.
        let page = preview(&f, 5, 0).unwrap();
        let geom = page.columns.iter().find(|c| c.name == "geom").unwrap();
        assert!(geom.type_name.contains("not renderable yet"), "{}", geom.type_name);
        assert_eq!(page.rows[0][1], serde_json::json!({"x": "1.5", "y": "2.5"}));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_malformed_geo_key_is_reported_not_silently_dropped() {
        let path = geo_fixture("geo-bad.parquet", Some("not json {"));
        let f = open_path(&path).unwrap();
        assert!(matches!(geo_state(&f), GeoState::Invalid(_)));

        let fi = execute_file(&f, "FILEINFO").unwrap();
        let row = prop(&fi.rows, "geo").expect("the malformed key must be surfaced");
        assert!(row.contains("not valid GeoParquet JSON"), "{row}");
        // Nothing is annotated off a value we could not parse.
        let cols = list_columns(&ParquetSource::Single(open_path(&path).unwrap()));
        assert!(cols.iter().any(|c| matches!(c,
            SchemaNode::Column { name, type_name, .. } if name == "geom" && type_name == "BYTE_ARRAY")));
        let _ = std::fs::remove_file(&path);
    }
}

/// Row-group pushdown and streaming export: the scan-time paths that must
/// never trade correctness for speed. Every pushdown assertion is twofold —
/// that a group was provably skipped, and that the skipped read returns
/// exactly the rows an unfiltered scan plus the in-memory predicate returns.
#[cfg(test)]
mod pushdown_tests {
    use super::*;
    use crate::db::types::{FilterClause, FilterOp};
    use arrow_array::{ArrayRef, Int64Array, RecordBatch, StringArray, TimestampMillisecondArray};
    use arrow_schema::{DataType, Field, Schema, TimeUnit};
    use parquet::arrow::ArrowWriter;
    use parquet::file::properties::{EnabledStatistics, WriterProperties};

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("txui-pqpd-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        let _ = std::fs::remove_file(&p);
        p
    }

    fn filt(column: &str, op: FilterOp, value: Option<&str>) -> FilterClause {
        FilterClause { column: column.into(), op, value: value.map(|v| v.into()) }
    }

    /// Three row groups of 100 rows: `id` runs 0..300 (disjoint min/max per
    /// group), `grp` is constant within a group ("a"/"b"/"c" — the min == max
    /// case), `label` is "row-{i}" with every third value NULL.
    fn ranged(name: &str, props: Option<WriterProperties>) -> PathBuf {
        let path = tmp(name);
        let schema = Arc::new(Schema::new(vec![
            Field::new("id", DataType::Int64, false),
            Field::new("grp", DataType::Utf8, false),
            Field::new("label", DataType::Utf8, true),
        ]));
        let props = props.unwrap_or_else(|| {
            WriterProperties::builder().set_max_row_group_row_count(Some(100)).build()
        });
        let file = File::create(&path).unwrap();
        let mut w = ArrowWriter::try_new(file, schema.clone(), Some(props)).unwrap();
        for g in 0..3i64 {
            let ids: Vec<i64> = (0..100).map(|i| g * 100 + i).collect();
            let grp = vec![["a", "b", "c"][g as usize]; 100];
            let labels: Vec<Option<String>> = ids
                .iter()
                .map(|i| if i % 3 == 0 { None } else { Some(format!("row-{i}")) })
                .collect();
            w.write(&RecordBatch::try_new(schema.clone(), vec![
                Arc::new(Int64Array::from(ids)) as ArrayRef,
                Arc::new(StringArray::from(grp)) as ArrayRef,
                Arc::new(StringArray::from(labels)) as ArrayRef,
            ]).unwrap()).unwrap();
        }
        w.close().unwrap();
        path
    }

    /// The no-pushdown reference: page through everything, then apply the same
    /// predicate the scan path uses.
    fn brute(f: &ParquetFile, filters: &[FilterClause]) -> Vec<Row> {
        let all = preview(f, f.num_rows() as usize + 1, 0).unwrap();
        let idx: Vec<usize> = filters.iter().map(|fl| {
            all.columns.iter().position(|c| c.name == fl.column)
                .unwrap_or_else(|| panic!("no column {}", fl.column))
        }).collect();
        all.rows.into_iter()
            .filter(|r| filters.iter().zip(&idx).all(|(fl, i)| passes(&r[*i], fl)))
            .collect()
    }

    fn excluded_map(f: &ParquetFile, filters: &[FilterClause]) -> Vec<bool> {
        f.metadata.row_groups().iter().map(|rg| rg_excluded(rg, filters)).collect()
    }

    /// The invariant: pushdown returns exactly what a full scan returns.
    fn assert_same_as_scan(f: &ParquetFile, filters: &[FilterClause]) {
        let pushed = preview_filtered(f, f.num_rows() as usize + 1, 0, filters, &[]).unwrap();
        assert_eq!(pushed.rows, brute(f, filters), "filters: {filters:?}");
    }

    #[test]
    fn equality_skips_exactly_the_groups_that_cannot_hold_the_value() {
        let path = ranged("skip.parquet", None);
        let f = open_path(&path).unwrap();
        assert_eq!(f.metadata.num_row_groups(), 3);

        // The value lives in group 1 only.
        assert_eq!(excluded_map(&f, &[filt("id", FilterOp::Eq, Some("150"))]), [true, false, true]);
        // Past the end: every group goes.
        assert_eq!(excluded_map(&f, &[filt("id", FilterOp::Eq, Some("999"))]), [true, true, true]);
        // Boundary values are inside a group and must never skip it.
        assert_eq!(excluded_map(&f, &[filt("id", FilterOp::Eq, Some("100"))]), [true, false, true]);
        assert_eq!(excluded_map(&f, &[filt("id", FilterOp::Eq, Some("99"))]), [false, true, true]);
        // min == max (constant group): equal keeps the group, anything else drops it.
        assert_eq!(excluded_map(&f, &[filt("grp", FilterOp::Eq, Some("b"))]), [true, false, true]);
        assert_eq!(excluded_map(&f, &[filt("grp", FilterOp::Eq, Some("zz"))]), [true, true, true]);
        // Ranges: Gte 100 drops group 0 (max 99); Lt 100 drops groups 1 and 2.
        assert_eq!(excluded_map(&f, &[filt("id", FilterOp::Gte, Some("100"))]), [true, false, false]);
        assert_eq!(excluded_map(&f, &[filt("id", FilterOp::Lt, Some("100"))]), [false, true, true]);
        // Ops that min/max cannot bound never skip…
        assert_eq!(excluded_map(&f, &[filt("id", FilterOp::Neq, Some("150"))]), [false, false, false]);
        assert_eq!(excluded_map(&f, &[filt("label", FilterOp::Like, Some("%9"))]), [false, false, false]);
        assert_eq!(excluded_map(&f, &[filt("label", FilterOp::IsNull, None)]), [false, false, false]);
        // …nor does a column the file does not have.
        assert_eq!(excluded_map(&f, &[filt("nope", FilterOp::Eq, Some("1"))]), [false, false, false]);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn pushdown_returns_exactly_the_rows_a_full_scan_returns() {
        let path = ranged("equiv.parquet", None);
        let f = open_path(&path).unwrap();
        for filters in [
            vec![filt("id", FilterOp::Eq, Some("42"))],   // hit in group 0
            vec![filt("id", FilterOp::Eq, Some("250"))],  // hit in group 2
            vec![filt("id", FilterOp::Eq, Some("9999"))], // miss — every group skipped
            vec![filt("id", FilterOp::Gte, Some("150"))],
            vec![filt("id", FilterOp::Lt, Some("3"))],
            vec![filt("grp", FilterOp::Eq, Some("c"))],
            vec![filt("grp", FilterOp::Eq, Some("nope"))],
            vec![filt("label", FilterOp::Eq, Some("row-7"))],
            // NULLs are absent from min/max; they must survive the pushdown.
            vec![filt("label", FilterOp::IsNull, None)],
            vec![filt("id", FilterOp::Gte, Some("100")), filt("label", FilterOp::IsNotNull, None)],
        ] {
            assert_same_as_scan(&f, &filters);
        }
        // And the skip really happened — otherwise the above proves nothing
        // about pushdown.
        assert!(excluded_map(&f, &[filt("id", FilterOp::Eq, Some("42"))]).iter().any(|x| *x));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn dictionary_encoded_columns_push_down_the_same_way() {
        let path = tmp("dict.parquet");
        let schema = Arc::new(Schema::new(vec![
            Field::new("id", DataType::Int64, false),
            Field::new("key", DataType::Utf8, false),
        ]));
        let props = WriterProperties::builder()
            .set_dictionary_enabled(true)
            .set_max_row_group_row_count(Some(100))
            .build();
        let file = File::create(&path).unwrap();
        let mut w = ArrowWriter::try_new(file, schema.clone(), Some(props)).unwrap();
        // Zero-padded keys keep each group's lexical min/max range disjoint.
        for g in 0..3i64 {
            let ids: Vec<i64> = (0..100).map(|i| g * 100 + i).collect();
            let keys: Vec<String> = ids.iter().map(|i| format!("k{i:05}")).collect();
            w.write(&RecordBatch::try_new(schema.clone(), vec![
                Arc::new(Int64Array::from(ids)) as ArrayRef,
                Arc::new(StringArray::from(keys)) as ArrayRef,
            ]).unwrap()).unwrap();
        }
        w.close().unwrap();

        let f = open_path(&path).unwrap();
        // Prove the dictionary is really there, then prove the skip on top of it.
        assert!(f.metadata.row_groups().iter()
            .all(|rg| rg.columns()[1].dictionary_page_offset().is_some()));
        let filters = [filt("key", FilterOp::Eq, Some("k00150"))];
        assert_eq!(excluded_map(&f, &filters), [true, false, true]);
        assert_same_as_scan(&f, &filters);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_column_without_statistics_is_always_scanned_never_skipped() {
        let props = WriterProperties::builder()
            .set_statistics_enabled(EnabledStatistics::None)
            .set_max_row_group_row_count(Some(100))
            .build();
        let path = ranged("nostats.parquet", Some(props));
        let f = open_path(&path).unwrap();
        assert!(f.metadata.row_groups().iter()
            .all(|rg| rg.columns().iter().all(|cc| cc.statistics().is_none())));
        for op in [FilterOp::Eq, FilterOp::Lt, FilterOp::Gte] {
            assert_eq!(excluded_map(&f, &[filt("id", op, Some("150"))]), [false, false, false]);
        }
        assert_same_as_scan(&f, &[filt("id", FilterOp::Eq, Some("150"))]);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_timestamp_column_falls_back_to_scanning_instead_of_skipping_wrong() {
        // Footer stats for a timestamp are epoch integers; the grid shows ISO
        // text. Comparing one against the other could skip a group that holds
        // a match, so pushdown must refuse the column entirely.
        let path = tmp("ts.parquet");
        let schema = Arc::new(Schema::new(vec![
            Field::new("id", DataType::Int64, false),
            Field::new("ts", DataType::Timestamp(TimeUnit::Millisecond, None), true),
        ]));
        let props = WriterProperties::builder().set_max_row_group_row_count(Some(2)).build();
        let file = File::create(&path).unwrap();
        let mut w = ArrowWriter::try_new(file, schema.clone(), Some(props)).unwrap();
        let ids: Vec<i64> = (0..6).collect();
        let ts: Vec<i64> = ids.iter().map(|i| 1_700_000_000_000 + i * 60_000).collect();
        w.write(&RecordBatch::try_new(schema, vec![
            Arc::new(Int64Array::from(ids)) as ArrayRef,
            Arc::new(TimestampMillisecondArray::from(ts)) as ArrayRef,
        ]).unwrap()).unwrap();
        w.close().unwrap();

        let f = open_path(&path).unwrap();
        assert_eq!(f.metadata.num_row_groups(), 3);
        // The bounds exist but are in the wrong notation — they must be ignored.
        assert!(!stats_match_cell_format(&f.metadata.row_groups()[0].columns()[1]));
        // A filter that hits one row, spelled the way the grid renders it.
        let rendered = preview(&f, 6, 0).unwrap().rows[3][1].as_str().unwrap().to_string();
        let filters = [filt("ts", FilterOp::Eq, Some(&rendered))];
        assert_eq!(excluded_map(&f, &filters), [false, false, false]);
        assert_same_as_scan(&f, &filters);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn integers_beyond_f64_precision_still_match_the_scan() {
        // cell_cmp compares numerically through f64, which collapses distinct
        // i64s past 2^53. Pushdown and the row filter share that comparator
        // (and f64 rounding is monotone), so the two paths must still agree.
        let path = tmp("bigint.parquet");
        let base: i64 = 9_007_199_254_740_992; // 2^53
        let schema = Arc::new(Schema::new(vec![Field::new("id", DataType::Int64, false)]));
        let props = WriterProperties::builder().set_max_row_group_row_count(Some(2)).build();
        let file = File::create(&path).unwrap();
        let mut w = ArrowWriter::try_new(file, schema.clone(), Some(props)).unwrap();
        let ids: Vec<i64> = (1..=6).map(|i| base + i).collect();
        w.write(&RecordBatch::try_new(schema, vec![
            Arc::new(Int64Array::from(ids)) as ArrayRef,
        ]).unwrap()).unwrap();
        w.close().unwrap();

        let f = open_path(&path).unwrap();
        assert_eq!(f.metadata.num_row_groups(), 3);
        for v in base + 1..=base + 6 {
            assert_same_as_scan(&f, &[filt("id", FilterOp::Eq, Some(&v.to_string()))]);
        }
        // An absent value in the same precision-blind range.
        assert_same_as_scan(&f, &[filt("id", FilterOp::Eq, Some(&(base + 100).to_string()))]);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn export_streams_the_same_rows_a_buffered_read_produces() {
        let path = ranged("export.parquet", None);
        let f = open_path(&path).unwrap();
        let all = preview(&f, f.num_rows() as usize + 1, 0).unwrap();

        for (format, sep) in [("csv", ','), ("tsv", '\t')] {
            let out = tmp(&format!("export.{format}"));
            let written = export_to_file(&f, &out, format).unwrap();
            assert_eq!(written, f.num_rows() as u64);
            let body = std::fs::read_to_string(&out).unwrap();
            let sep_s = sep.to_string();
            let mut expected = all.columns.iter().map(|c| delim_field(&c.name, sep))
                .collect::<Vec<_>>().join(&sep_s);
            expected.push('\n');
            for row in &all.rows {
                let line = row.iter().map(|v| match v {
                    serde_json::Value::Null => String::new(),
                    serde_json::Value::String(st) => delim_field(st, sep),
                    other => other.to_string(),
                }).collect::<Vec<_>>().join(&sep_s);
                expected.push_str(&line);
                expected.push('\n');
            }
            assert_eq!(body, expected, "{format} output differs from the buffered read");
            let _ = std::fs::remove_file(&out);
        }

        // ndjson: one object per row, NULLs as JSON null.
        let out = tmp("export.ndjson");
        let written = export_to_file(&f, &out, "json").unwrap();
        assert_eq!(written, f.num_rows() as u64);
        let body = std::fs::read_to_string(&out).unwrap();
        let lines: Vec<&str> = body.lines().collect();
        assert_eq!(lines.len(), all.rows.len());
        for (line, row) in lines.iter().zip(&all.rows) {
            let obj: serde_json::Value = serde_json::from_str(line).unwrap();
            for (ci, col) in all.columns.iter().enumerate() {
                assert_eq!(obj[&col.name], row[ci]);
            }
        }
        let _ = std::fs::remove_file(&out);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn export_quotes_fields_that_hold_the_separator_a_quote_or_a_newline() {
        let path = tmp("tricky.parquet");
        let schema = Arc::new(Schema::new(vec![
            Field::new("id", DataType::Int64, false),
            Field::new("label", DataType::Utf8, true),
        ]));
        let file = File::create(&path).unwrap();
        let mut w = ArrowWriter::try_new(file, schema.clone(), None).unwrap();
        w.write(&RecordBatch::try_new(schema, vec![
            Arc::new(Int64Array::from(vec![1i64, 2, 3, 4, 5])) as ArrayRef,
            Arc::new(StringArray::from(vec![
                Some("plain"), Some("with,comma"), Some("with\"quote"), None, Some("new\nline"),
            ])) as ArrayRef,
        ]).unwrap()).unwrap();
        w.close().unwrap();

        let f = open_path(&path).unwrap();
        let out = tmp("tricky.csv");
        export_to_file(&f, &out, "csv").unwrap();
        let body = std::fs::read_to_string(&out).unwrap();
        assert_eq!(
            body,
            "id,label\n1,plain\n2,\"with,comma\"\n3,\"with\"\"quote\"\n4,\n5,\"new\nline\"\n"
        );
        let _ = std::fs::remove_file(&out);
        let _ = std::fs::remove_file(&path);
    }
}

/// Tests against the sample file in the repo root. They run when it is there
/// and skip (loudly) when it is not, so the suite stays green on a clean
/// checkout without silently losing coverage.
#[cfg(test)]
mod sample_tests {
    use super::*;

    const SAMPLE: &str = "../../txui-data/gcp-prod-sql-cz-web-877f.parquet";

    fn sample() -> Option<ParquetFile> {
        let p = Path::new(SAMPLE);
        if !p.exists() {
            eprintln!("skipping: {SAMPLE} not present");
            return None;
        }
        Some(open_path(p).expect("sample must open"))
    }

    #[test]
    fn the_real_file_opens_and_every_command_returns_a_grid() {
        let Some(f) = sample() else { return };
        eprintln!("{f:?} — {} on disk", human_bytes(f.file_size as i64));

        for cmd in COMMANDS {
            if *cmd == "PREVIEW" {
                continue;
            }
            let r = execute_file(&f, cmd).unwrap_or_else(|e| panic!("{cmd} failed: {e}"));
            assert!(!r.columns.is_empty(), "{cmd} returned no columns");
            eprintln!("  {cmd:<14} {:>4} rows x {} cols", r.rows.len(), r.columns.len());
        }

        // Every leaf column must appear in STATS exactly once.
        let st = execute_file(&f, "STATS").unwrap();
        assert_eq!(st.rows.len(), f.leaf_names().len());

        // COLUMNCHUNKS is row_groups x leaf columns.
        let cc = execute_file(&f, "COLUMNCHUNKS").unwrap();
        assert_eq!(cc.rows.len(), f.metadata.num_row_groups() * f.leaf_names().len());
    }

    #[test]
    fn paging_the_real_file_is_consistent_and_bounded() {
        let Some(f) = sample() else { return };
        let total = f.num_rows() as usize;
        assert!(total > 0);

        let head = preview(&f, 5, 0).unwrap();
        assert_eq!(head.rows.len(), 5.min(total));
        assert_eq!(head.columns.len(), f.leaf_names().len());

        // A page taken from the middle must not repeat the first page.
        if total > 20 {
            let mid = preview(&f, 5, 10).unwrap();
            assert_eq!(mid.rows.len(), 5);
            assert_ne!(head.rows[0], mid.rows[0], "offset had no effect");
        }

        // Reading past the end yields what exists, never an error.
        let tail = preview(&f, 10, total.saturating_sub(3)).unwrap();
        assert!(tail.rows.len() <= 3);
    }

    #[test]
    fn the_file_is_never_written_to() {
        // Parquet is immutable here by construction. Prove it: mtime and size
        // are unchanged after doing everything the app can do to the file.
        let Some(f) = sample() else { return };
        let before = std::fs::metadata(SAMPLE).unwrap();
        for cmd in COMMANDS {
            let _ = execute_file(&f, cmd);
        }
        let _ = preview(&f, 50, 0);
        let after = std::fs::metadata(SAMPLE).unwrap();
        assert_eq!(before.len(), after.len());
        assert_eq!(before.modified().unwrap(), after.modified().unwrap());
    }
}

// ── Writing ──────────────────────────────────────────────────────────────────

/// The writer settings every Parquet file TxUI creates shares.
///
/// Deliberately opinionated: ZSTD, one row group per 128k rows, statistics on
/// (the crate default). Those are the settings that make a file useful to
/// whatever reads it next, and none of them are worth a dialog.
fn writer_properties() -> Result<parquet::file::properties::WriterProperties> {
    use parquet::basic::{Compression, ZstdLevel};
    use parquet::file::properties::WriterProperties;
    Ok(WriterProperties::builder()
        .set_compression(Compression::ZSTD(ZstdLevel::try_new(3)?))
        .set_max_row_group_row_count(Some(128 * 1024))
        .set_created_by("TxUI".to_string())
        .build())
}

/// Create a Parquet file from a result grid.
///
/// This is how a Parquet file gets *made* here: Parquet is immutable, so
/// "create" means "write once, completely". The source is any query result
/// from any engine, so the schema has to be inferred from the values rather
/// than taken from a catalog — see [`infer_type`].
pub fn write_grid(
    path: &Path,
    columns: &[String],
    rows: &[Vec<serde_json::Value>],
) -> Result<u64> {
    use arrow_array::{BooleanArray, Float64Array, Int64Array, RecordBatch, StringArray};
    use arrow_schema::{DataType, Field, Schema};
    use parquet::arrow::ArrowWriter;

    if columns.is_empty() {
        bail!("nothing to write: the result has no columns");
    }

    // Column-major first: the type of a column is decided by ALL its values,
    // not by the first one. A column of integers with one string in it is a
    // string column — silently coercing it would lose data.
    let types: Vec<InferredType> = (0..columns.len())
        .map(|c| infer_type(rows.iter().map(|r| r.get(c).unwrap_or(&serde_json::Value::Null))))
        .collect();

    let fields: Vec<Field> = columns
        .iter()
        .zip(&types)
        .map(|(name, t)| {
            let dt = match t {
                InferredType::Int => DataType::Int64,
                InferredType::Float => DataType::Float64,
                InferredType::Bool => DataType::Boolean,
                InferredType::Text => DataType::Utf8,
            };
            // Everything is nullable: a result grid can always contain NULL,
            // and claiming REQUIRED would make the file lie about its data.
            Field::new(name, dt, true)
        })
        .collect();
    let schema = Arc::new(Schema::new(fields));

    let arrays: Vec<ArrayRef> = (0..columns.len())
        .map(|c| {
            let vals = rows.iter().map(|r| r.get(c).unwrap_or(&serde_json::Value::Null));
            match types[c] {
                InferredType::Int => Arc::new(vals.map(as_i64).collect::<Int64Array>()) as ArrayRef,
                InferredType::Float => Arc::new(vals.map(as_f64).collect::<Float64Array>()) as ArrayRef,
                InferredType::Bool => Arc::new(vals.map(as_bool).collect::<BooleanArray>()) as ArrayRef,
                InferredType::Text => {
                    let v: Vec<Option<String>> = vals.map(as_text).collect();
                    Arc::new(StringArray::from(v)) as ArrayRef
                }
            }
        })
        .collect();

    let file = File::create(path)?;
    let mut writer = ArrowWriter::try_new(file, schema.clone(), Some(writer_properties()?))?;
    // An empty result still produces a valid file — schema, no rows. That is a
    // legitimate thing to want, and RecordBatch::try_new rejects zero columns,
    // not zero rows.
    if !rows.is_empty() {
        writer.write(&RecordBatch::try_new(schema, arrays)?)?;
    }
    writer.close()?;
    Ok(std::fs::metadata(path).map(|m| m.len()).unwrap_or(0))
}

/// Create a Parquet file with a chosen schema and no rows.
///
/// The sibling of [`write_grid`]: that one infers a schema from a result
/// grid's values; this one takes the schema the user designed (the connection
/// form's *New…* dialog) and writes a valid, readable empty file with it.
/// Field nullability is honoured — a file that lies about REQUIRED columns is
/// worse than no file. Returns the size of the file written.
pub fn write_empty(path: &Path, fields: &[(String, arrow_schema::DataType, bool)]) -> Result<u64> {
    use arrow_schema::{Field, Schema};
    use parquet::arrow::ArrowWriter;

    if fields.is_empty() {
        bail!("a Parquet file needs at least one column");
    }
    let schema = Arc::new(Schema::new(
        fields
            .iter()
            .map(|(name, dt, nullable)| Field::new(name, dt.clone(), *nullable))
            .collect::<Vec<_>>(),
    ));
    let file = File::create(path)?;
    // Zero batches: schema, no rows — a valid file, and closing the writer is
    // what writes the footer.
    let writer = ArrowWriter::try_new(file, schema, Some(writer_properties()?))?;
    writer.close()?;
    Ok(std::fs::metadata(path).map(|m| m.len()).unwrap_or(0))
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum InferredType {
    Int,
    Float,
    Bool,
    Text,
}

/// Widen across every value in the column.
///
/// NULLs carry no type information and are skipped. Int widens to Float when
/// both appear; anything that does not fit one numeric or boolean shape falls
/// back to text, which can hold every JSON scalar losslessly. An all-NULL (or
/// empty) column becomes text — the type is genuinely unknown, and text is the
/// only choice that cannot misrepresent it.
fn infer_type<'a>(values: impl Iterator<Item = &'a serde_json::Value>) -> InferredType {
    let mut seen_int = false;
    let mut seen_float = false;
    let mut seen_bool = false;
    let mut seen_other = false;

    for v in values {
        match v {
            serde_json::Value::Null => {}
            serde_json::Value::Bool(_) => seen_bool = true,
            serde_json::Value::Number(n) => {
                if n.is_i64() || n.is_u64() {
                    seen_int = true;
                } else {
                    seen_float = true;
                }
            }
            _ => seen_other = true,
        }
    }

    // Any mixing of kinds means text — the alternative is losing values.
    let kinds = [seen_int || seen_float, seen_bool, seen_other]
        .iter()
        .filter(|x| **x)
        .count();
    if kinds > 1 || seen_other {
        return InferredType::Text;
    }
    if seen_bool {
        return InferredType::Bool;
    }
    if seen_float {
        return InferredType::Float;
    }
    if seen_int {
        return InferredType::Int;
    }
    InferredType::Text
}

fn as_i64(v: &serde_json::Value) -> Option<i64> {
    v.as_i64().or_else(|| v.as_u64().map(|u| u as i64))
}
fn as_f64(v: &serde_json::Value) -> Option<f64> {
    v.as_f64()
}
fn as_bool(v: &serde_json::Value) -> Option<bool> {
    v.as_bool()
}
fn as_text(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::Null => None,
        serde_json::Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}

#[cfg(test)]
mod write_tests {
    use super::*;
    use serde_json::json;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("txui-pqw-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        let _ = std::fs::remove_file(&p);
        p
    }

    #[test]
    fn a_column_is_typed_by_all_its_values_not_the_first() {
        // An integer column with one string in it is a STRING column. Typing
        // it from the first value would drop the string.
        assert_eq!(infer_type([json!(1), json!(2), json!("x")].iter()), InferredType::Text);
        // Mixed int/float widens to float rather than truncating.
        assert_eq!(infer_type([json!(1), json!(2.5)].iter()), InferredType::Float);
        // NULLs carry no type and must not force text on their own.
        assert_eq!(infer_type([json!(null), json!(7), json!(null)].iter()), InferredType::Int);
        assert_eq!(infer_type([json!(true), json!(null)].iter()), InferredType::Bool);
        // Bool mixed with a number is not a number.
        assert_eq!(infer_type([json!(true), json!(1)].iter()), InferredType::Text);
        // Unknown (all NULL / empty) → text, the only lossless fallback.
        assert_eq!(infer_type([json!(null)].iter()), InferredType::Text);
        assert_eq!(infer_type([].iter()), InferredType::Text);
    }

    #[test]
    fn a_written_file_reads_back_identically() {
        let path = tmp("roundtrip.parquet");
        let cols = vec!["id".to_string(), "name".to_string(), "score".to_string(), "ok".to_string()];
        let rows = vec![
            vec![json!(1), json!("alice"), json!(1.5), json!(true)],
            vec![json!(2), json!(null), json!(2.0), json!(false)],
            vec![json!(3), json!("cara"), json!(null), json!(null)],
        ];
        let size = write_grid(&path, &cols, &rows).unwrap();
        assert!(size > 0);

        let f = open_path(&path).unwrap();
        assert_eq!(f.num_rows(), 3);
        assert_eq!(f.leaf_names(), cols);
        // Our own writer must be recorded, and the codec must be the one asked for.
        assert!(f.metadata.file_metadata().created_by().unwrap_or("").contains("TxUI"));
        let cc = execute_file(&f, "COLUMNCHUNKS").unwrap();
        let codec = cc.columns.iter().position(|c| c.name == "codec").unwrap();
        assert!(cc.rows.iter().all(|r| r[codec] == json!("ZSTD")));

        // Values survive, NULLs stay NULL.
        let r = preview(&f, 10, 0).unwrap();
        assert_eq!(r.rows[0][1], json!("alice"));
        assert_eq!(r.rows[1][1], serde_json::Value::Null);
        assert_eq!(r.rows[0][0], json!("1"));
        assert_eq!(r.rows[2][2], serde_json::Value::Null);
        assert_eq!(r.rows[1][3], json!("false"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn an_empty_result_still_writes_a_valid_file() {
        let path = tmp("empty.parquet");
        let cols = vec!["a".to_string(), "b".to_string()];
        write_grid(&path, &cols, &[]).unwrap();
        let f = open_path(&path).unwrap();
        assert_eq!(f.num_rows(), 0);
        assert_eq!(f.leaf_names(), cols);
        // The schema is still readable, which is the point of writing it.
        assert_eq!(execute_file(&f, "SCHEMA").unwrap().rows.len(), 2);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_result_with_no_columns_is_refused_rather_than_writing_a_broken_file() {
        let path = tmp("nocols.parquet");
        let err = write_grid(&path, &[], &[]).unwrap_err().to_string();
        assert!(err.contains("no columns"), "{err}");
        assert!(!path.exists(), "no file should have been created");
    }

    #[test]
    fn write_empty_creates_a_valid_file_with_the_exact_schema() {
        use arrow_schema::{DataType, TimeUnit};
        let path = tmp("created.parquet");
        let fields = vec![
            ("id".to_string(), DataType::Int64, false),
            ("name".to_string(), DataType::Utf8, true),
            ("amount".to_string(), DataType::Decimal128(10, 2), true),
            ("when".to_string(), DataType::Timestamp(TimeUnit::Millisecond, None), true),
        ];
        let size = write_empty(&path, &fields).unwrap();
        assert!(size > 0);

        let f = open_path(&path).unwrap();
        assert_eq!(f.num_rows(), 0);
        assert_eq!(f.leaf_names(), ["id", "name", "amount", "when"]);
        assert!(f.metadata.file_metadata().created_by().unwrap_or("").contains("TxUI"));

        // Names, types and nullability come back exactly as asked for.
        let schema_cols = preview(&f, 1, 0).unwrap().columns;
        let find = |name: &str| schema_cols.iter().find(|c| c.name == name)
            .unwrap_or_else(|| panic!("no column {name}"));
        assert_eq!(find("id").type_name, "Int64");
        assert!(!find("id").nullable);
        assert_eq!(find("name").type_name, "Utf8");
        assert!(find("name").nullable);
        assert_eq!(find("amount").type_name, "Decimal128(10, 2)");
        // Parquet's own TIMESTAMP(MILLIS) logical type reads back as "Timestamp(ms)".
        assert_eq!(find("when").type_name, "Timestamp(ms)");

        // An empty file still pages and reports its schema.
        assert_eq!(preview(&f, 10, 0).unwrap().rows.len(), 0);
        assert_eq!(execute_file(&f, "SCHEMA").unwrap().rows.len(), 4);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn write_empty_refuses_a_schema_with_no_columns() {
        let path = tmp("created-nocols.parquet");
        let err = write_empty(&path, &[]).unwrap_err().to_string();
        assert!(err.contains("at least one column"), "{err}");
        assert!(!path.exists(), "no file should have been created");
    }
}

/// Nested columns (struct/list/map) must cross the row boundary as real JSON —
/// objects and arrays the grid and the cell viewer's JSON tree can read —
/// never as arrow's `{city: nyc}` display text. And the two ways a struct can
/// look empty (NULL struct vs all-NULL fields) must stay distinct.
#[cfg(test)]
mod nested_json_tests {
    use super::*;
    use crate::db::types::{FilterClause, FilterOp};
    use arrow_array::{
        builder::{
            ArrayBuilder, ListBuilder, MapBuilder, PrimitiveBuilder, StringBuilder, StructBuilder,
        },
        types::Int64Type,
        ArrayRef, Int64Array, RecordBatch,
    };
    use arrow_schema::{DataType, Field, Fields, Schema};
    use parquet::arrow::ArrowWriter;
    use serde_json::json;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("txui-pqn-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        let _ = std::fs::remove_file(&p);
        p
    }

    /// One file holding every nested shape: a struct (one row NULL, one row
    /// with all-NULL fields), a list of ints (one row NULL) and a string→int
    /// map, plus a plain `id` to filter on.
    fn nested_fixture(name: &str) -> PathBuf {
        let path = tmp(name);
        let addr_fields = Fields::from(vec![
            Field::new("city", DataType::Utf8, true),
            Field::new("zip", DataType::Int64, true),
        ]);
        let schema = Arc::new(Schema::new(vec![
            Field::new("id", DataType::Int64, false),
            Field::new("addr", DataType::Struct(addr_fields.clone()), true),
            Field::new(
                "tags",
                DataType::List(Arc::new(Field::new("item", DataType::Int64, true))),
                true,
            ),
            Field::new(
                "props",
                DataType::Map(
                    Arc::new(Field::new(
                        "entries",
                        DataType::Struct(Fields::from(vec![
                            Field::new("keys", DataType::Utf8, false),
                            Field::new("values", DataType::Int64, true),
                        ])),
                        false,
                    )),
                    false,
                ),
                true,
            ),
        ]));

        // Row 0: full values. Row 1: NULL struct, NULL list, NULL map.
        // Row 2: struct with all-NULL fields — NOT the same as row 1's NULL.
        let mut addr = StructBuilder::new(
            addr_fields,
            vec![
                Box::new(StringBuilder::new()) as Box<dyn ArrayBuilder>,
                Box::new(PrimitiveBuilder::<Int64Type>::new()) as Box<dyn ArrayBuilder>,
            ],
        );
        addr.field_builder::<StringBuilder>(0).unwrap().append_value("nyc");
        addr.field_builder::<PrimitiveBuilder<Int64Type>>(1).unwrap().append_value(10001);
        addr.append(true);
        addr.field_builder::<StringBuilder>(0).unwrap().append_null();
        addr.field_builder::<PrimitiveBuilder<Int64Type>>(1).unwrap().append_null();
        addr.append(false); // NULL struct
        addr.field_builder::<StringBuilder>(0).unwrap().append_null();
        addr.field_builder::<PrimitiveBuilder<Int64Type>>(1).unwrap().append_null();
        addr.append(true); // present, all-NULL fields
        let mut tags = ListBuilder::new(PrimitiveBuilder::<Int64Type>::new());
        tags.values().append_value(1);
        tags.values().append_value(2);
        tags.append(true);
        tags.append(false); // NULL list
        tags.append(true); // empty list
        let mut props = MapBuilder::new(None, StringBuilder::new(), PrimitiveBuilder::<Int64Type>::new());
        props.keys().append_value("a");
        props.values().append_value(1);
        props.append(true).unwrap();
        props.append(false).unwrap(); // NULL map
        props.append(true).unwrap(); // empty map

        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![
                Arc::new(Int64Array::from(vec![0i64, 1, 2])) as ArrayRef,
                Arc::new(addr.finish()) as ArrayRef,
                Arc::new(tags.finish()) as ArrayRef,
                Arc::new(props.finish()) as ArrayRef,
            ],
        )
        .unwrap();
        let file = File::create(&path).unwrap();
        let mut w = ArrowWriter::try_new(file, schema, None).unwrap();
        w.write(&batch).unwrap();
        w.close().unwrap();
        path
    }

    #[test]
    fn preview_returns_json_objects_and_arrays_not_arrow_display_text() {
        let path = nested_fixture("nested-json.parquet");
        let f = open_path(&path).unwrap();
        let r = preview(&f, 10, 0).unwrap();
        assert_eq!(r.rows.len(), 3);

        // Struct → object, list → array, map → object.
        assert_eq!(r.rows[0][1], json!({"city": "nyc", "zip": "10001"}));
        assert_eq!(r.rows[0][2], json!(["1", "2"]));
        assert_eq!(r.rows[0][3], json!({"a": "1"}));
        // None of it is the arrow display format.
        for row in &r.rows {
            for cell in &row[1..] {
                if let serde_json::Value::String(st) = cell {
                    assert!(!st.starts_with('{'), "arrow display text leaked: {st}");
                }
            }
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_null_struct_and_an_all_null_fields_struct_are_not_the_same() {
        let path = nested_fixture("nested-nulls.parquet");
        let f = open_path(&path).unwrap();
        let r = preview(&f, 10, 0).unwrap();
        // Row 1: the struct itself is NULL.
        assert_eq!(r.rows[1][1], serde_json::Value::Null);
        assert_eq!(r.rows[1][2], serde_json::Value::Null);
        assert_eq!(r.rows[1][3], serde_json::Value::Null);
        // Row 2: present, with every field NULL — an object, not a NULL.
        assert_eq!(r.rows[2][1], json!({"city": null, "zip": null}));
        assert_eq!(r.rows[2][2], json!([]));
        assert_eq!(r.rows[2][3], json!({}));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn nested_values_survive_a_filter_on_a_sibling_column() {
        let path = nested_fixture("nested-filter.parquet");
        let f = open_path(&path).unwrap();
        let filters = [FilterClause {
            column: "id".into(),
            op: FilterOp::Eq,
            value: Some("0".into()),
        }];
        let r = preview_filtered(&f, 10, 0, &filters, &[]).unwrap();
        assert_eq!(r.rows.len(), 1);
        assert_eq!(r.rows[0][1], json!({"city": "nyc", "zip": "10001"}));
        assert_eq!(r.rows[0][2], json!(["1", "2"]));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn ndjson_export_embeds_nested_json_natively_and_csv_stringifies_it() {
        let path = nested_fixture("nested-export.parquet");
        let f = open_path(&path).unwrap();

        let out = tmp("nested.ndjson");
        export_to_file(&f, &out, "json").unwrap();
        let lines: Vec<serde_json::Value> = std::fs::read_to_string(&out)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines[0]["addr"], json!({"city": "nyc", "zip": "10001"}));
        assert_eq!(lines[0]["tags"], json!(["1", "2"]));
        assert_eq!(lines[1]["addr"], serde_json::Value::Null);
        assert_eq!(lines[2]["addr"], json!({"city": null, "zip": null}));
        let _ = std::fs::remove_file(&out);

        let out = tmp("nested.csv");
        export_to_file(&f, &out, "csv").unwrap();
        let body = std::fs::read_to_string(&out).unwrap();
        let csv_lines: Vec<&str> = body.lines().collect();
        // The struct cell is quoted JSON text, with the quotes doubled.
        assert!(csv_lines[1].contains("\"{\"\"city\"\":\"\"nyc\"\",\"\"zip\"\":\"\"10001\"\"}\""),
            "csv line: {}", csv_lines[1]);
        let _ = std::fs::remove_file(&out);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_decimal_leaf_keeps_its_exact_text_inside_a_struct() {
        use arrow_array::{Decimal128Array, StructArray};
        let path = tmp("nested-decimal.parquet");
        let dec_field = Field::new("amount", DataType::Decimal128(10, 2), true);
        let fields = Fields::from(vec![dec_field.clone()]);
        let schema = Arc::new(Schema::new(vec![Field::new(
            "line",
            DataType::Struct(fields.clone()),
            false,
        )]));
        let st = StructArray::new(
            fields,
            vec![Arc::new(
                Decimal128Array::from(vec![12345i128])
                    .with_precision_and_scale(10, 2)
                    .unwrap(),
            ) as ArrayRef],
            None,
        );
        let batch =
            RecordBatch::try_new(schema.clone(), vec![Arc::new(st) as ArrayRef]).unwrap();
        let file = File::create(&path).unwrap();
        let mut w = ArrowWriter::try_new(file, schema, None).unwrap();
        w.write(&batch).unwrap();
        w.close().unwrap();

        let f = open_path(&path).unwrap();
        let r = preview(&f, 10, 0).unwrap();
        // Exact text — never a float.
        assert_eq!(r.rows[0][0], json!({"amount": "123.45"}));
        let _ = std::fs::remove_file(&path);
    }
}

// ── Deeper views ─────────────────────────────────────────────────────────────
/// Per-PAGE statistics, from the page index.
///
/// This is the finest granularity Parquet exposes and the level a reader
/// actually skips at. A column chunk with useful chunk-level min/max can still
/// be unskippable page by page if the data is unsorted — that only shows here.
fn pages(f: &ParquetFile) -> (Vec<ColumnInfo>, Vec<Row>) {
    use parquet::file::page_index::column_index::ColumnIndexMetaData;

    let (Some(ci), Some(oi)) = (f.metadata.column_index(), f.metadata.offset_index()) else {
        return (
            cols(&["note"]),
            vec![vec![s("This file has no page index — it was written without one, so \
                        per-page statistics do not exist. Column chunks still have their own.")]],
        );
    };

    let leaves = f.leaf_names();
    let mut rows = Vec::new();
    for (gi, groups) in ci.iter().enumerate() {
        for (li, index) in groups.iter().enumerate() {
            let name = leaves.get(li).cloned().unwrap_or_default();
            let locations = oi.get(gi).and_then(|g| g.get(li)).map(|o| o.page_locations());
            // Every Index variant carries the same shape; the macro keeps the
            // eight physical types from becoming eight copies of this loop.
            macro_rules! emit {
                ($idx:expr, $fmt:expr) => {
                    for pi in 0..($idx.num_pages() as usize) {
                        let loc = locations.and_then(|l| l.get(pi));
                        #[allow(clippy::redundant_closure_call)]
                        rows.push(vec![
                            n(gi as i64), s(name.clone()), n(pi as i64),
                            loc.map(|l| n(l.first_row_index)).unwrap_or(serde_json::Value::Null),
                            loc.map(|l| n(l.compressed_page_size as i64)).unwrap_or(serde_json::Value::Null),
                            $idx.min_value(pi).map(|v| s(($fmt)(v))).unwrap_or(serde_json::Value::Null),
                            $idx.max_value(pi).map(|v| s(($fmt)(v))).unwrap_or(serde_json::Value::Null),
                            $idx.null_count(pi).map(n).unwrap_or(serde_json::Value::Null),
                        ]);
                    }
                };
            }
            // parquet 58 renamed Index → ColumnIndexMetaData and swapped the
            // per-page structs for typed min/max/null accessors — the shape
            // of the emitted rows is unchanged.
            match index {
                ColumnIndexMetaData::NONE => {}
                ColumnIndexMetaData::BOOLEAN(i) => emit!(i, |v: &bool| v.to_string()),
                ColumnIndexMetaData::INT32(i) => emit!(i, |v: &i32| v.to_string()),
                ColumnIndexMetaData::INT64(i) => emit!(i, |v: &i64| v.to_string()),
                ColumnIndexMetaData::INT96(i) => emit!(i, |v: &parquet::data_type::Int96| v.to_string()),
                ColumnIndexMetaData::FLOAT(i) => emit!(i, |v: &f32| v.to_string()),
                ColumnIndexMetaData::DOUBLE(i) => emit!(i, |v: &f64| v.to_string()),
                ColumnIndexMetaData::BYTE_ARRAY(i) =>
                    emit!(i, |v: &[u8]| String::from_utf8_lossy(v).into_owned()),
                ColumnIndexMetaData::FIXED_LEN_BYTE_ARRAY(i) => emit!(i, |v: &[u8]| hex(v)),
            }
            if rows.len() > 5000 {
                break;
            }
        }
    }
    (
        cols(&["row_group", "column", "page", "first_row", "compressed", "min", "max", "nulls"]),
        rows,
    )
}

/// Encoding usage per column — above all, whether dictionary encoding was used.
///
/// A dictionary is what makes a low-cardinality column cheap. When a writer
/// gives up on it (the dictionary outgrew its page-size limit) the column
/// silently falls back to PLAIN and gets much larger; that fallback is
/// invisible everywhere except here.
fn encodings(f: &ParquetFile) -> (Vec<ColumnInfo>, Vec<Row>) {
    let leaves = f.leaf_names();
    let mut rows = Vec::new();
    for (li, name) in leaves.iter().enumerate() {
        let mut enc: Vec<String> = Vec::new();
        let mut dict_chunks = 0;
        let mut total_chunks = 0;
        let mut dict_bytes = 0i64;
        for rg in f.metadata.row_groups() {
            let Some(cc) = rg.columns().get(li) else { continue };
            total_chunks += 1;
            let has_dict = cc.dictionary_page_offset().is_some();
            if has_dict {
                dict_chunks += 1;
                // The dictionary page sits immediately before the data pages.
                if let (Some(d), off) = (cc.dictionary_page_offset(), cc.data_page_offset()) {
                    dict_bytes += (off - d).max(0);
                }
            }
            for e in cc.encodings() {
                let name = encoding_name(&e);
                if !enc.contains(&name) {
                    enc.push(name);
                }
            }
        }
        rows.push(vec![
            s(name.clone()),
            s(enc.join(", ")),
            n(dict_chunks),
            n(total_chunks),
            s(if dict_chunks == 0 {
                "no dictionary".to_string()
            } else if dict_chunks == total_chunks {
                "all chunks".to_string()
            } else {
                // The interesting case: the writer gave up part-way.
                format!("{dict_chunks} of {total_chunks} — fell back")
            }),
            s(human_bytes(dict_bytes)),
        ]);
    }
    (
        cols(&["column", "encodings", "dict_chunks", "chunks", "dictionary", "dict_bytes"]),
        rows,
    )
}

/// Bytes per compression codec — what the file is actually paying for.
fn codecs(f: &ParquetFile) -> (Vec<ColumnInfo>, Vec<Row>) {
    let mut by: std::collections::BTreeMap<&str, (i64, i64, i64)> = Default::default();
    for rg in f.metadata.row_groups() {
        for cc in rg.columns() {
            let e = by.entry(codec_name(cc.compression())).or_insert((0, 0, 0));
            e.0 += cc.compressed_size();
            e.1 += cc.uncompressed_size();
            e.2 += 1;
        }
    }
    let total: i64 = by.values().map(|v| v.0).sum();
    let rows = by
        .into_iter()
        .map(|(codec, (comp, raw, chunks))| {
            vec![
                s(codec),
                n(chunks),
                s(human_bytes(comp)),
                s(human_bytes(raw)),
                s(ratio(raw, comp)),
                s(pct(comp, total)),
            ]
        })
        .collect();
    (cols(&["codec", "chunks", "compressed", "uncompressed", "ratio", "share"]), rows)
}

/// Null density per column. An all-null column is storage spent on nothing;
/// a never-null column that is declared OPTIONAL costs a definition level per
/// value for no reason.
fn nulls(f: &ParquetFile) -> (Vec<ColumnInfo>, Vec<Row>) {
    let leaves = f.leaf_names();
    let descr = f.metadata.file_metadata().schema_descr();
    let total_rows = f.num_rows();
    let mut rows = Vec::new();
    for (li, name) in leaves.iter().enumerate() {
        let mut nulls = 0i64;
        let mut known = false;
        for rg in f.metadata.row_groups() {
            if let Some(st) = rg.columns().get(li).and_then(|c| c.statistics()) {
                if let Some(nc) = st.null_count_opt() {
                    nulls += nc as i64;
                    known = true;
                }
            }
        }
        let optional = descr.columns().get(li).map(|c| c.max_def_level() > 0).unwrap_or(false);
        rows.push(vec![
            s(name.clone()),
            s(if optional { "OPTIONAL" } else { "REQUIRED" }),
            if known { n(nulls) } else { serde_json::Value::Null },
            if known { s(pct(nulls, total_rows)) } else { serde_json::Value::Null },
            s(if !known {
                ""
            } else if nulls == total_rows && total_rows > 0 {
                "every value is null"
            } else if nulls == 0 && optional {
                "declared nullable, never null"
            } else {
                ""
            }),
        ]);
    }
    rows.sort_by_key(|r| std::cmp::Reverse(r[2].as_i64().unwrap_or(-1)));
    (cols(&["column", "repetition", "nulls", "null_pct", "note"]), rows)
}

/// Distinct counts where the writer recorded them, against the row count —
/// the ratio that decides whether a column is a dictionary/LowCardinality
/// candidate or a high-selectivity filter target.
fn cardinality(f: &ParquetFile) -> (Vec<ColumnInfo>, Vec<Row>) {
    let leaves = f.leaf_names();
    let total_rows = f.num_rows();
    let mut rows = Vec::new();
    for (li, name) in leaves.iter().enumerate() {
        let mut distinct = 0i64;
        let mut known = false;
        for rg in f.metadata.row_groups() {
            if let Some(st) = rg.columns().get(li).and_then(|c| c.statistics()) {
                if let Some(d) = st.distinct_count_opt() {
                    // Per row group, so this is an upper bound on the file's
                    // distinct count, not the exact value. Said so in the view.
                    distinct += d as i64;
                    known = true;
                }
            }
        }
        rows.push(vec![
            s(name.clone()),
            if known { n(distinct) } else { serde_json::Value::Null },
            if known && total_rows > 0 {
                s(format!("{:.4}", distinct as f64 / total_rows as f64))
            } else {
                serde_json::Value::Null
            },
            s(if !known { "writer recorded no distinct counts" } else { "" }),
        ]);
    }
    (cols(&["column", "distinct_upper_bound", "vs_rows", "note"]), rows)
}

/// How unevenly a column's bytes are spread across row groups. A column that
/// is tiny in most groups and huge in one is where a scan actually stalls.
fn skew(f: &ParquetFile) -> (Vec<ColumnInfo>, Vec<Row>) {
    let leaves = f.leaf_names();
    let groups = f.metadata.num_row_groups();
    if groups < 2 {
        return (
            cols(&["note"]),
            vec![vec![s("Only one row group — there is nothing to compare across.")]],
        );
    }
    let mut rows = Vec::new();
    for (li, name) in leaves.iter().enumerate() {
        let sizes: Vec<i64> = f
            .metadata
            .row_groups()
            .iter()
            .filter_map(|rg| rg.columns().get(li).map(|c| c.compressed_size()))
            .collect();
        if sizes.is_empty() {
            continue;
        }
        let min = *sizes.iter().min().unwrap();
        let max = *sizes.iter().max().unwrap();
        let sum: i64 = sizes.iter().sum();
        let avg = sum / sizes.len() as i64;
        rows.push(vec![
            s(name.clone()),
            s(human_bytes(min)),
            s(human_bytes(avg)),
            s(human_bytes(max)),
            s(if min > 0 { format!("{:.1}x", max as f64 / min as f64) } else { String::new() }),
        ]);
    }
    rows.sort_by_key(|r| {
        std::cmp::Reverse(
            r[4].as_str().and_then(|x| x.trim_end_matches('x').parse::<f64>().ok())
                .map(|v| (v * 100.0) as i64).unwrap_or(0),
        )
    });
    (cols(&["column", "smallest_group", "average", "largest_group", "max/min"]), rows)
}

/// Declared sort order per row group. A sorted column is what makes min/max
/// statistics selective; without one, chunk bounds usually overlap and nothing
/// can be skipped.
fn sorting(f: &ParquetFile) -> (Vec<ColumnInfo>, Vec<Row>) {
    let leaves = f.leaf_names();
    let mut rows = Vec::new();
    for (gi, rg) in f.metadata.row_groups().iter().enumerate() {
        match rg.sorting_columns() {
            Some(cols_) if !cols_.is_empty() => {
                for (ord, sc) in cols_.iter().enumerate() {
                    rows.push(vec![
                        n(gi as i64),
                        n(ord as i64),
                        s(leaves.get(sc.column_idx as usize).cloned().unwrap_or_default()),
                        s(if sc.descending { "DESC" } else { "ASC" }),
                        s(if sc.nulls_first { "NULLS FIRST" } else { "NULLS LAST" }),
                    ]);
                }
            }
            _ => rows.push(vec![
                n(gi as i64),
                serde_json::Value::Null,
                s("(no declared sort order)"),
                serde_json::Value::Null,
                serde_json::Value::Null,
            ]),
        }
    }
    (cols(&["row_group", "order", "column", "direction", "nulls"]), rows)
}

/// Bloom filters, which allow equality pruning that min/max cannot do on
/// unsorted data.
fn bloom(f: &ParquetFile) -> (Vec<ColumnInfo>, Vec<Row>) {
    let leaves = f.leaf_names();
    let mut rows = Vec::new();
    for (li, name) in leaves.iter().enumerate() {
        let mut with = 0;
        let mut total = 0;
        let mut bytes = 0i64;
        for rg in f.metadata.row_groups() {
            let Some(cc) = rg.columns().get(li) else { continue };
            total += 1;
            if cc.bloom_filter_offset().is_some() {
                with += 1;
                bytes += cc.bloom_filter_length().unwrap_or(0) as i64;
            }
        }
        rows.push(vec![
            s(name.clone()),
            n(with),
            n(total),
            s(human_bytes(bytes)),
            s(if with == 0 { "no — equality filters cannot be pruned by bloom" } else { "" }),
        ]);
    }
    (cols(&["column", "chunks_with_bloom", "chunks", "bloom_bytes", "note"]), rows)
}

/// A findings report for the file — the Parquet equivalent of the tuner.
///
/// Everything here is derived from the footer, so it costs nothing to run and
/// says what is actually wrong with how the file was written.
fn health(f: &ParquetFile) -> (Vec<ColumnInfo>, Vec<Row>) {
    let mut out: Vec<(&str, String, String)> = Vec::new();
    let groups = f.metadata.num_row_groups();
    let total_rows = f.num_rows();
    let leaves = f.leaf_names();

    // Row-group sizing. Too many tiny groups means per-group overhead and poor
    // parallelism; one enormous group means nothing can be skipped or split.
    let avg_rows = if groups > 0 { total_rows / groups as i64 } else { 0 };
    if groups == 0 {
        out.push(("critical", "No row groups".into(), "The file contains no data at all.".into()));
    } else if groups > 1 && avg_rows < 10_000 {
        out.push((
            "warn",
            format!("{groups} row groups averaging {avg_rows} rows"),
            "Very small row groups: per-group metadata and per-chunk overhead dominate, and readers \
             cannot amortise decompression. 100k–1M rows per group is the usual target."
                .into(),
        ));
    } else if groups == 1 && total_rows > 5_000_000 {
        out.push((
            "warn",
            format!("One row group holding {total_rows} rows"),
            "A single row group cannot be split across readers and cannot be skipped — every query \
             reads all of it."
                .into(),
        ));
    }

    // Statistics coverage: without min/max nothing can be skipped.
    let mut no_stats: Vec<String> = Vec::new();
    for (li, name) in leaves.iter().enumerate() {
        let has = f.metadata.row_groups().iter().any(|rg| {
            rg.columns().get(li).and_then(|c| c.statistics()).map(|st| st.min_is_exact() || st.max_is_exact()).unwrap_or(false)
        });
        if !has {
            no_stats.push(name.clone());
        }
    }
    if !no_stats.is_empty() {
        out.push((
            if no_stats.len() == leaves.len() { "critical" } else { "warn" },
            format!("{} column(s) have no min/max statistics", no_stats.len()),
            format!(
                "A reader cannot skip a chunk it has no bounds for, so filters on these columns \
                 always read everything: {}",
                truncate_list(&no_stats)
            ),
        ));
    }

    // Page index — the difference between skipping a chunk and skipping a page.
    if f.metadata.column_index().is_none() {
        out.push((
            "advice",
            "No page index".into(),
            "The file was written without a page index, so readers can skip whole column chunks but \
             never individual pages. Most writers can enable it."
                .into(),
        ));
    }

    // Compression.
    let uncompressed_chunks = f
        .metadata
        .row_groups()
        .iter()
        .flat_map(|rg| rg.columns())
        .filter(|cc| matches!(cc.compression(), Compression::UNCOMPRESSED))
        .count();
    if uncompressed_chunks > 0 {
        out.push((
            "warn",
            format!("{uncompressed_chunks} column chunk(s) are uncompressed"),
            "Parquet's compression is per chunk; uncompressed chunks are usually an unset writer \
             property rather than a decision."
                .into(),
        ));
    }

    // Dictionary fallback — a column that lost its dictionary part-way.
    let mut fallback: Vec<String> = Vec::new();
    for (li, name) in leaves.iter().enumerate() {
        let with = f.metadata.row_groups().iter()
            .filter(|rg| rg.columns().get(li).map(|c| c.dictionary_page_offset().is_some()).unwrap_or(false))
            .count();
        if with > 0 && with < groups {
            fallback.push(name.clone());
        }
    }
    if !fallback.is_empty() {
        out.push((
            "warn",
            format!("{} column(s) lost dictionary encoding part-way", fallback.len()),
            format!(
                "The writer started with a dictionary and fell back to PLAIN when it outgrew the \
                 page limit — those chunks are much larger: {}",
                truncate_list(&fallback)
            ),
        ));
    }

    // All-null columns: pure overhead.
    let mut all_null: Vec<String> = Vec::new();
    for (li, name) in leaves.iter().enumerate() {
        let nulls: i64 = f.metadata.row_groups().iter()
            .filter_map(|rg| rg.columns().get(li).and_then(|c| c.statistics()).and_then(|st| st.null_count_opt()))
            .map(|v| v as i64).sum();
        if total_rows > 0 && nulls == total_rows {
            all_null.push(name.clone());
        }
    }
    if !all_null.is_empty() {
        out.push((
            "advice",
            format!("{} column(s) are entirely null", all_null.len()),
            format!("Storage and metadata spent on no data: {}", truncate_list(&all_null)),
        ));
    }

    // Sorting: without it, min/max bounds overlap and prune nothing.
    let sorted = f.metadata.row_groups().iter()
        .any(|rg| rg.sorting_columns().map(|c| !c.is_empty()).unwrap_or(false));
    if !sorted && groups > 1 {
        out.push((
            "advice",
            "No declared sort order".into(),
            "Row groups declare no sorting column, so min/max ranges usually overlap and statistics \
             prune far less than they could. Sorting on the column you filter by is the single \
             biggest read-time win available to a Parquet file."
                .into(),
        ));
    }

    if out.is_empty() {
        out.push(("ok", "Nothing to report".into(),
                  "Row-group sizing, statistics coverage, compression and encoding all look sound."
                      .into()));
    }

    // Severity order: critical, warn, advice, ok.
    let rank = |s: &str| match s { "critical" => 0, "warn" => 1, "advice" => 2, _ => 3 };
    out.sort_by_key(|(sev, _, _)| rank(sev));

    let rows = out.into_iter()
        .map(|(sev, title, detail)| vec![s(sev), s(title), s(detail)])
        .collect();
    (cols(&["severity", "finding", "detail"]), rows)
}

/// Keep a findings line readable when dozens of columns match.
fn truncate_list(items: &[String]) -> String {
    const MAX: usize = 8;
    if items.len() <= MAX {
        return items.join(", ");
    }
    format!("{}, … and {} more", items[..MAX].join(", "), items.len() - MAX)
}

#[cfg(test)]
mod deep_view_tests {
    use super::*;

    const SAMPLE: &str = "../../txui-data/gcp-prod-sql-cz-web-877f.parquet";

    #[test]
    fn every_command_works_on_the_real_file_and_health_says_something_useful() {
        if !Path::new(SAMPLE).exists() {
            eprintln!("skipping: sample not present");
            return;
        }
        let f = open_path(Path::new(SAMPLE)).unwrap();
        for cmd in COMMANDS {
            if *cmd == "PREVIEW" { continue; }
            let r = execute_file(&f, cmd).unwrap_or_else(|e| panic!("{cmd}: {e}"));
            assert!(!r.columns.is_empty(), "{cmd} produced no columns");
            eprintln!("{cmd:<12} {:>5} rows x {} cols", r.rows.len(), r.columns.len());
        }

        // HEALTH must always produce at least one row — silence would be
        // indistinguishable from the view being broken.
        let h = execute_file(&f, "HEALTH").unwrap();
        assert!(!h.rows.is_empty());
        eprintln!("\n--- HEALTH ---");
        for row in &h.rows {
            eprintln!("[{}] {}\n    {}",
                row[0].as_str().unwrap_or(""), row[1].as_str().unwrap_or(""),
                row[2].as_str().unwrap_or(""));
        }
        // Severities are a closed set the UI colours by.
        for row in &h.rows {
            let sev = row[0].as_str().unwrap();
            assert!(["critical", "warn", "advice", "ok"].contains(&sev), "bad severity {sev}");
        }
        // …and sorted worst-first.
        let rank = |s: &str| match s { "critical" => 0, "warn" => 1, "advice" => 2, _ => 3 };
        let ranks: Vec<i32> = h.rows.iter().map(|r| rank(r[0].as_str().unwrap())).collect();
        assert!(ranks.windows(2).all(|w| w[0] <= w[1]), "findings are not worst-first");
    }
}

/// Partitioned datasets: a directory opened as one object. The fixtures build
/// a hive layout (`year=…/month=…/part.parquet`) with one schema-drifted file,
/// and the assertions cover the two halves of the feature — the footer
/// forensics (per file, with a leading `file` column) and the row path (the
/// read-only DuckDB view, driven exactly the way the data browser drives it).
#[cfg(test)]
mod dataset_tests {
    use super::*;
    use crate::db::types::{Engine, FilterClause, FilterOp, SortClause, SortDir};
    use arrow_array::{ArrayRef, Int64Array, RecordBatch, StringArray};
    use arrow_schema::{DataType, Field, Schema};
    use parquet::arrow::ArrowWriter;
    use serde_json::json;

    /// One test-private dataset root (tests in this module run in parallel).
    fn root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("txui-pqds-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Write one member file: `id` (REQUIRED), `label`, and optionally an
    /// `extra` column that only exists in the drifted file.
    fn write_part(path: &Path, ids: std::ops::Range<i64>, with_extra: bool) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut fields = vec![
            Field::new("id", DataType::Int64, false),
            Field::new("label", DataType::Utf8, true),
        ];
        if with_extra {
            fields.push(Field::new("extra", DataType::Utf8, true));
        }
        let schema = Arc::new(Schema::new(fields));
        let mut cols: Vec<ArrayRef> = vec![
            Arc::new(Int64Array::from(ids.clone().collect::<Vec<_>>())) as ArrayRef,
            Arc::new(StringArray::from(
                ids.clone().map(|i| Some(format!("row-{i}"))).collect::<Vec<_>>(),
            )) as ArrayRef,
        ];
        if with_extra {
            cols.push(Arc::new(StringArray::from(
                ids.map(|i| Some(format!("x-{i}"))).collect::<Vec<_>>(),
            )) as ArrayRef);
        }
        let batch = RecordBatch::try_new(schema.clone(), cols).unwrap();
        let file = File::create(path).unwrap();
        let mut w = ArrowWriter::try_new(file, schema, None).unwrap();
        w.write(&batch).unwrap();
        w.close().unwrap();
    }

    /// The standard fixture: 150 rows in three files over two years, the
    /// 2025 file carrying the drifted `extra` column.
    fn fixture(tag: &str) -> PathBuf {
        let root = root(tag);
        write_part(&root.join("year=2024/month=01/part.parquet"), 0..50, false);
        write_part(&root.join("year=2024/month=02/part.parquet"), 50..100, false);
        write_part(&root.join("year=2025/month=01/part.parquet"), 100..150, true);
        root
    }

    fn config_for(root: &Path) -> ConnectionConfig {
        let mut c = ConnectionConfig::new(Engine::Parquet, "ds");
        c.file_path = Some(root.to_string_lossy().into_owned());
        c
    }

    #[test]
    fn a_directory_opens_as_a_dataset_with_partitions_and_a_total_row_count() {
        let root = fixture("open");
        let src = open(&config_for(&root)).unwrap();
        let ParquetSource::Dataset(d) = &src else {
            panic!("a directory must open as a dataset");
        };
        assert_eq!(d.files.len(), 3);
        assert_eq!(d.partition_cols, vec!["year", "month"]);
        assert_eq!(d.num_rows(), 150);

        // Ping says what this is.
        let p = ping(&src);
        assert!(p.ok);
        assert_eq!(p.server_version.as_deref(), Some("Parquet dataset · 3 files"));

        // The tree is named after the directory and carries the summed count.
        let dir_name = root.file_name().unwrap().to_string_lossy().into_owned();
        assert!(matches!(&list_schema(&src, None)[0],
            SchemaNode::Database { name } if name == &dir_name));
        assert!(matches!(&list_schema(&src, Some(&dir_name))[0],
            SchemaNode::Table { name, row_count: Some(150), .. } if name == &dir_name));

        // Merged schema: data columns first-wins, then the tagged extras.
        let cols = list_columns(&src);
        let has = |name: &str, tag: &str| cols.iter().any(|c| matches!(c,
            SchemaNode::Column { name: n, type_name, .. } if n == name && type_name.contains(tag)));
        assert!(has("id", "INT64"));
        assert!(has("label", "BYTE_ARRAY"));
        assert!(has("extra", "BYTE_ARRAY"), "drifted column must merge in: {cols:?}");
        assert!(has("year", "partition"));
        assert!(has("month", "partition"));
        assert!(has("filename", "source file"));

        // FILEINFO is the dataset summary, not one file's.
        let fi = execute(&src, "FILEINFO").unwrap();
        let val = |key: &str| fi.rows.iter()
            .find(|r| r[0] == json!(key)).map(|r| r[1].clone()).unwrap();
        assert_eq!(val("files"), json!(3));
        assert_eq!(val("rows"), json!(150));
        assert_eq!(val("partition columns"), json!("year, month"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_browser_query_filters_on_a_hive_key_through_the_view() {
        let root = fixture("hive");
        let d = open_dataset(&root).unwrap();

        // Exactly what browse_table builds and runs for a dataset session:
        // the PG-form builder against the `dataset` view, string params bound.
        let filters = vec![FilterClause {
            column: "year".into(),
            op: FilterOp::Eq,
            value: Some("2024".into()),
        }];
        let sort = vec![SortClause { column: "id".into(), direction: SortDir::Desc }];
        let q = crate::db::browser::build_select("dataset", &filters, &sort, 500, 0, true,
                                                 &Default::default());
        let r = super::super::duckdb::execute_params_blocking(&d.duck, &q.sql, &q.values).unwrap();
        // Only the 2024 files match — the hive wiring, not a full scan.
        assert_eq!(r.rows.len(), 100);
        let id = r.columns.iter().position(|c| c.name == "id").unwrap();
        let file = r.columns.iter().position(|c| c.name == "filename").unwrap();
        // Sort pushed down: largest id of the 2024 range first.
        assert_eq!(r.rows[0][id], json!(99));
        for row in &r.rows {
            assert!(row[file].as_str().unwrap().contains("year=2024"),
                    "a 2025 row leaked through the hive filter: {row:?}");
        }

        // The partition columns are real, queryable columns.
        let r = super::super::duckdb::execute_params_blocking(
            &d.duck, "SELECT DISTINCT month FROM dataset WHERE year = '2024' ORDER BY 1", &[])
            .unwrap();
        assert_eq!(r.rows.len(), 2);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn schema_drift_reads_through_union_by_name() {
        let root = fixture("drift");
        let d = open_dataset(&root).unwrap();
        let q = |sql: &str| super::super::duckdb::execute_params_blocking(&d.duck, sql, &[]).unwrap();

        // Every row reads; the drifted column is NULL where the file lacks it.
        assert_eq!(q("SELECT COUNT(*) FROM dataset").rows[0][0], json!(150));
        assert_eq!(q("SELECT COUNT(*) FROM dataset WHERE extra IS NOT NULL").rows[0][0], json!(50));
        assert_eq!(q("SELECT extra FROM dataset WHERE id = 100").rows[0][0], json!("x-100"));
        assert_eq!(q("SELECT extra FROM dataset WHERE id = 5").rows[0][0], serde_json::Value::Null);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn every_command_returns_a_grid_on_a_dataset() {
        let root = fixture("verbs");
        let src = open(&config_for(&root)).unwrap();
        for cmd in COMMANDS {
            let r = execute(&src, cmd).unwrap_or_else(|e| panic!("{cmd}: {e}"));
            assert!(!r.columns.is_empty(), "{cmd} produced no columns");
            assert!(!r.rows.is_empty(), "{cmd} produced no rows");
        }

        // Per-file views gain the leading `file` column, one entry per file.
        let rg = execute(&src, "ROWGROUPS").unwrap();
        assert_eq!(rg.columns[0].name, "file");
        assert_eq!(rg.rows.len(), 3);
        let files: std::collections::HashSet<_> =
            rg.rows.iter().map(|r| r[0].as_str().unwrap()).collect();
        assert!(files.iter().all(|f| f.starts_with("year=")), "{files:?}");

        // HEALTH aggregates the same way, and its severity set is unchanged.
        let h = execute(&src, "HEALTH").unwrap();
        assert_eq!(h.columns[0].name, "file");
        for row in &h.rows {
            let sev = row[1].as_str().unwrap();
            assert!(["critical", "warn", "advice", "ok"].contains(&sev), "bad severity {sev}");
        }

        // PREVIEW goes through the view: data, partition and filename columns.
        let p = execute(&src, "PREVIEW 10").unwrap();
        assert_eq!(p.rows.len(), 10);
        assert!(p.columns.iter().any(|c| c.name == "year"));
        assert!(p.columns.iter().any(|c| c.name == "filename"));

        // SQL is still refused by name on a dataset.
        let err = execute(&src, "SELECT * FROM dataset").unwrap_err().to_string();
        assert!(err.contains("not a query engine"), "{err}");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_dataset_exports_through_the_view() {
        let root = fixture("export");
        let d = open_dataset(&root).unwrap();

        let out = root.join("out.csv");
        let written = export_dataset_to_file(&d, &out, "csv").unwrap();
        assert_eq!(written, 150);
        let body = std::fs::read_to_string(&out).unwrap();
        assert_eq!(body.lines().count(), 151); // header + 150 rows
        assert!(body.contains("year"), "partition columns export too: {}", body.lines().next().unwrap_or(""));

        let out = root.join("out.ndjson");
        let written = export_dataset_to_file(&d, &out, "json").unwrap();
        assert_eq!(written, 150);
        let lines: Vec<serde_json::Value> = std::fs::read_to_string(&out)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines.len(), 150);
        assert!(lines.iter().all(|o| o.get("filename").is_some()));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_empty_directory_and_an_over_cap_walk_are_clean_errors() {
        let empty = root("empty");
        let err = open_dataset(&empty).unwrap_err().to_string();
        assert!(err.contains("no Parquet files"), "{err}");
        let _ = std::fs::remove_dir_all(&empty);

        // The cap is named in the error (walked with a small cap — the real
        // 10 000 stays for production, the mechanism is what is tested).
        let full = fixture("capped");
        let err = walk_parquet_files(&full, 2).unwrap_err().to_string();
        assert!(err.contains("2") && err.contains("dataset cap"), "{err}");
        let _ = std::fs::remove_dir_all(&full);
    }

    #[test]
    fn a_corrupt_member_names_itself() {
        let root = root("corrupt");
        write_part(&root.join("year=2024/good.parquet"), 0..10, false);
        std::fs::write(root.join("bad.parquet"), b"not a parquet file at all").unwrap();
        let err = open_dataset(&root).unwrap_err().to_string();
        assert!(err.contains("bad.parquet"), "{err}");
        let _ = std::fs::remove_dir_all(&root);
    }
}
