//! Reading and writing a `.sql` file as a *file*: with an encoding, a line
//! ending and an identity on disk.
//!
//! The editor could already open and save text, but only as UTF-8 with
//! whatever newlines happened to be in it, and it forgot the path immediately.
//! That is fine for a scratch buffer and wrong for a file somebody keeps.
//!
//! Three things live here, all of which a text editor is expected to know and
//! none of which `read_to_string` can tell you:
//!
//! * **What encoding is this?** A dump written by a Windows tool is very often
//!   CP1250 or Latin-1. `read_to_string` rejects it outright (invalid UTF-8),
//!   which reads to the user as "the file is broken".
//! * **What line endings does it use?** Saving CRLF content back as LF turns a
//!   one-line fix into a whole-file diff.
//! * **Has it changed since I read it?** So a save cannot silently clobber
//!   someone else's edit.
//!
//! Pure functions are separated from the I/O so the interesting parts are
//! testable without touching a disk.

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Text encodings offered in the UI.
///
/// A short list on purpose. `encoding_rs` implements every WHATWG label, but a
/// menu of forty is not a choice — these are the ones a SQL dump is actually
/// written in, plus whatever the detector guesses.
pub const ENCODINGS: &[&str] = &[
    "UTF-8", "UTF-8-BOM", "UTF-16LE", "UTF-16BE", "windows-1250", "windows-1252", "ISO-8859-2",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Eol {
    Lf,
    Crlf,
    /// Classic Mac. Vanishingly rare, but a file that has them must not be
    /// silently rewritten.
    Cr,
    /// A file with no line break at all, or a mixture. Saving leaves it alone.
    Mixed,
}

#[derive(Debug, Serialize)]
pub struct OpenedFile {
    pub text: String,
    /// The label actually used to decode, which is what the status bar shows.
    pub encoding: String,
    /// True when the encoding was guessed rather than declared by a BOM.
    pub detected: bool,
    pub eol: Eol,
    pub size: u64,
    /// Modified time, ms since the epoch — the value change detection compares.
    pub mtime_ms: i64,
    /// Set when the file has characters the chosen encoding could not represent
    /// and were replaced. Saving over the original would lose them.
    pub lossy: bool,
}

#[derive(Debug, Serialize)]
pub struct FileStat {
    pub size: u64,
    pub mtime_ms: i64,
}

/// Which line ending dominates.
///
/// Counts rather than first-match: a file that is mostly CRLF with one stray LF
/// is a CRLF file, and calling it mixed would make every save rewrite it.
/// Genuinely mixed only when two kinds are both common.
pub fn detect_eol(text: &str) -> Eol {
    let bytes = text.as_bytes();
    let mut crlf = 0usize;
    let mut lf = 0usize;
    let mut cr = 0usize;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\r' => {
                if bytes.get(i + 1) == Some(&b'\n') { crlf += 1; i += 2; continue; }
                cr += 1;
            }
            b'\n' => lf += 1,
            _ => {}
        }
        i += 1;
    }
    let total = crlf + lf + cr;
    if total == 0 {
        return Eol::Lf;    // nothing to preserve; the platform default applies
    }
    let (top, count) = [(Eol::Crlf, crlf), (Eol::Lf, lf), (Eol::Cr, cr)]
        .into_iter()
        .max_by_key(|&(_, n)| n)
        .unwrap();
    // A clear majority is that ending; anything closer is a mixed file and is
    // left exactly as it is.
    if count * 10 >= total * 9 { top } else { Eol::Mixed }
}

/// Rewrite every line break as `eol`. `Mixed` leaves the text untouched — the
/// point of detecting it is to *not* normalise a file nobody asked us to.
pub fn normalize_eol(text: &str, eol: Eol) -> String {
    let target = match eol {
        Eol::Lf => "\n",
        Eol::Crlf => "\r\n",
        Eol::Cr => "\r",
        Eol::Mixed => return text.to_string(),
    };
    // Normalise to LF first so CRLF is never split into two breaks.
    let lf = text.replace("\r\n", "\n").replace('\r', "\n");
    if target == "\n" { lf } else { lf.replace('\n', target) }
}

