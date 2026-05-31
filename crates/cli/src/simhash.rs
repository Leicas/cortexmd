//! 64-bit SimHash for symbol bodies.
//!
//! Used by the cortexmd `code_find_semantic_duplicates` tool (mode=body)
//! to detect copy-pasted / near-duplicate symbol bodies across a repo. The
//! server has no source-tree access (that's why this client exists), so we
//! compute the fingerprint here at ingest time and ship it in the wire
//! payload as a 16-char lowercase hex string.
//!
//! Algorithm (Charikar 2002):
//!   1. Normalize body — lowercase; strip line + block comments; strip string
//!      literals (best-effort, language-agnostic); collapse whitespace.
//!   2. Tokenize on non-word chars.
//!   3. Build word-level 3-grams (sliding window).
//!   4. Hash each 3-gram with FNV-1a 64-bit.
//!   5. For each of 64 bits, sum +1 (bit set) or -1 (bit clear) across all
//!      3-grams' hashes.
//!   6. Final fingerprint: bit i = 1 iff the sum at position i is positive.
//!
//! Hamming distance between two 64-bit fingerprints ≈ 1 - similarity, so
//! distance ≤ 3 means ~95% similar.
//!
//! No identifier normalization in v1 — catches literal copy-paste, not
//! renamed-variable clones. Adding rename-aware tokenization would need
//! language-specific keyword lists; deferred until the bench shows it's
//! actually needed.

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x100_0000_01b3;

fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut h = FNV_OFFSET;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(FNV_PRIME);
    }
    h
}

/// Strip C/C++/JS/TS/Rust/Go-style line + block comments AND quoted string
/// literals, then lowercase and collapse whitespace. Language-agnostic
/// best-effort: Python's `#` line comments are also stripped, Python triple-
/// quoted strings are NOT — a triple-quoted body that's pure docstring may
/// land in the simhash, which is fine (the docstring is part of the
/// symbol's identity for dup-detection purposes).
fn normalize(body: &str) -> String {
    let bytes = body.as_bytes();
    let mut out = String::with_capacity(body.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];

        // Block comment /* ... */
        if b == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(bytes.len());
            out.push(' ');
            continue;
        }
        // Line comment // ... \n  or  # ... \n
        if (b == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'/')
            || b == b'#'
        {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            out.push(' ');
            continue;
        }
        // Quoted string: "..." or '...' or `...` — handle simple escapes.
        if b == b'"' || b == b'\'' || b == b'`' {
            let quote = b;
            i += 1;
            while i < bytes.len() && bytes[i] != quote {
                if bytes[i] == b'\\' && i + 1 < bytes.len() {
                    i += 2;
                } else {
                    i += 1;
                }
            }
            i = (i + 1).min(bytes.len());
            out.push(' ');
            continue;
        }

        let c = b as char;
        if c.is_whitespace() {
            if !out.ends_with(' ') {
                out.push(' ');
            }
        } else {
            for cc in c.to_lowercase() {
                out.push(cc);
            }
        }
        i += 1;
    }
    out.trim().to_string()
}

/// Compute the 64-bit SimHash fingerprint of a symbol body. Returns 0 for
/// bodies that produce no tokens after normalization (callers should treat
/// 0 as "no fingerprint" — clusters built on it would be meaningless).
pub fn compute(body: &str) -> u64 {
    let normalized = normalize(body);
    let tokens: Vec<&str> = normalized
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .filter(|t| !t.is_empty())
        .collect();
    if tokens.len() < 3 {
        return 0;
    }

    let mut tally = [0i32; 64];
    // Word-level 3-grams.
    for window in tokens.windows(3) {
        let key = format!("{}\x1f{}\x1f{}", window[0], window[1], window[2]);
        let h = fnv1a64(key.as_bytes());
        for bit in 0..64 {
            if (h >> bit) & 1 == 1 {
                tally[bit] += 1;
            } else {
                tally[bit] -= 1;
            }
        }
    }

    let mut fingerprint: u64 = 0;
    for bit in 0..64 {
        if tally[bit] > 0 {
            fingerprint |= 1u64 << bit;
        }
    }
    fingerprint
}

/// Hex-encode a 64-bit fingerprint as 16 lowercase hex chars (the wire format).
pub fn to_hex(fp: u64) -> String {
    format!("{:016x}", fp)
}

/// Hamming distance between two fingerprints — count of differing bits.
#[allow(dead_code)]
pub fn hamming(a: u64, b: u64) -> u32 {
    (a ^ b).count_ones()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_bodies_match_exactly() {
        let body = "fn add(a: i32, b: i32) -> i32 { a + b }";
        assert_eq!(compute(body), compute(body));
    }

    #[test]
    fn comments_dont_change_fingerprint() {
        let a = "fn f() { x() }";
        let b = "fn f() { /* leading */ x() // trailing\n }";
        assert_eq!(compute(a), compute(b), "comments should be stripped");
    }

    #[test]
    fn whitespace_doesnt_change_fingerprint() {
        let a = "fn f() { x(); y(); z(); }";
        let b = "fn   f()    {  x();   y();   z();  }";
        assert_eq!(compute(a), compute(b));
    }

    #[test]
    fn different_bodies_diverge() {
        let a = "fn f() { x(); y(); z(); }";
        let b = "fn g() { foo(); bar(); baz(); qux(); }";
        let dist = hamming(compute(a), compute(b));
        assert!(dist > 5, "expected hamming distance >5, got {}", dist);
    }

    #[test]
    fn near_duplicate_low_distance() {
        let a = "fn f() { x(); y(); z(); a(); b(); c(); d(); e(); }";
        // Near-dup: one extra call.
        let b = "fn f() { x(); y(); z(); a(); b(); c(); d(); e(); ee(); }";
        let dist = hamming(compute(a), compute(b));
        assert!(dist < 12, "expected hamming distance <12, got {}", dist);
    }

    #[test]
    fn empty_or_tiny_returns_zero() {
        assert_eq!(compute(""), 0);
        assert_eq!(compute("x"), 0);
        assert_eq!(compute("a b"), 0);
    }

    #[test]
    fn hex_format() {
        assert_eq!(to_hex(0), "0000000000000000");
        assert_eq!(to_hex(0xdeadbeef), "00000000deadbeef");
        assert_eq!(to_hex(u64::MAX), "ffffffffffffffff");
    }
}
