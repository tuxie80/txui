//! Cross-column formulas for the data generator (plan-datagen-nextgen
//! Phase 4) — the bit-identical Rust twin of `src/utils/datagenFormula.ts`.
//!
//! A `formula` column carries an expression over EARLIER columns of the same
//! row (`price * qty`, `first_name || ' ' || last_name`). The parser is a
//! small recursive descent over a whitelisted grammar — no eval, no way to
//! reach anything outside the row — and evaluation is a post-pass over the
//! row `gen_row` just built (`apply_formulas`), which works because a formula
//! consumes NO draws from the seeded RNG: the stream, and every other
//! column's value, is identical with or without formula columns.
//!
//! Semantics are the TS module's, mirrored exactly (the tests pin the same
//! vectors against both): NULL propagates through operators and every
//! function except `coalesce`; `/` and `%` by zero are NULL; a type mismatch
//! (a non-numeric string in arithmetic, a boolean anywhere but coalesce) is a
//! defined per-cell NULL, never a panic or an abort of the run. `'10' + 1`
//! concatenates (a string on either side decides `+`), while `- * / %`
//! strict-parse numeric strings.

use std::collections::HashMap;

use super::datagen::{ColumnSpec, GenValue};

// ── AST ───────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
enum Node {
    Num(f64),
    Str(String),
    Col(String),
    Neg(Box<Node>),
    Bin(&'static str, Box<Node>, Box<Node>),
    Fn(String, Vec<Node>),
}

/// (min_args, max_args) — the whitelist is the TS FORMULA_FUNCTIONS set.
/// `sql: false` lives only on the TS side (the server emitter); here a name
/// either parses or it does not.
fn fn_arity(name: &str) -> Option<(usize, usize)> {
    Some(match name {
        "abs" => (1, 1),
        "round" => (1, 2),
        "floor" => (1, 1),
        "ceil" => (1, 1),
        "min" | "max" => (1, 32),
        "length" => (1, 1),
        "upper" | "lower" => (1, 1),
        "substr" => (2, 3),
        "coalesce" => (1, 32),
        "slugify" => (1, 1),
        _ => return None,
    })
}

/// Guards against pathological input, not real expressions (same as TS).
const MAX_SRC: usize = 2000;
const MAX_DEPTH: usize = 64;

// ── Parser ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Num(f64, usize),
    Str(String, usize),
    Ident(String, usize),
    QCol(String, usize),
    Op(&'static str, usize),
    End(usize),
}

impl Tok {
    fn pos(&self) -> usize {
        match self {
            Tok::Num(_, p) | Tok::Str(_, p) | Tok::Ident(_, p) | Tok::QCol(_, p)
            | Tok::Op(_, p) | Tok::End(p) => *p,
        }
    }
}

fn tokenize(src: &str) -> Result<Vec<Tok>, String> {
    let cs: Vec<char> = src.chars().collect();
    let mut toks = Vec::new();
    let mut i = 0;
    while i < cs.len() {
        let c = cs[i];
        if c == ' ' || c == '\t' || c == '\n' || c == '\r' {
            i += 1;
            continue;
        }
        if c.is_ascii_digit() || (c == '.' && cs.get(i + 1).is_some_and(|n| n.is_ascii_digit())) {
            let mut j = i;
            while j < cs.len() && (cs[j].is_ascii_digit() || cs[j] == '.') {
                j += 1;
            }
            let text: String = cs[i..j].iter().collect();
            if text.matches('.').count() > 1 {
                return Err(format!("malformed number '{text}' at position {}", i + 1));
            }
            match text.parse::<f64>() {
                Ok(n) if n.is_finite() => toks.push(Tok::Num(n, i)),
                _ => return Err(format!("malformed number '{text}' at position {}", i + 1)),
            }
            i = j;
            continue;
        }
        if c == '\'' || c == '"' {
            let quote = c;
            let mut j = i + 1;
            let mut s = String::new();
            loop {
                if j >= cs.len() {
                    return Err(format!(
                        "unterminated {} at position {}",
                        if quote == '\'' { "string literal" } else { "quoted column" },
                        i + 1
                    ));
                }
                if cs[j] == quote && cs.get(j + 1) == Some(&quote) {
                    s.push(quote);
                    j += 2;
                    continue;
                }
                if cs[j] == quote {
                    break;
                }
                s.push(cs[j]);
                j += 1;
            }
            if quote == '\'' {
                toks.push(Tok::Str(s, i));
            } else {
                if s.is_empty() {
                    return Err(format!("empty quoted column name at position {}", i + 1));
                }
                toks.push(Tok::QCol(s, i));
            }
            i = j + 1;
            continue;
        }
        if c.is_ascii_alphabetic() || c == '_' {
            let mut j = i;
            while j < cs.len() && (cs[j].is_ascii_alphanumeric() || cs[j] == '_') {
                j += 1;
            }
            toks.push(Tok::Ident(cs[i..j].iter().collect(), i));
            i = j;
            continue;
        }
        if c == '|' && cs.get(i + 1) == Some(&'|') {
            toks.push(Tok::Op("||", i));
            i += 2;
            continue;
        }
        let op = match c {
            '+' => Some("+"),
            '-' => Some("-"),
            '*' => Some("*"),
            '/' => Some("/"),
            '%' => Some("%"),
            '(' => Some("("),
            ')' => Some(")"),
            ',' => Some(","),
            _ => None,
        };
        match op {
            Some(o) => {
                toks.push(Tok::Op(o, i));
                i += 1;
            }
            None => return Err(format!("unexpected character '{c}' at position {}", i + 1)),
        }
    }
    toks.push(Tok::End(cs.len()));
    Ok(toks)
}

/// Parse `src` into an AST — the same grammar as `parseFormula` in
/// datagenFormula.ts, with the same error messages (the UI shows the TS
/// wording inline; preview/run errors come from here).
fn parse(src: &str) -> Result<Node, String> {
    if src.trim().is_empty() {
        return Err("the expression is empty".into());
    }
    if src.chars().count() > MAX_SRC {
        return Err(format!("the expression is longer than {MAX_SRC} characters"));
    }
    let toks = tokenize(src)?;
    let mut p = Parser { toks, at: 0 };
    let ast = p.expr(0)?;
    match p.peek() {
        Tok::End(_) => Ok(ast),
        t => Err(format!("unexpected trailing input at position {}", t.pos() + 1)),
    }
}

struct Parser {
    toks: Vec<Tok>,
    at: usize,
}

impl Parser {
    fn peek(&self) -> &Tok {
        &self.toks[self.at.min(self.toks.len() - 1)]
    }
    fn is_op(&self, op: &str) -> bool {
        matches!(self.peek(), Tok::Op(o, _) if *o == op)
    }

