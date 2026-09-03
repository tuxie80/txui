//! Conformance: the Rust verb registry against the TypeScript one.
//!
//! TxShell has two implementations — the GUI's, in `src/utils/txShellGrammar.ts`,
//! and the headless one in `src-tauri/src/txshell.rs`. Two parsers for one
//! language drift, and the drift is silent: a verb added to the GUI simply does
//! not exist in a cron job, and the person who finds out is the one whose
//! scheduled report failed at 3am.
//!
//! The alternative — generating one from the other, or sharing a WASM core —
//! buys correctness at the price of a build step that has to work on every
//! machine that compiles this app. That trade is not worth it for a registry of
//! a dozen entries.
//!
//! So instead: assert. This test parses the TypeScript registry as text and
//! requires every verb in it to be either implemented in Rust or listed in
//! `UNSUPPORTED` **with a reason**. Adding `pivot` to the GUI turns
//! `cargo test` red until somebody decides whether a cron job should have it.
//! That decision is the thing that would otherwise be forgotten.

use std::path::PathBuf;

use app_lib::txshell::{find_verb, unsupported_reason, PIPE, UNSUPPORTED, VERBS};

fn grammar_source() -> String {
    // CARGO_MANIFEST_DIR is src-tauri; the frontend is its sibling.
    let path: PathBuf = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri has a parent")
        .join("src/utils/txShellGrammar.ts");
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()))
}

/// Every `{ name: 'x', kind: '…'` entry in the TypeScript VERBS array.
///
/// Text parsing rather than a JSON export: the alternative is a build step that
/// writes a manifest, and a build step that can be skipped is a check that can
/// be skipped.
fn ts_verbs(src: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for line in src.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("{ name: '") else { continue };
        let Some((name, rest)) = rest.split_once('\'') else { continue };
        let Some(kind_at) = rest.find("kind: '") else { continue };
        let kind_rest = &rest[kind_at + "kind: '".len()..];
        let Some((kind, _)) = kind_rest.split_once('\'') else { continue };
        out.push((name.to_string(), kind.to_string()));
    }
    out
}

#[test]
fn the_typescript_registry_is_actually_readable() {
    // If the parse silently returned nothing, every assertion below would pass
    // vacuously and this file would be decoration.
    let verbs = ts_verbs(&grammar_source());
    assert!(
        verbs.len() >= 10,
        "parsed only {} verbs from txShellGrammar.ts — the format changed and this \
         test stopped checking anything",
        verbs.len()
    );
    assert!(verbs.iter().any(|(n, _)| n == "where"));
    assert!(verbs.iter().any(|(n, _)| n == "chart"));
}

#[test]
fn every_gui_verb_is_implemented_or_excused() {
    let missing: Vec<String> = ts_verbs(&grammar_source())
        .into_iter()
        .map(|(name, _)| name)
        .filter(|n| find_verb(n).is_none() && unsupported_reason(n).is_none())
        .collect();
    assert!(
        missing.is_empty(),
        "these verbs exist in src/utils/txShellGrammar.ts but not in \
         src-tauri/src/txshell.rs: {missing:?}\n\n\
         Implement them for headless use, or add them to UNSUPPORTED with the \
         reason a cron job should not have them.",
    );
}

#[test]
fn no_rust_verb_is_invented_out_of_thin_air() {
    // Drift runs both ways. A verb that works in cron and not in the GUI is the
    // same bug seen from the other side.
    let ts = ts_verbs(&grammar_source());
    let extra: Vec<&str> = VERBS
        .iter()
        .map(|v| v.name)
        .filter(|n| !ts.iter().any(|(t, _)| t == n))
        .collect();
    assert!(extra.is_empty(), "headless-only verbs with no GUI equivalent: {extra:?}");
}

#[test]
fn the_kinds_agree() {
    // A verb that is a stage in one and a sink in the other would parse the
    // same and behave differently — the worst kind of drift.
    for (name, kind) in ts_verbs(&grammar_source()) {
        let Some(spec) = find_verb(&name) else { continue };
        let ours = format!("{:?}", spec.kind).to_lowercase();
        assert_eq!(ours, kind, "`{name}` is a {kind} in the GUI but a {ours} here");
    }
}

#[test]
fn the_arities_agree() {
    // Different arity means one side accepts a line the other rejects, so a
    // pipeline tested in the GUI can still fail in cron.
    let src = grammar_source();
    for spec in VERBS {
        let (min, max) = ts_arity(&src, spec.name)
            .unwrap_or_else(|| panic!("no minArgs/maxArgs found for `{}`", spec.name));
        assert_eq!(spec.min_args, min, "`{}` minArgs", spec.name);
        assert_eq!(spec.max_args, max, "`{}` maxArgs", spec.name);
    }
}

/// `minArgs: N, maxArgs: M | null` for one verb in the TypeScript source.
fn ts_arity(src: &str, verb: &str) -> Option<(usize, Option<usize>)> {
    let needle = format!("{{ name: '{verb}',");
    let start = src.find(&needle)?;
    // The entry runs to the next `{ name:` or the end of the array.
    let rest = &src[start..];
    let end = rest[1..].find("{ name: '").map(|i| i + 1).unwrap_or(rest.len());
    let entry = &rest[..end];
    let min_at = entry.find("minArgs:")? + "minArgs:".len();
    let min: usize = entry[min_at..]
        .trim_start()
        .split(|c: char| !c.is_ascii_digit())
        .next()?
        .parse()
        .ok()?;
    let max_at = entry.find("maxArgs:")? + "maxArgs:".len();
    let max_tok = entry[max_at..].trim_start();
    let max = if max_tok.starts_with("null") {
        None
    } else {
        Some(
            max_tok
                .split(|c: char| !c.is_ascii_digit())
                .next()?
                .parse()
                .ok()?,
        )
    };
    Some((min, max))
}

#[test]
fn the_pipe_operator_is_the_same_string() {
    // Everything about the grammar rests on `|>` being unrepresentable in SQL.
    // If one side ever changed it, lines would parse differently on each.
    let src = grammar_source();
    assert!(
        src.contains(&format!("export const PIPE = '{PIPE}'")),
        "PIPE disagrees between txshell.rs ({PIPE}) and txShellGrammar.ts"
    );
}

#[test]
fn every_exclusion_carries_a_real_reason() {
    // An empty reason turns UNSUPPORTED into a way to silence this test.
    for (name, reason) in UNSUPPORTED {
        assert!(
            reason.len() > 30,
            "`{name}` is excluded from headless use without saying why"
        );
    }
}

#[test]
fn nothing_is_both_implemented_and_excused() {
    for (name, _) in UNSUPPORTED {
        assert!(
            find_verb(name).is_none(),
            "`{name}` is listed as unsupported but also implemented"
        );
    }
}
