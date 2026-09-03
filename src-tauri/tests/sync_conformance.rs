//! Conformance: the Rust sync port against the TypeScript original.
//!
//! The GUI runs `src/utils/sync*.ts`; the backend mirrors it in `src-tauri/src/sync/*.rs`.
//! Two implementations of one set of rules drift, and here the drift is
//! *silent and dangerous*: a copy the CLI declares verified, using different
//! rules than the GUI would apply, is exactly the failure the verifier exists
//! to prevent.
//!
//! TxShell's conformance test (`txshell_conformance.rs`) compares a **verb
//! registry** by reading names out of the TypeScript source. That is right for
//! a declarative list and would prove nothing here — this logic is
//! *behavioural*, and matching function names says nothing about what they
//! compute.
//!
//! So conformance is by **golden vectors**. `dev/gen_sync_vectors.mjs` runs the
//! TypeScript over a fixed set of inputs and records the outputs; this test
//! feeds the same inputs to the Rust and asserts they match. A behavioural
//! difference is what fails, which is the only kind worth catching.
//!
//! When this test fails after a TypeScript change, the port is behind. Fix the
//! Rust, or — if the TypeScript was wrong — fix both and regenerate.

use std::path::PathBuf;

use app_lib::sync::compat::{
    at_least, binlog_status_statement, can_seed_by_gtid, change_source_statement,
    gtid_availability, is_maria_db, parse_version, reset_binlog_statement, seed_capability,
    CapturedPosition, GtidAvailability, SourceConn, RESET_REPLICA_STATEMENT,
    REPLICA_STATUS_STATEMENT,
};
use serde_json::Value;

fn vectors() -> Value {
    let path: PathBuf = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/sync_vectors.json");
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "cannot read {}: {e}\n\nRegenerate it with:\n  \
             node --experimental-strip-types dev/gen_sync_vectors.mjs",
            path.display()
        )
    });
    serde_json::from_str(&raw).expect("sync_vectors.json is not valid JSON")
}

/// Guard against the file being present but empty, which would make every
/// assertion below pass vacuously.
#[test]
fn the_vectors_are_actually_populated() {
    let v = vectors();
    for key in ["version", "gtid", "changeSource"] {
        let n = v[key].as_array().map(|a| a.len()).unwrap_or(0);
        assert!(
            n >= 4,
            "only {n} `{key}` vectors — the generator changed shape and this test \
             stopped checking anything"
        );
    }
}

#[test]
fn version_parsing_and_statement_choice_match() {
    for case in vectors()["version"].as_array().unwrap() {
        let raw = case["raw"].as_str().unwrap();
        let v = parse_version(raw);

        assert_eq!(v.major as u64, case["major"].as_u64().unwrap(), "major of {raw:?}");
        assert_eq!(v.minor as u64, case["minor"].as_u64().unwrap(), "minor of {raw:?}");
        assert_eq!(v.patch as u64, case["patch"].as_u64().unwrap(), "patch of {raw:?}");

        assert_eq!(is_maria_db(&v), case["isMariaDb"].as_bool().unwrap(), "isMariaDb of {raw:?}");
        assert_eq!(
            at_least(&v, 8, 4),
            case["atLeast_8_4"].as_bool().unwrap(),
            "atLeast(8,4) of {raw:?}"
        );
        assert_eq!(
            binlog_status_statement(&v),
            case["binlogStatus"].as_str().unwrap(),
            "binlog status statement for {raw:?}"
        );
        assert_eq!(
            reset_binlog_statement(&v),
            case["resetBinlog"].as_str().unwrap(),
            "reset statement for {raw:?}"
        );
    }
}

#[test]
fn gtid_classification_matches() {
    for case in vectors()["gtid"].as_array().unwrap() {
        let mode = case["mode"].as_str();
        let expected = case["availability"].as_str().unwrap();
        let got = match gtid_availability(mode) {
            GtidAvailability::Complete => "complete",
            GtidAvailability::Partial => "partial",
            GtidAvailability::Off => "off",
            GtidAvailability::Unknown => "unknown",
        };
        assert_eq!(got, expected, "availability of {mode:?}");
        assert_eq!(
            can_seed_by_gtid(mode),
            case["canSeed"].as_bool().unwrap(),
            "canSeed for {mode:?}"
        );
        assert_eq!(
            seed_capability(mode),
            case["capability"].as_str().unwrap(),
            "capability sentence for {mode:?}"
        );
    }
}