    fn expr(&mut self, depth: usize) -> Result<Node, String> {
        if depth > MAX_DEPTH {
            return Err(format!("the expression nests deeper than {MAX_DEPTH} levels"));
        }
        let mut a = self.add(depth)?;
        while self.is_op("||") {
            self.at += 1;
            let b = self.add(depth)?;
            a = Node::Bin("||", Box::new(a), Box::new(b));
        }
        Ok(a)
    }
    fn add(&mut self, depth: usize) -> Result<Node, String> {
        let mut a = self.mul(depth)?;
        loop {
            let op = if self.is_op("+") {
                "+"
            } else if self.is_op("-") {
                "-"
            } else {
                break;
            };
            self.at += 1;
            let b = self.mul(depth)?;
            a = Node::Bin(op, Box::new(a), Box::new(b));
        }
        Ok(a)
    }
    fn mul(&mut self, depth: usize) -> Result<Node, String> {
        let mut a = self.unary(depth)?;
        loop {
            let op = if self.is_op("*") {
                "*"
            } else if self.is_op("/") {
                "/"
            } else if self.is_op("%") {
                "%"
            } else {
                break;
            };
            self.at += 1;
            let b = self.unary(depth)?;
            a = Node::Bin(op, Box::new(a), Box::new(b));
        }
        Ok(a)
    }
    fn unary(&mut self, depth: usize) -> Result<Node, String> {
        if self.is_op("-") {
            self.at += 1;
            let a = self.unary(depth + 1)?;
            return Ok(Node::Neg(Box::new(a)));
        }
        if self.is_op("+") {
            // unary plus is a no-op
            self.at += 1;
            return self.unary(depth + 1);
        }
        self.primary(depth + 1)
    }
    fn primary(&mut self, depth: usize) -> Result<Node, String> {
        match self.peek().clone() {
            Tok::Num(v, _) => {
                self.at += 1;
                Ok(Node::Num(v))
            }
            Tok::Str(s, _) => {
                self.at += 1;
                Ok(Node::Str(s))
            }
            Tok::QCol(name, _) => {
                self.at += 1;
                Ok(Node::Col(name))
            }
            Tok::Ident(name, pos) => {
                self.at += 1;
                if self.is_op("(") {
                    let lname = name.to_lowercase();
                    let (min, max) = fn_arity(&lname)
                        .ok_or_else(|| format!("unknown function '{name}'"))?;
                    self.at += 1; // consume '('
                    let mut args = Vec::new();
                    if !self.is_op(")") {
                        loop {
                            args.push(self.expr(depth + 1)?);
                            if self.is_op(",") {
                                self.at += 1;
                                continue;
                            }
                            break;
                        }
                    }
                    if !self.is_op(")") {
                        let t = self.peek();
                        return Err(format!(
                            "expected ')' after {lname}()'s arguments at position {}",
                            t.pos() + 1
                        ));
                    }
                    self.at += 1;
                    if args.len() < min || args.len() > max {
                        return Err(if min == max {
                            format!("{lname}() takes exactly {min} argument{}", if min == 1 { "" } else { "s" })
                        } else {
                            format!("{lname}() takes {min}–{max} arguments")
                        });
                    }
                    Ok(Node::Fn(lname, args))
                } else {
                    let _ = pos;
                    Ok(Node::Col(name))
                }
            }
            Tok::Op("(", _) => {
                self.at += 1;
                let a = self.expr(depth + 1)?;
                if !self.is_op(")") {
                    let t = self.peek();
                    return Err(format!("expected ')' at position {}", t.pos() + 1));
                }
                self.at += 1;
                Ok(a)
            }
            Tok::End(_) => Err("unexpected end of expression".into()),
            t => {
                let (text, pos) = match &t {
                    Tok::Op(o, p) => (o.to_string(), *p),
                    Tok::Num(_, p) | Tok::Str(_, p) | Tok::Ident(_, p) | Tok::QCol(_, p)
                    | Tok::End(p) => (String::new(), *p),
                };
                Err(format!("unexpected '{text}' at position {}", pos + 1))
            }
        }
    }
}

/// Every column the expression references, in order of first mention.
fn referenced_columns(ast: &Node) -> Vec<String> {
    fn walk(n: &Node, out: &mut Vec<String>) {
        match n {
            Node::Col(name) => {
                if !out.contains(name) {
                    out.push(name.clone());
                }
            }
            Node::Neg(a) => walk(a, out),
            Node::Bin(_, a, b) => {
                walk(a, out);
                walk(b, out);
            }
            Node::Fn(_, args) => args.iter().for_each(|a| walk(a, out)),
            _ => {}
        }
    }
    let mut out = Vec::new();
    walk(ast, &mut out);
    out
}

// ── Value helpers (the TS twins — keep in lockstep) ──────────────────────────

/// A cell value as the evaluator sees it.
#[derive(Debug, Clone, PartialEq)]
enum FV {
    Null,
    Num(f64),
    Str(String),
    Bool(bool),
}

impl FV {
    fn from_gen(v: &GenValue) -> FV {
        match v {
            GenValue::Null => FV::Null,
            GenValue::Int(i) => FV::Num(*i as f64),
            GenValue::Float(f) => FV::Num(*f),
            GenValue::Bool(b) => FV::Bool(*b),
            GenValue::Str(s) => FV::Str(s.clone()),
        }
    }
    fn into_gen(self) -> GenValue {
        match self {
            FV::Null => GenValue::Null,
            // Float is the one numeric carrier with a faithful literal/json
            // form on every sink (3.0 writes as `3`, json_f64 emits `3`).
            FV::Num(f) => GenValue::Float(f),
            FV::Str(s) => GenValue::Str(s),
            FV::Bool(b) => GenValue::Bool(b),
        }
    }
}

/// JavaScript's `String(n)` for a finite f64 (`jsNumStr` in the TS module):
/// integral values print without a decimal point, everything else in shortest
/// round-trip form. (Beyond |1e21| the two tiers' exponential spellings
/// differ — a pathological formula result, not data.)
fn js_num_str(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() <= 9.007_199_254_740_992e15 {
        // Exact in an i64, so this is JS's integer spelling.
        return format!("{}", n as i64);
    }
    format!("{n}")
}

/// `Math.round` — half towards +∞. Rust's `f64::round` rounds half AWAY FROM
/// ZERO (`-2.5` → `-3` where JS gives `-2`), so the JS form is spelled out.
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// The STRICT string→number coercion for `- * / %` (`toNumStrict` in TS):
/// trim, optional sign, digits with optional fraction (or a bare fraction),
/// optional exponent — and nothing else. Rust's own `parse::<f64>` would
/// also accept 'inf'/'NaN', so the shape is checked first and a non-finite
/// result rejected — one defined behaviour on both tiers.
fn to_num_strict(v: &FV) -> Option<f64> {
    match v {
        FV::Num(x) => Some(*x),
        FV::Str(s) => {
            let s = s.trim();
            if !strict_num_shape(s) {
                return None;
            }
            match s.parse::<f64>() {
                Ok(n) if n.is_finite() => Some(n),
                _ => None,
            }
        }
        _ => None,
    }
}

/// The TS `STRICT_NUM_RE` shape, hand-scanned: `[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?`.
fn strict_num_shape(s: &str) -> bool {
    let cs: Vec<char> = s.chars().collect();
    let mut i = 0;
    if i < cs.len() && (cs[i] == '+' || cs[i] == '-') {
        i += 1;
    }
    let digits_before = i;
    while i < cs.len() && cs[i].is_ascii_digit() {
        i += 1;
    }
    let had_int_digits = i > digits_before;
    let mut had_frac_digits = false;
    if i < cs.len() && cs[i] == '.' {
        i += 1;
        let frac_start = i;
        while i < cs.len() && cs[i].is_ascii_digit() {
            i += 1;
        }
        had_frac_digits = i > frac_start;
    }
    // Need digits on at least one side of the point (and a bare "." is out).
    if !had_int_digits && !had_frac_digits {
        return false;
    }
    if i < cs.len() && (cs[i] == 'e' || cs[i] == 'E') {
        i += 1;
        if i < cs.len() && (cs[i] == '+' || cs[i] == '-') {
            i += 1;
        }
        let exp_start = i;
        while i < cs.len() && cs[i].is_ascii_digit() {
            i += 1;
        }
        if i == exp_start {
            return false;
        }
    }
    i == cs.len()
}

/// Stringify for `||`/concat: numbers in JS form, strings as-is; booleans are
/// a type error (None).
fn str_of(v: &FV) -> Option<String> {
    match v {
        FV::Str(s) => Some(s.clone()),
        FV::Num(n) => Some(js_num_str(*n)),
        _ => None,
    }
}

/// slugify: lowercase, runs of non-alphanumeric characters → '-', edges
/// trimmed. `char::is_alphanumeric` is Unicode-aware, matching the TS
/// `\p{L}\p{N}` class on the cases data actually contains.
fn slugify_value(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_run = false;
    for c in s.to_lowercase().chars() {
        if c.is_alphanumeric() {
            out.push(c);
            in_run = false;
        } else if !in_run && !out.is_empty() {
            out.push('-');
            in_run = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out
}

/// Code-point slice for substr: 1-based `start` (clamped ≥ 1), `len` clamped
/// ≥ 0 — the TS `substrValue`.
fn substr_value(s: &str, start: f64, len: Option<f64>) -> String {
    let chars: Vec<char> = s.chars().collect();
    let from = (start.trunc().max(1.0) as usize) - 1;
    match len {
        None => chars.iter().skip(from).collect(),
        Some(l) => {
            let n = l.trunc().max(0.0) as usize;
            chars.iter().skip(from).take(n).collect()
        }
    }
}

// ── Evaluator ─────────────────────────────────────────────────────────────────

/// Err(()) is the internal type-error sentinel — `eval` maps it to NULL at the
/// top, so a bad cell never aborts a run.
fn eval_node(n: &Node, get: &dyn Fn(&str) -> Option<FV>) -> Result<FV, ()> {
    match n {
        Node::Num(v) => Ok(FV::Num(*v)),
        Node::Str(s) => Ok(FV::Str(s.clone())),
        Node::Col(name) => get(name).ok_or(()),
        Node::Neg(a) => {
            let a = eval_node(a, get)?;
            if a == FV::Null {
                return Ok(FV::Null);
            }
            to_num_strict(&a).map(|x| FV::Num(-x)).ok_or(())
        }
        Node::Bin(op, an, bn) => {
            let a = eval_node(an, get)?;
            let b = eval_node(bn, get)?;
            if a == FV::Null || b == FV::Null {
                return Ok(FV::Null);
            }
            if *op == "||" {
                let sa = str_of(&a).ok_or(())?;
                let sb = str_of(&b).ok_or(())?;
                return Ok(FV::Str(sa + &sb));
            }
            if *op == "+" {
                // Numbers add; a string on either side concatenates.
                if let (FV::Num(x), FV::Num(y)) = (&a, &b) {
                    return Ok(FV::Num(x + y));
                }
                let sa = str_of(&a).ok_or(())?;
                let sb = str_of(&b).ok_or(())?;
                return Ok(FV::Str(sa + &sb));
            }
            let x = to_num_strict(&a).ok_or(())?;
            let y = to_num_strict(&b).ok_or(())?;
            // `/` and `%` by zero are NULL (the SQL form emits NULLIF), never
            // an inf/NaN that would escape as a literal.
            if y == 0.0 {
                return Ok(FV::Null);
            }
            Ok(FV::Num(match *op {
                "-" => x - y,
                "*" => x * y,
                "/" => x / y,
                "%" => x % y,
                _ => unreachable!(),
            }))
        }
        Node::Fn(name, arg_nodes) => {
            let mut args = Vec::with_capacity(arg_nodes.len());
            for an in arg_nodes {
                args.push(eval_node(an, get)?);
            }
            apply_fn(name, &args)
        }
    }
}

/// num arg: Null propagates as None-or-null; a type error is Err. Mirrors
/// `numArg` in the TS module.
fn num_arg(v: &FV) -> Result<Option<f64>, ()> {
    if *v == FV::Null {
        return Ok(None);
    }
    to_num_strict(v).map(Some).ok_or(())
}

fn str_arg(v: &FV) -> Result<Option<String>, ()> {
    if *v == FV::Null {
        return Ok(None);
    }
    str_of(v).map(Some).ok_or(())
}

fn apply_fn(name: &str, args: &[FV]) -> Result<FV, ()> {
    match name {
        "abs" => match num_arg(&args[0])? {
            None => Ok(FV::Null),
            Some(x) => Ok(FV::Num(x.abs())),
        },
        "round" => {
            let x = match num_arg(&args[0])? {
                None => return Ok(FV::Null),
                Some(x) => x,
            };
            let d = if args.len() > 1 {
                match num_arg(&args[1])? {
                    None => return Ok(FV::Null),
                    Some(d) => d,
                }
            } else {
                0.0
            };
            let f = 10f64.powi(d.trunc().clamp(0.0, 12.0) as i32);
            Ok(FV::Num(js_round(x * f) / f))
        }
        "floor" | "ceil" => match num_arg(&args[0])? {
            None => Ok(FV::Null),
            Some(x) => Ok(FV::Num(if name == "floor" { x.floor() } else { x.ceil() })),
        },
        "min" | "max" => {
            let mut acc = if name == "min" { f64::INFINITY } else { f64::NEG_INFINITY };
            for v in args {
                match num_arg(v)? {
                    // NULL in → NULL out (MySQL LEAST semantics — the SQL
                    // emitter wraps PG/SQL Server's NULL-ignoring forms).
                    None => return Ok(FV::Null),
                    Some(x) => {
                        acc = if name == "min" { acc.min(x) } else { acc.max(x) };
                    }
                }
            }
            Ok(FV::Num(acc))
        }
        "length" => match str_arg(&args[0])? {
            None => Ok(FV::Null),
            // Code points, like the TS `[...s].length`.
            Some(s) => Ok(FV::Num(s.chars().count() as f64)),
        },
        "upper" | "lower" => match str_arg(&args[0])? {
            None => Ok(FV::Null),
            Some(s) => Ok(FV::Str(if name == "upper" {
                s.to_uppercase()
            } else {
                s.to_lowercase()
            })),
        },
        "substr" => {
            let s = match str_arg(&args[0])? {
                None => return Ok(FV::Null),
                Some(s) => s,
            };
            let start = match num_arg(&args[1])? {
                None => return Ok(FV::Null),
                Some(x) => x,
            };
            let len = if args.len() > 2 {
                match num_arg(&args[2])? {
                    None => return Ok(FV::Null),
                    Some(l) => Some(l),
                }
            } else {
                None
            };
            Ok(FV::Str(substr_value(&s, start, len)))
        }
        "coalesce" => Ok(args.iter().find(|v| **v != FV::Null).cloned().unwrap_or(FV::Null)),
        "slugify" => match str_arg(&args[0])? {
            None => Ok(FV::Null),
            Some(s) => Ok(FV::Str(slugify_value(&s))),
        },
        _ => Err(()), // unreachable: the parser whitelists names
    }
}

/// Evaluate a parsed formula over the row's earlier values. Any type error —
/// or an unknown column (None from `get`) — yields NULL, never a panic.
fn eval(ast: &Node, get: &dyn Fn(&str) -> Option<FV>) -> FV {
    eval_node(ast, get).unwrap_or(FV::Null)
}

// ── Row integration ───────────────────────────────────────────────────────────

// The AST is row-independent, so parses are memoized per expression string —
// the same content-keyed thread-local pattern as CHOICE_CACHE in datagen.rs.
thread_local! {
    static FORMULA_CACHE: std::cell::RefCell<HashMap<String, std::rc::Rc<Result<Node, String>>>> =
        std::cell::RefCell::new(HashMap::new());
}

fn parse_cached(src: &str) -> std::rc::Rc<Result<Node, String>> {
    FORMULA_CACHE.with_borrow_mut(|cache| {
        if let Some(v) = cache.get(src) {
            return v.clone();
        }
        let rc = std::rc::Rc::new(parse(src));
        cache.insert(src.to_string(), rc.clone());
        rc
    })
}

/// The placeholder `gen_value` emits for a formula column (the '<fk>'
/// precedent) — `apply_formulas` replaces exactly this, and only this, so a
/// nullPct-rolled NULL stands.
pub const FORMULA_PLACEHOLDER: &str = "<formula>";

/// The formula post-pass of `gen_row` — the twin of the post-pass in TS
/// `generateRows`. Left to right, so a formula can reference an EARLIER
/// formula column's computed value. A formula consumes no RNG draws, which is
/// why this can run after the row is built without perturbing the stream.
pub fn apply_formulas(specs: &[ColumnSpec], row: &mut [GenValue]) {
    for idx in 0..specs.len().min(row.len()) {
        let spec = &specs[idx];
        if spec.generator != "formula" {
            continue;
        }
        if !matches!(&row[idx], GenValue::Str(s) if s == FORMULA_PLACEHOLDER) {
            continue;
        }
        let parsed = parse_cached(spec.params.expr.as_deref().unwrap_or(""));
        let value = match &*parsed {
            Ok(ast) => eval(ast, &|name| {
                // Earlier columns only — the row builds left to right.
                (0..idx)
                    .find(|&j| specs[j].name == name)
                    .map(|j| FV::from_gen(&row[j]))
            }),
            // An invalid expression is a config error — surfaced by
            // validate_specs before preview/run; a stray unvalidated spec
            // degrades to NULL cells here, never a panic in the writer loop.
            Err(_) => FV::Null,
        };
        row[idx] = value.into_gen();
    }
}

/// Config validation for the preview/run commands — the Rust twin of
/// `validateFormula` in datagenFormula.ts, applied to every formula column.
/// Err names the column and the problem; the caller rejects the run BEFORE a
/// row is written.
pub fn validate_specs(specs: &[ColumnSpec]) -> Result<(), String> {
    for (idx, spec) in specs.iter().enumerate() {
        if spec.generator != "formula" {
            continue;
        }
        let src = spec.params.expr.as_deref().unwrap_or("");
        let ast = parse(src).map_err(|e| format!("formula column \"{}\": {e}", spec.name))?;
        for name in referenced_columns(&ast) {
            if !(0..idx).any(|j| specs[j].name == name) {
                let msg = if specs.iter().any(|s| s.name == name) {
                    format!(
                        "column \"{name}\" is not an earlier column — \
                         a formula can only reference columns to its left"
                    )
                } else {
                    format!("unknown column \"{name}\"")
                };
                return Err(format!("formula column \"{}\": {msg}", spec.name));
            }
        }
    }
    Ok(())
}

// ── Tests — pinned against tests/datagenFormula.test.ts ───────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(src: &str, row: &[(&str, FV)]) -> FV {
        let ast = parse(src).unwrap_or_else(|e| panic!("parse '{src}': {e}"));
        eval(&ast, &|name| row.iter().find(|(n, _)| *n == name).map(|(_, v)| v.clone()))
    }

    #[test]
    fn precedence_and_parens() {
        assert_eq!(ev("1 + 2 * 3", &[]), FV::Num(7.0));
        assert_eq!(ev("(1 + 2) * 3", &[]), FV::Num(9.0));
        assert_eq!(ev("10 - 4 - 3", &[]), FV::Num(3.0)); // left assoc
        assert_eq!(ev("-2 * -3", &[]), FV::Num(6.0));
        assert_eq!(ev("17 % 5", &[]), FV::Num(2.0));
        assert_eq!(ev("7 / 2", &[]), FV::Num(3.5));
        assert_eq!(ev("'a' || 'b' || 'c'", &[]), FV::Str("abc".into()));
        // '||' binds looser than '+'.
        assert_eq!(ev("1 + 2 || 'x'", &[]), FV::Str("3x".into()));
    }

    #[test]
    fn arithmetic_and_concat_rules() {
        // Both numbers → add; a string on either side → concat.
        assert_eq!(ev("price * qty", &[("price", FV::Num(2.5)), ("qty", FV::Num(4.0))]), FV::Num(10.0));
        assert_eq!(
            ev("first + ' ' + last", &[("first", FV::Str("Ada".into())), ("last", FV::Str("Lovelace".into()))]),
            FV::Str("Ada Lovelace".into())
        );
        // Numeric-looking strings still concat for '+' …
        assert_eq!(ev("a + 1", &[("a", FV::Str("10".into()))]), FV::Str("101".into()));
        // … but strict-parse for the other arithmetic operators.
        assert_eq!(ev("a * 2", &[("a", FV::Str("10".into()))]), FV::Num(20.0));
        assert_eq!(ev("a * 2", &[("a", FV::Str("n/a".into()))]), FV::Null); // type error → NULL
        assert_eq!(ev("1 / 0", &[]), FV::Null);
        assert_eq!(ev("5 % 0", &[]), FV::Null);
        assert_eq!(ev("a + 1", &[("a", FV::Null)]), FV::Null); // NULL propagates
        assert_eq!(ev("a || 'x'", &[("a", FV::Null)]), FV::Null);
        assert_eq!(ev("b + 1", &[("b", FV::Bool(true))]), FV::Null); // bools don't arithmeticate
    }

    #[test]
    fn functions_match_the_ts_vectors() {
        assert_eq!(ev("abs(0 - 3)", &[]), FV::Num(3.0));
        assert_eq!(ev("round(2.5)", &[]), FV::Num(3.0));
        // Math.round semantics: half towards +∞, so -2.5 → -2 (Rust's own
        // round() would give -3 — the divergence js_round exists to prevent).
        assert_eq!(ev("round(-2.5)", &[]), FV::Num(-2.0));
        assert_eq!(ev("round(1.005 * 3, 2)", &[]), FV::Num(3.01));
        assert_eq!(ev("floor(2.7)", &[]), FV::Num(2.0));
        assert_eq!(ev("ceil(2.1)", &[]), FV::Num(3.0));
        assert_eq!(ev("min(3, 1, 2)", &[]), FV::Num(1.0));
        assert_eq!(ev("max(3, 1, 2)", &[]), FV::Num(3.0));
        assert_eq!(ev("min(a, 2)", &[("a", FV::Null)]), FV::Null); // NULL in → NULL out
        assert_eq!(ev("length(s)", &[("s", FV::Str("héllo".into()))]), FV::Num(5.0));
        assert_eq!(ev("upper(s)", &[("s", FV::Str("héllo".into()))]), FV::Str("HÉLLO".into()));
        assert_eq!(ev("lower(s)", &[("s", FV::Str("HÉLLO".into()))]), FV::Str("héllo".into()));
        assert_eq!(ev("substr(s, 2, 3)", &[("s", FV::Str("abcdef".into()))]), FV::Str("bcd".into()));
        assert_eq!(ev("substr(s, 4)", &[("s", FV::Str("abcdef".into()))]), FV::Str("def".into()));
        assert_eq!(ev("substr(s, 0, 3)", &[("s", FV::Str("abcdef".into()))]), FV::Str("abc".into()));
        assert_eq!(ev("coalesce(a, b, 7)", &[("a", FV::Null), ("b", FV::Null)]), FV::Num(7.0));
        assert_eq!(
            ev("coalesce(a, 'x')", &[("a", FV::Str("v".into()))]),
            FV::Str("v".into())
        );
        assert_eq!(
            ev("slugify(s)", &[("s", FV::Str("Héllo World!".into()))]),
            FV::Str("héllo-world".into())
        );
    }

    #[test]
    fn number_stringification_is_the_js_form() {
        assert_eq!(js_num_str(3.0), "3");
        assert_eq!(js_num_str(2.5), "2.5");
        assert_eq!(js_num_str(0.1 + 0.2), "0.30000000000000004");
        assert_eq!(js_num_str(-42.0), "-42");
        assert_eq!(ev("qty || ' items'", &[("qty", FV::Num(3.0))]), FV::Str("3 items".into()));
    }

    #[test]
    fn strict_numeric_strings() {
        for (s, want) in [
            ("10", Some(10.0)),
            (" 2.5 ", Some(2.5)),
            ("-3", Some(-3.0)),
            (".5", Some(0.5)),
            ("5.", Some(5.0)),
            ("1e3", Some(1000.0)),
            ("", None),
            ("0x10", None),
            ("inf", None),
            ("NaN", None),
            ("12,5", None),
            ("1_000", None),
        ] {
            assert_eq!(
                to_num_strict(&FV::Str(s.to_string())), want,
                "strict parse of {s:?}"
            );
        }
    }

    #[test]
    fn parse_errors_are_named_not_thrown() {
        assert!(parse("").unwrap_err().contains("empty"));
        assert!(parse("price *").unwrap_err().contains("unexpected end"));
        assert!(parse("foo(1)").unwrap_err().contains("unknown function 'foo'"));
        assert!(parse("abs(1, 2)").unwrap_err().contains("exactly 1 argument"));
        assert!(parse("substr('x')").unwrap_err().contains("2–3 arguments"));
        assert!(parse("1 2").unwrap_err().contains("trailing"));
        assert!(parse("'abc").unwrap_err().contains("unterminated string"));
        assert!(parse("1.2.3").unwrap_err().contains("malformed number"));
        assert!(parse("@").unwrap_err().contains("unexpected character '@'"));
    }

    #[test]
    fn column_refs_and_quoting() {
        assert_eq!(
            ev("\"odd name\" * 2", &[("odd name", FV::Num(21.0))]),
            FV::Num(42.0)
        );
        // An identifier only becomes a function before '('.
        assert_eq!(ev("round", &[("round", FV::Num(1.5))]), FV::Num(1.5));
        // Unknown column → NULL (the type-error rule), never a panic.
        assert_eq!(ev("nope + 1", &[]), FV::Null);
    }
}