/// The encoding label for a byte-order mark, if there is one.
fn bom_label(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) { return Some("UTF-8-BOM"); }
    if bytes.starts_with(&[0xFF, 0xFE]) { return Some("UTF-16LE"); }
    if bytes.starts_with(&[0xFE, 0xFF]) { return Some("UTF-16BE"); }
    None
}

/// Decode bytes with an explicit label, or work out the label first.
///
/// Order matters and is the whole design: a **BOM is a declaration** and beats
/// everything; valid UTF-8 is taken at face value, because guessing on a file
/// that is already unambiguous is how a detector introduces a bug; only then
/// does the detector run.
pub fn decode(bytes: &[u8], forced: Option<&str>) -> Result<(String, String, bool, bool)> {
    if let Some(label) = forced {
        let (text, lossy) = decode_with(bytes, label)?;
        return Ok((text, label.to_string(), false, lossy));
    }
    if let Some(label) = bom_label(bytes) {
        let (text, lossy) = decode_with(bytes, label)?;
        return Ok((text, label.to_string(), false, lossy));
    }
    if let Ok(s) = std::str::from_utf8(bytes) {
        return Ok((s.to_string(), "UTF-8".to_string(), false, false));
    }
    // Not UTF-8 — ask the detector Firefox uses.
    let mut det = chardetng::EncodingDetector::new();
    det.feed(bytes, true);
    let enc = det.guess(None, true);
    let (text, _, lossy) = enc.decode(bytes);
    Ok((text.into_owned(), enc.name().to_string(), true, lossy))
}

fn decode_with(bytes: &[u8], label: &str) -> Result<(String, bool)> {
    match label {
        "UTF-8-BOM" => {
            let body = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
            let (text, _, lossy) = encoding_rs::UTF_8.decode(body);
            Ok((text.into_owned(), lossy))
        }
        _ => {
            let enc = encoding_rs::Encoding::for_label(label.as_bytes())
                .ok_or_else(|| anyhow::anyhow!("unknown encoding `{label}`"))?;
            let (text, _, lossy) = enc.decode(bytes);
            Ok((text.into_owned(), lossy))
        }
    }
}

/// Encode text for writing. Returns the bytes, including a BOM when the label
/// asks for one.
pub fn encode(text: &str, label: &str) -> Result<Vec<u8>> {
    if label == "UTF-8-BOM" {
        let mut out = vec![0xEF, 0xBB, 0xBF];
        out.extend_from_slice(text.as_bytes());
        return Ok(out);
    }
    let enc = encoding_rs::Encoding::for_label(label.as_bytes())
        .ok_or_else(|| anyhow::anyhow!("unknown encoding `{label}`"))?;
    // UTF-16 has no encoder in encoding_rs (by WHATWG rule, output is always
    // UTF-8 for those labels), so it is done by hand rather than silently
    // written as something else.
    if enc == encoding_rs::UTF_16LE || enc == encoding_rs::UTF_16BE {
        let be = enc == encoding_rs::UTF_16BE;
        let mut out: Vec<u8> = if be { vec![0xFE, 0xFF] } else { vec![0xFF, 0xFE] };
        for unit in text.encode_utf16() {
            let b = if be { unit.to_be_bytes() } else { unit.to_le_bytes() };
            out.extend_from_slice(&b);
        }
        return Ok(out);
    }
    let (bytes, _, lossy) = enc.encode(text);
    if lossy {
        bail!("this text has characters {label} cannot represent — save as UTF-8 to keep them");
    }
    Ok(bytes.into_owned())
}

fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Ceiling on what the editor will load.
///
/// CodeMirror holds a document in memory and renders from it; a 200 MB dump
/// does not open, it hangs the window. Refusing with a number in the message is
/// the honest outcome — see the error text, which says how big the file is
/// rather than just "too large".
pub const MAX_EDITABLE_BYTES: u64 = 32 * 1024 * 1024;