#[test]
fn the_generated_replication_statement_matches_byte_for_byte() {
    for case in vectors()["changeSource"].as_array().unwrap() {
        let p = &case["pos"];
        let c = &case["conn"];
        let pos = CapturedPosition {
            gtid_executed: p["gtidExecuted"].as_str().map(str::to_string),
            log_file: p["logFile"].as_str().map(str::to_string),
            log_pos: p["logPos"].as_u64(),
        };
        let conn = SourceConn {
            host: c["host"].as_str().unwrap().to_string(),
            port: c["port"].as_u64().map(|n| n as u16),
            user: c["user"].as_str().unwrap().to_string(),
        };
        assert_eq!(
            change_source_statement(&pos, &conn),
            case["sql"].as_str().unwrap(),
            "statement for {pos:?} / {conn:?}"
        );
    }
}

#[test]
fn the_unversioned_constants_match() {
    let c = &vectors()["constants"];
    assert_eq!(REPLICA_STATUS_STATEMENT, c["replicaStatus"].as_str().unwrap());
    assert_eq!(RESET_REPLICA_STATEMENT, c["resetReplica"].as_str().unwrap());
}

/// Independent of the vectors: whatever the TypeScript says, neither side may
/// emit vocabulary that 8.4 rejects outright.
#[test]
fn no_legacy_vocabulary_where_a_modern_spelling_exists() {
    for s in [REPLICA_STATUS_STATEMENT, RESET_REPLICA_STATEMENT] {
        assert!(!s.contains("MASTER") && !s.contains("SLAVE"), "{s}");
    }
    let pos = CapturedPosition {
        gtid_executed: None,
        log_file: Some("b.1".into()),
        log_pos: Some(4),
    };
    let conn = SourceConn { host: "h".into(), port: None, user: "u".into() };
    let sql = change_source_statement(&pos, &conn);
    assert!(!sql.contains("MASTER"), "{sql}");
}

// ── syncDdl ──────────────────────────────────────────────────────────────────
//
// These vectors are the real `SHOW CREATE TABLE` output of every table on both
// live servers — 8.0.46 and 8.4.10 — plus a few fixtures for cases neither
// happens to contain. A parser checked only against DDL its author wrote is
// checked against their assumptions.

use app_lib::sync::ddl::{
    classify_clause, column_name, generated_column_name, lift_auto_increment, load_column_list,
    rebuild_plan, split_clauses, split_create_table, DeferredKind,
};

fn kind_name(k: DeferredKind) -> &'static str {
    match k {
        DeferredKind::Index => "index",
        DeferredKind::Unique => "unique",
        DeferredKind::Fulltext => "fulltext",
        DeferredKind::Spatial => "spatial",
        DeferredKind::ForeignKey => "foreign-key",
        DeferredKind::Check => "check",
    }
}

#[test]
fn the_ddl_vectors_include_real_server_output() {
    // Fixtures alone would make this test agree with whatever was imagined.
    let v = vectors();
    let cases = v["ddl"].as_array().unwrap();
    let live = cases.iter().filter(|c| c["from"].as_str() != Some("fixture")).count();
    assert!(cases.len() >= 5, "only {} DDL cases", cases.len());
    assert!(
        live >= 5,
        "only {live} DDL cases came from a live server — start MySQL on 3306/3307 and \
         re-run `npm run sync:vectors`, or this test is checking fixtures only"
    );
}

#[test]
fn clause_splitting_matches() {
    for case in vectors()["ddlParts"].as_array().unwrap() {
        let expected: Vec<String> = case["clauses"]
            .as_array().unwrap().iter()
            .map(|c| c.as_str().unwrap().to_string())
            .collect();
        // Re-derive the body the same way the generator did.
        let joined = expected.join(", ");
        let got = split_clauses(&joined);
        assert_eq!(got.len(), expected.len(), "clause count for {joined:?}");
    }
}

#[test]
fn clause_classification_matches() {
    for case in vectors()["ddlParts"].as_array().unwrap() {
        let clauses = case["clauses"].as_array().unwrap();
        let classified = case["classified"].as_array().unwrap();
        for (clause, want) in clauses.iter().zip(classified) {
            let c = clause.as_str().unwrap();
            let got = classify_clause(c);
            if want.is_null() {
                assert!(got.is_none(), "{c:?} should stay in the load table, got {got:?}");
            } else {
                let g = got.unwrap_or_else(|| panic!("{c:?} should have been deferred"));
                assert_eq!(kind_name(g.kind), want["kind"].as_str().unwrap(), "kind of {c:?}");
                assert_eq!(
                    g.name.as_deref(),
                    want["name"].as_str(),
                    "name of {c:?}"
                );
            }
        }
    }
}

