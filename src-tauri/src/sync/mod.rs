//! Sync — the decision logic, in Rust.
//!
//! This mirrors `src/utils/sync*.ts`: the GUI runs the TypeScript, the backend
//! runs this. Two implementations of one set of rules is normally a mistake, so
//! the shape here is chosen to make divergence **fail a test** rather than be
//! discovered by a user whose copy was verified against the wrong rules.
//!
//! The TxShell precedent (`tests/txshell_conformance.rs`) asserts that a *verb
//! registry* matches by reading names out of the TypeScript source. That works
//! for a declarative list and would not work here: this logic is behavioural,
//! and matching function names would prove nothing about what they compute.
//!
//! So conformance is by **golden vectors** instead. `dev/gen_sync_vectors.mjs`
//! runs the TypeScript implementation over a fixed set of inputs and writes the
//! outputs to `tests/fixtures/sync_vectors.json`; `tests/sync_conformance.rs`
//! feeds the same inputs to this code and asserts the outputs are identical.
//! A behavioural difference — not merely a renamed function — is what fails.

pub mod compat;
pub mod ddl;