pub async fn open(path: &Path, forced: Option<&str>) -> Result<OpenedFile> {
    let meta = tokio::fs::metadata(path).await
        .map_err(|e| anyhow::anyhow!("could not open {}: {e}", path.display()))?;
    if meta.len() > MAX_EDITABLE_BYTES {
        bail!(
            "{} is {:.1} MB — larger than the {} MB the editor can hold. \
             Open it with a tool built for large files, or split it.",
            path.display(),
            meta.len() as f64 / (1024.0 * 1024.0),
            MAX_EDITABLE_BYTES / (1024 * 1024),
        );
    }
    let bytes = tokio::fs::read(path).await
        .map_err(|e| anyhow::anyhow!("could not read {}: {e}", path.display()))?;
    let (text, encoding, detected, lossy) = decode(&bytes, forced)?;
    let eol = detect_eol(&text);
    Ok(OpenedFile {
        // The editor works in LF and converts back on save; carrying CRLF
        // through CodeMirror makes every column offset wrong by one.
        text: text.replace("\r\n", "\n").replace('\r', "\n"),
        encoding, detected, eol,
        size: meta.len(),
        mtime_ms: mtime_ms(&meta),
        lossy,
    })
}

/// Save the buffer to `path` — atomically, and refusing to clobber.
///
/// * **Atomic** (WP-13 13.1): temp file in the SAME directory, `sync_all`,
///   then rename — the pattern vaultfile.rs/instancedata.rs already use. The
///   old bare `tokio::fs::write` meant a crash mid-save truncated the user's
///   only copy.
/// * **Clobber guard**: when the caller supplies the mtime it loaded the file
///   at, a NEWER on-disk mtime (a concurrent external edit) refuses with a
///   distinct error so the UI can prompt instead of silently overwriting.
///   `None` / `0` skips the check (save-as, force-overwrite).
pub async fn save(
    path: &Path,
    text: &str,
    encoding: &str,
    eol: Eol,
    expected_mtime_ms: Option<i64>,
) -> Result<FileStat> {
    if let Some(expected) = expected_mtime_ms.filter(|&m| m > 0) {
        if let Ok(meta) = tokio::fs::metadata(path).await {
            let on_disk = mtime_ms(&meta);
            if on_disk > expected {
                bail!(
                    "{} changed on disk since it was loaded — an external edit \
                     would be overwritten. Reload the file, or save again to overwrite.",
                    path.display()
                );
            }
        }
    }
    let out = encode(&normalize_eol(text, eol), encoding)?;
    let dir = path.parent().filter(|d| !d.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let base = path.file_name().and_then(|n| n.to_str()).unwrap_or("file.sql");
    let tmp = dir.join(format!(".{base}.txui-tmp-{}", std::process::id()));
    let write_result: std::io::Result<()> = async {
        use tokio::io::AsyncWriteExt;
        let mut f = tokio::fs::File::create(&tmp).await?;
        f.write_all(&out).await?;
        // Data on the platter before the rename makes it the file's identity.
        f.sync_all().await?;
        drop(f);
        tokio::fs::rename(&tmp, path).await?;
        Ok(())
    }
    .await;
    if write_result.is_err() {
        let _ = tokio::fs::remove_file(&tmp).await;
    }
    write_result.map_err(|e| anyhow::anyhow!("could not write {}: {e}", path.display()))?;
    let meta = tokio::fs::metadata(path).await?;
    Ok(FileStat { size: meta.len(), mtime_ms: mtime_ms(&meta) })
}

pub async fn stat(path: &Path) -> Result<Option<FileStat>> {
    match tokio::fs::metadata(path).await {
        Ok(meta) => Ok(Some(FileStat { size: meta.len(), mtime_ms: mtime_ms(&meta) })),
        // Deleted or renamed under us. Not an error — the caller wants to know.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Line endings ────────────────────────────────────────────────────────

    #[test]
    fn a_pure_file_reports_its_own_ending() {
        assert_eq!(detect_eol("a\nb\nc"), Eol::Lf);
        assert_eq!(detect_eol("a\r\nb\r\nc"), Eol::Crlf);
        assert_eq!(detect_eol("a\rb\rc"), Eol::Cr);
    }

    /// CRLF is `\r` followed by `\n`; counting naively finds both and calls a
    /// clean Windows file mixed.
    #[test]
    fn crlf_is_not_counted_as_a_cr_and_an_lf() {
        assert_eq!(detect_eol("a\r\nb\r\n"), Eol::Crlf);
    }

    /// One stray ending in a large file is a typo, not a mixed file. Calling it
    /// mixed would make every save rewrite the whole thing.
    #[test]
    fn one_stray_ending_does_not_make_a_file_mixed() {
        let mut s = "line\r\n".repeat(50);
        s.push_str("odd\n");
        assert_eq!(detect_eol(&s), Eol::Crlf);
    }

    #[test]
    fn a_genuinely_mixed_file_is_reported_as_mixed() {
        let s = "a\r\nb\nc\r\nd\ne\r\nf\n";
        assert_eq!(detect_eol(s), Eol::Mixed);
    }

    #[test]
    fn a_file_with_no_line_break_defaults_to_lf() {
        assert_eq!(detect_eol("SELECT 1;"), Eol::Lf);
        assert_eq!(detect_eol(""), Eol::Lf);
    }

    #[test]
    fn normalising_converts_every_kind() {
        assert_eq!(normalize_eol("a\r\nb\nc\rd", Eol::Lf), "a\nb\nc\nd");
        assert_eq!(normalize_eol("a\nb", Eol::Crlf), "a\r\nb");
        assert_eq!(normalize_eol("a\r\nb", Eol::Cr), "a\rb");
    }

    /// The point of detecting Mixed is to leave such a file alone.
    #[test]
    fn normalising_to_mixed_changes_nothing() {
        let s = "a\r\nb\nc";
        assert_eq!(normalize_eol(s, Eol::Mixed), s);
    }

    #[test]
    fn converting_to_crlf_twice_does_not_double_up() {
        let once = normalize_eol("a\nb", Eol::Crlf);
        assert_eq!(normalize_eol(&once, Eol::Crlf), "a\r\nb");
    }

    // ── Encoding ────────────────────────────────────────────────────────────

    #[test]
    fn plain_utf8_is_taken_at_face_value() {
        let (text, label, detected, lossy) = decode("SELECT 'ěščř';".as_bytes(), None).unwrap();
        assert_eq!(text, "SELECT 'ěščř';");
        assert_eq!(label, "UTF-8");
        assert!(!detected, "unambiguous UTF-8 must not be guessed at");
        assert!(!lossy);
    }

    /// A BOM is a declaration and outranks both UTF-8 validity and the guesser.
    #[test]
    fn a_bom_is_believed_and_stripped() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice("SELECT 1;".as_bytes());
        let (text, label, detected, _) = decode(&bytes, None).unwrap();
        assert_eq!(text, "SELECT 1;", "the BOM leaked into the text");
        assert_eq!(label, "UTF-8-BOM");
        assert!(!detected);
    }

    /// The case that motivated all of this: a Windows-written Czech dump.
    #[test]
    fn a_cp1250_dump_is_detected_rather_than_rejected() {
        let (bytes, _, _) = encoding_rs::WINDOWS_1250.encode("INSERT INTO t VALUES ('Příliš žluťoučký kůň');");
        assert!(std::str::from_utf8(&bytes).is_err(), "fixture is not actually non-UTF-8");
        let (text, label, detected, _) = decode(&bytes, None).unwrap();
        assert!(detected, "a non-UTF-8 file must be detected, not rejected");
        assert!(text.contains("Příliš"), "decoded as {label}: {text}");
    }

    /// Detection is a guess and the user overrules it.
    #[test]
    fn an_explicit_label_wins_over_detection() {
        let (bytes, _, _) = encoding_rs::WINDOWS_1250.encode("žluťoučký");
        let (text, label, detected, _) = decode(&bytes, Some("windows-1250")).unwrap();
        assert_eq!(text, "žluťoučký");
        assert_eq!(label, "windows-1250");
        assert!(!detected, "an explicit choice is not a detection");
    }

    #[test]
    fn an_unknown_label_is_an_error_not_a_silent_fallback() {
        assert!(decode(b"x", Some("klingon-1")).is_err());
        assert!(encode("x", "klingon-1").is_err());
    }

    #[test]
    fn utf8_round_trips_through_encode() {
        let t = "SELECT 'ěščř';";
        assert_eq!(decode(&encode(t, "UTF-8").unwrap(), Some("UTF-8")).unwrap().0, t);
    }

    #[test]
    fn a_bom_is_written_when_asked_for() {
        let out = encode("x", "UTF-8-BOM").unwrap();
        assert_eq!(&out[..3], &[0xEF, 0xBB, 0xBF]);
        assert_eq!(decode(&out, None).unwrap().0, "x");
    }

    /// `encoding_rs` refuses to *encode* UTF-16 by WHATWG rule, so this is
    /// hand-rolled — and therefore worth a round-trip test.
    #[test]
    fn utf16_round_trips_in_both_byte_orders() {
        for label in ["UTF-16LE", "UTF-16BE"] {
            let out = encode("SELECT 'ěš';", label).unwrap();
            let (text, got, _, _) = decode(&out, None).unwrap();
            assert_eq!(text, "SELECT 'ěš';", "{label}");
            assert_eq!(got, label, "the BOM should identify it");
        }
    }

    /// Saving Czech text as Latin-1 would drop the diacritics. Losing a
    /// character on save is worse than refusing, so it refuses and says why.
    #[test]
    fn encoding_that_would_lose_characters_refuses() {
        let err = encode("žluťoučký", "ISO-8859-1").unwrap_err().to_string();
        assert!(err.contains("cannot represent"), "unhelpful: {err}");
        assert!(err.contains("UTF-8"), "must say what to do instead: {err}");
    }

    #[test]
    fn every_offered_encoding_can_be_resolved() {
        for label in ENCODINGS {
            assert!(
                *label == "UTF-8-BOM" || encoding_rs::Encoding::for_label(label.as_bytes()).is_some(),
                "the UI offers `{label}` and nothing can decode it",
            );
        }
    }
    // ── WP-13 13.1: atomic save + clobber guard ─────────────────────────────

    #[tokio::test]
    async fn save_is_atomic_and_leaves_no_temp_file() {
        let dir = std::env::temp_dir().join(format!("txui-sqlfile-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("a.sql");
        let stat = save(&p, "SELECT 1;\n", "UTF-8", Eol::Lf, None).await.unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "SELECT 1;\n");
        assert!(stat.mtime_ms > 0);
        let leftovers: Vec<_> = std::fs::read_dir(&dir).unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains("txui-tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp file lingered: {leftovers:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_newer_file_on_disk_refuses_the_save() {
        let dir = std::env::temp_dir().join(format!("txui-sqlfile-stale-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("b.sql");
        let stat = save(&p, "v1", "UTF-8", Eol::Lf, None).await.unwrap();
        // Simulate an external edit AFTER our load: bump mtime forward.
        let newer = std::time::SystemTime::UNIX_EPOCH
            + std::time::Duration::from_millis(stat.mtime_ms as u64 + 5_000);
        let f = std::fs::OpenOptions::new().write(true).open(&p).unwrap();
        f.set_modified(newer).unwrap();
        drop(f);
        let err = save(&p, "v2", "UTF-8", Eol::Lf, Some(stat.mtime_ms)).await
            .unwrap_err().to_string();
        assert!(err.contains("changed on disk"), "{err}");
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "v1", "the refusal must not write");
        // Force path (no expectation) still writes.
        save(&p, "v2", "UTF-8", Eol::Lf, None).await.unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "v2");
        let _ = std::fs::remove_dir_all(&dir);
    }

}