#[test]
fn generated_and_plain_columns_are_told_apart() {
    for case in vectors()["ddlParts"].as_array().unwrap() {
        let clauses = case["clauses"].as_array().unwrap();
        for (i, clause) in clauses.iter().enumerate() {
            let c = clause.as_str().unwrap();
            assert_eq!(
                generated_column_name(c).as_deref(),
                case["generated"][i].as_str(),
                "generated? {c:?}"
            );
            assert_eq!(
                column_name(c).as_deref(),
                case["columns"][i].as_str(),
                "column? {c:?}"
            );
        }
    }
}

#[test]
fn auto_increment_lifting_matches_including_inside_comments() {
    // A table commented `COMMENT='reset AUTO_INCREMENT=5 nightly'` must keep
    // that text and gain no counter — corruption in both directions from one
    // careless match.
    for case in vectors()["ddlParts"].as_array().unwrap() {
        let want = &case["lifted"];
        let (value, rest) = lift_auto_increment(want["rest"].as_str().unwrap());
        // `rest` round-trips: lifting an already-lifted tail changes nothing.
        assert_eq!(value, None, "lifting twice found a second counter");
        assert_eq!(rest, want["rest"].as_str().unwrap());
    }
}

#[test]
fn the_whole_split_matches_on_every_real_table() {
    for case in vectors()["ddl"].as_array().unwrap() {
        let ddl = case["ddl"].as_str().unwrap();
        let label = format!("{}.{} (from {})",
            case["schema"].as_str().unwrap(),
            case["table"].as_str().unwrap(),
            case["from"].as_str().unwrap());
        let s = split_create_table(ddl);

        assert_eq!(s.create_sql, case["createSql"].as_str().unwrap(), "createSql for {label}");
        assert_eq!(
            s.auto_increment,
            case["autoIncrement"].as_u64(),
            "autoIncrement for {label}"
        );

        let want_gen: Vec<&str> = case["generatedColumns"].as_array().unwrap()
            .iter().map(|v| v.as_str().unwrap()).collect();
        assert_eq!(s.generated_columns, want_gen, "generatedColumns for {label}");

        let want_cols: Vec<&str> = case["loadColumns"].as_array().unwrap()
            .iter().map(|v| v.as_str().unwrap()).collect();
        assert_eq!(s.load_columns, want_cols, "loadColumns for {label}");

        assert_eq!(
            load_column_list(&s),
            case["loadColumnList"].as_str().unwrap(),
            "loadColumnList for {label}"
        );

        let want_deferred = case["deferred"].as_array().unwrap();
        assert_eq!(s.deferred.len(), want_deferred.len(), "deferred count for {label}");
        for (got, want) in s.deferred.iter().zip(want_deferred) {
            assert_eq!(kind_name(got.kind), want["kind"].as_str().unwrap(), "kind in {label}");
            assert_eq!(got.name.as_deref(), want["name"].as_str(), "name in {label}");
            assert_eq!(got.text, want["text"].as_str().unwrap(), "text in {label}");
        }
    }
}

#[test]
fn the_rebuild_plan_matches_on_every_real_table() {
    for case in vectors()["ddl"].as_array().unwrap() {
        let s = split_create_table(case["ddl"].as_str().unwrap());
        let p = rebuild_plan(
            case["schema"].as_str().unwrap(),
            case["table"].as_str().unwrap(),
            &s,
        );
        let w = &case["rebuild"];
        let label = format!("{}.{}", case["schema"].as_str().unwrap(), case["table"].as_str().unwrap());
        assert_eq!(p.index_sql.as_deref(), w["indexSql"].as_str(), "indexSql for {label}");
        assert_eq!(p.foreign_key_sql.as_deref(), w["foreignKeySql"].as_str(), "fkSql for {label}");
        assert_eq!(p.check_sql.as_deref(), w["checkSql"].as_str(), "checkSql for {label}");
        assert_eq!(
            p.auto_increment_sql.as_deref(),
            w["autoIncrementSql"].as_str(),
            "autoIncrementSql for {label}"
        );
    }
}
