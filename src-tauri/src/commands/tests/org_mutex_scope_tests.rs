//! Oracles for WHERE `org_share_mutation_lock` is acquired.
//!
//! The lock serializes org mutation/revoke against share dispatch, and that job needs it held
//! across a short durable commit — not across a human or a network. Two acquisitions were doing the
//! latter (2026-09-02 audit, O4):
//!
//!   * `unlock_folder` took it in its FIRST statement, then presented the Touch ID sheet ~30 lines
//!     later. Every org mutation in the process waited for as long as the user took to answer that
//!     dialog, or forever if they never did.
//!   * `org_background_sync_tick` took it once and ran FOUR network phases under it, so a user
//!     sharing or revoking could wait behind four consecutive HTTP timeouts on a 60 s tick.
//!
//! These are SOURCE-ORDER oracles, and that is a deliberate, stated limitation: the properties are
//! "the lock is not held across X", and there is no in-process way to assert that without a seam
//! for the human prompt and for each HTTP phase. Asserting the acquisition's POSITION is the honest
//! proxy, and it catches the regression that actually happens — someone hoists the acquisition back
//! to the top of the function.
//!
//! Comments are stripped before matching. An earlier oracle of mine in this repo asked whether a
//! body CONTAINED a call's name and was defeated in one move by putting that name in a comment;
//! searching for text is always cheaper to fool than to defend.

use std::path::PathBuf;

fn commands_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("commands")
}

/// Blank out `//` and `/* */`, respecting string literals so a `"http://…"` survives intact.
fn strip_comments(source: &str) -> String {
    let chars: Vec<char> = source.chars().collect();
    let mut out = String::with_capacity(source.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '"' {
            out.push(c);
            i += 1;
            while i < chars.len() {
                if chars[i] == '\\' {
                    i += 2;
                    continue;
                }
                out.push(chars[i]);
                let done = chars[i] == '"';
                i += 1;
                if done {
                    break;
                }
            }
            continue;
        }
        if c == '/' && i + 1 < chars.len() && chars[i + 1] == '/' {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if c == '/' && i + 1 < chars.len() && chars[i + 1] == '*' {
            i += 2;
            while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                if chars[i] == '\n' {
                    out.push('\n');
                }
                i += 1;
            }
            i += 2;
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

/// The body of `fn <name>(` up to its matching closing brace, comments already stripped.
fn body_of(file: &str, name: &str) -> String {
    let source = strip_comments(
        &std::fs::read_to_string(commands_dir().join(file))
            .unwrap_or_else(|e| panic!("cannot read {file}: {e}")),
    );
    let sig = format!("fn {name}(");
    let start = source
        .find(&sig)
        .unwrap_or_else(|| panic!("{file}: `{name}` not found — update this oracle deliberately"));
    let open = start + source[start..].find('{').expect("no body");
    let mut depth = 0usize;
    for (offset, ch) in source[open..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return source[open..=open + offset].to_string();
                }
            }
            _ => {}
        }
    }
    panic!("{file}: `{name}` has no closing brace");
}

/// Every acquisition now goes through the ONE helper (see
/// `nothing_takes_the_org_mutex_except_the_one_helper`), so that call — not the field name — is
/// what these oracles look for. Matching the field would silently stop finding anything the moment
/// the door was renamed, which is how a source oracle goes quietly vacuous.
const ACQUIRE: &str = "lock_org_mutation(";

/// BOTH doors onto the mutex. `acquire_share_mutation_within` is a second, bounded way to take the
/// same lock, and a guard-lifetime model that only knows the unbounded one is blind to exactly the
/// call sites that use the bounded one — which is every user-facing org command, since a button must
/// never wait forever. The scope property is identical for both: the guard lives until its block
/// closes, and a re-entrant callee under either one hangs.
const ACQUISITIONS: [&str; 2] = ["lock_org_mutation(", "acquire_share_mutation_within("];

/// `unlock_folder` must not hold the org mutex across the Touch ID sheet.
///
/// RED CONTROL (run 2026-09-03, observed): hoisting the acquisition back to the command's first
/// statement fails with "acquires `org_share_mutation_lock` at byte 32, BEFORE the biometric KEK
/// release at 1180".
#[test]
fn unlock_folder_takes_the_org_mutex_only_after_the_biometric_kek_release() {
    let body = body_of("lock.rs", "unlock_folder");
    let kek = body
        .find("master_kek_with_policy")
        .expect("unlock_folder no longer resolves the KEK — this oracle is stale, fix it");
    let acquire = body
        .find(ACQUIRE)
        .expect("unlock_folder no longer takes the org mutex — was that deliberate?");
    assert!(
        acquire > kek,
        "unlock_folder acquires `{ACQUIRE}` at byte {acquire}, BEFORE the biometric KEK release at \
         {kek}. That holds a process-wide org mutex across the Touch ID sheet — for as long as the \
         user takes to answer it, and indefinitely if they never do."
    );
}

/// The background tick must take the org mutex per phase, never once around all four.
///
/// Asserts on brace DEPTH, not on a count: what makes the old shape wrong is that the acquisition
/// sat at the function's own level and so outlived every phase. A count would pass just as happily
/// for one acquisition at the top plus one nested.
///
/// RED CONTROL (run 2026-09-03, observed): restoring the single top-level acquisition ALONGSIDE the
/// per-phase ones fails with "depths seen: [1, 2, 2, 2, 2]" — which is exactly why this asserts on
/// depth and not on a count. A count-based check would have passed that mutation happily (5 >= 2).
#[test]
fn the_org_background_tick_never_holds_the_mutex_across_a_network_phase() {
    let body = body_of("org.rs", "org_background_sync_tick");
    let mut depth = 0usize;
    let mut acquisitions = Vec::new();
    let chars: Vec<char> = body.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '{' => depth += 1,
            '}' => depth = depth.saturating_sub(1),
            _ => {
                if body[i..].starts_with(ACQUIRE) {
                    acquisitions.push(depth);
                    i += ACQUIRE.len();
                    continue;
                }
            }
        }
        i += 1;
    }
    assert!(
        !acquisitions.is_empty(),
        "the tick no longer takes `{ACQUIRE}` at all — was that deliberate?"
    );
    // Depth 1 is the function body itself; anything acquired there is held for the whole tick.
    assert!(
        !acquisitions.contains(&1),
        "the tick acquires `{ACQUIRE}` at the function's own scope (depths seen: {acquisitions:?}), \
         so it is held across every network phase in the tick. Take it inside each phase's block \
         instead: a user sharing or revoking then waits behind at most one HTTP timeout, not four."
    );
    assert!(
        acquisitions.len() >= 2,
        "expected one acquisition per network phase, found {} (depths {acquisitions:?})",
        acquisitions.len()
    );
}

/// Positions in `body` where an `org_share_mutation_lock` guard is still IN SCOPE.
///
/// Models the guard's lifetime rather than its mere presence: an acquisition at brace depth `d`
/// lives until the block at depth `d` closes. Indexed by BYTE offset, so a `str::find` result can be
/// used directly — the earlier char-indexed version happened to agree only because everything before
/// the site it was written for was ASCII.
///
/// An acquisition that is itself a `fn` DEFINITION is not an acquisition. Counting one would open a
/// guard at module depth that nothing ever closes, and every later call in the file would then look
/// like it ran under the lock.
fn guard_is_held_at(body: &str) -> Vec<bool> {
    let mut depth = 0usize;
    let mut open_guards: Vec<usize> = Vec::new();
    let mut marks = vec![false; body.len()];
    for (offset, ch) in body.char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth = depth.saturating_sub(1);
                open_guards.retain(|d| *d <= depth);
            }
            _ => {
                if ACQUISITIONS
                    .iter()
                    .any(|needle| body[offset..].starts_with(needle))
                    && !body[..offset].trim_end().ends_with("fn")
                {
                    open_guards.push(depth);
                }
            }
        }
        marks[offset..offset + ch.len_utf8()].fill(!open_guards.is_empty());
    }
    marks
}

/// Blank every COMMENT body, STRING literal (ordinary and raw), and CHAR literal, preserving byte
/// offsets so a `str::find` result still indexes the guard model.
///
/// One pass, not two, because the four constructs are mutually ambiguous: a `'"'` char literal opens
/// a string for a naive scanner, a `//` inside a string opens a comment, and a raw string may
/// contain both. {@link strip_comments} above understands only the first two and is kept for the
/// legacy per-function oracles, which read known-clean bodies.
///
/// It matters here because the guard model counts braces, and one desynchronizing `'{'` or raw `"`
/// silently turns the file-wide scan into a FALSE NEGATIVE — the scan still reports "N sites across
/// M files", so the vacuity guard passes while the check has stopped seeing anything. That is
/// exactly how this module's own header says a source oracle dies. `commands/` already contains raw
/// strings (`reminders.rs`, `trash.rs`, `calendar.rs`); that none of them sits near a call site
/// today is luck, not a property.
fn sanitize_for_scan(source: &str) -> String {
    let bytes = source.as_bytes();
    let mut out = String::with_capacity(source.len());
    let mut i = 0usize;

    // Blank `count` bytes starting at `from`, keeping newlines so line numbers survive.
    let blank = |out: &mut String, span: &str| {
        for ch in span.chars() {
            out.push(if ch == '\n' { '\n' } else { ' ' });
            for _ in 1..ch.len_utf8() {
                out.push(' ');
            }
        }
    };

    while i < bytes.len() {
        // Line comment.
        if bytes[i] == b'/' && bytes.get(i + 1) == Some(&b'/') {
            let end = source[i..].find('\n').map_or(bytes.len(), |off| i + off);
            blank(&mut out, &source[i..end]);
            i = end;
            continue;
        }
        // Block comment (nesting is legal in Rust).
        if bytes[i] == b'/' && bytes.get(i + 1) == Some(&b'*') {
            let mut depth = 1usize;
            let mut j = i + 2;
            while j < bytes.len() && depth > 0 {
                if bytes[j] == b'/' && bytes.get(j + 1) == Some(&b'*') {
                    depth += 1;
                    j += 2;
                } else if bytes[j] == b'*' && bytes.get(j + 1) == Some(&b'/') {
                    depth -= 1;
                    j += 2;
                } else {
                    j += 1;
                }
            }
            blank(&mut out, &source[i..j.min(bytes.len())]);
            i = j.min(bytes.len());
            continue;
        }
        // Char literal — `'x'`, `'\n'`, `'\''`. A lifetime (`'a`) has no closing quote nearby.
        if bytes[i] == b'\'' {
            if let Some(end) = char_literal_end(bytes, i) {
                out.push('\'');
                blank(&mut out, &source[i + 1..end]);
                out.push('\'');
                i = end + 1;
                continue;
            }
            out.push('\'');
            i += 1;
            continue;
        }
        // Raw string — `r"…"` / `r#"…"#`, any number of hashes, no escapes inside.
        if bytes[i] == b'r' && !is_ident_byte(i.checked_sub(1).map(|p| bytes[p])) {
            let mut hashes = 0usize;
            while bytes.get(i + 1 + hashes) == Some(&b'#') {
                hashes += 1;
            }
            if bytes.get(i + 1 + hashes) == Some(&b'"') {
                let body = i + 2 + hashes;
                let mut terminator = String::with_capacity(hashes + 1);
                terminator.push('"');
                for _ in 0..hashes {
                    terminator.push('#');
                }
                let end = source
                    .get(body..)
                    .and_then(|rest| rest.find(&terminator))
                    .map_or(bytes.len(), |off| body + off);
                out.push_str(&source[i..body.min(bytes.len())]);
                blank(&mut out, &source[body.min(bytes.len())..end]);
                let close = (end + terminator.len()).min(bytes.len());
                out.push_str(&source[end..close]);
                i = close;
                continue;
            }
        }
        // Ordinary string.
        if bytes[i] == b'"' {
            out.push('"');
            i += 1;
            while i < bytes.len() {
                if bytes[i] == b'\\' {
                    out.push(' ');
                    i += 1;
                    if i < bytes.len() {
                        let ch = source[i..].chars().next().expect("char boundary");
                        blank(&mut out, &source[i..i + ch.len_utf8()]);
                        i += ch.len_utf8();
                    }
                    continue;
                }
                if bytes[i] == b'"' {
                    out.push('"');
                    i += 1;
                    break;
                }
                let ch = source[i..].chars().next().expect("char boundary");
                blank(&mut out, &source[i..i + ch.len_utf8()]);
                i += ch.len_utf8();
            }
            continue;
        }
        let ch = source[i..].chars().next().expect("char boundary");
        out.push(ch);
        i += ch.len_utf8();
    }
    debug_assert_eq!(out.len(), source.len(), "sanitize must preserve byte offsets");
    out
}

fn is_ident_byte(b: Option<u8>) -> bool {
    matches!(b, Some(c) if c.is_ascii_alphanumeric() || c == b'_')
}

/// The index of a char literal's closing quote, or `None` when this quote opens a lifetime.
fn char_literal_end(bytes: &[u8], open: usize) -> Option<usize> {
    let escaped = bytes.get(open + 1) == Some(&b'\\');
    let limit = if escaped { open + 8 } else { open + 5 };
    let mut i = open + if escaped { 2 } else { 1 };
    while i < bytes.len() && i <= limit {
        if bytes[i] == b'\'' {
            return Some(i);
        }
        i += 1;
    }
    None
}

/// The sanitizer must actually neutralize the constructs that would desynchronize the brace model.
///
/// Without this, a future edit that breaks `sanitize_for_scan` turns the file-wide scan into a
/// silent pass — the exact failure this module exists to prevent, one level up.
#[test]
fn the_scan_sanitizer_neutralizes_braces_hidden_in_literals() {
    let source = r####"
fn a() { let brace = '{'; let quote = '"'; }
fn b() { let raw = r#"} " { lock_org_mutation("#; }
// lock_org_mutation( in a comment
fn c() { let s = "} { \" lock_org_mutation("; }
"####;
    let clean = sanitize_for_scan(source);
    assert_eq!(clean.len(), source.len(), "byte offsets must survive");
    assert_eq!(
        clean.matches('{').count(),
        3,
        "only the three real function-body braces may survive: {clean}"
    );
    assert_eq!(clean.matches('}').count(), 3);
    assert_eq!(
        clean.matches("lock_org_mutation(").count(),
        0,
        "an acquisition named inside a literal or comment is not an acquisition"
    );
}

/// The container-reconcile phase of the BACKGROUND TICK must not run under the org mutex.
///
/// `reconcile_container_shares` -> `reconcile_one_container_root` -> `share_to_org_placed_notifying`,
/// whose FIRST statement acquires this same mutex. `tokio::sync::Mutex` is not reentrant, so holding
/// it across this phase makes the task await a second acquisition of a mutex it already holds: it
/// never returns, the guard is never dropped, and every later org operation blocks for the rest of
/// the process. There is no timeout around the tick, so it does not recover.
///
/// This is why the FE's own "sync now" (`sync_container_shares`) calls the same function with no
/// lock — the serialization lives inside `share_to_org_placed_notifying`.
///
/// Kept ALONGSIDE the file-wide scan below, not replaced by it: this one names the tick and fails
/// with the tick's own byte offset, and it reads the function BODY rather than the whole file, so
/// the two disagree if the body extractor and the file scanner ever drift apart.
///
/// RED CONTROL (run 2026-09-03): wrapping the call in `{ let _m = …lock().await; … }` — the shape
/// this PR shipped before review — fails this test.
#[test]
fn the_container_reconcile_phase_does_not_run_under_the_org_mutex() {
    let body = body_of("org.rs", "org_background_sync_tick");
    let call = body
        .find("reconcile_container_shares(")
        .expect("the tick no longer reconciles container shares — update this oracle deliberately");
    let held = guard_is_held_at(&body);
    assert!(
        !held[call],
        "`reconcile_container_shares` is called while `{ACQUIRE}` is held. Its callee \
         `share_to_org_placed_notifying` acquires the same non-reentrant mutex as its first \
         statement, so this deadlocks permanently and takes every later org operation with it."
    );
}

/// NO production call site may run a KNOWN RE-ENTRANT callee under the org mutex — not just the tick.
///
/// WHY THIS EXISTS AS WELL AS THE TEST ABOVE (2026-09-08). The tick-only oracle above was written on
/// 2026-09-03 for the deadlock it had just caught, and it passed for five more days while
/// `org_sync_now` — the command behind the "Sync now" button — held the guard from its first
/// statement straight through the same `reconcile_container_shares` call. Pressing that button
/// deadlocked the task permanently: it never returned, its guard was never dropped, and every
/// subsequent org operation in the process blocked forever, so the app had to be restarted before
/// any org work happened again. A user reported it as "sync never finishes and the sidebar never
/// updates".
///
/// The property was never "the TICK does not do this". It was "NOTHING does this". An oracle scoped
/// to the one site that was broken cannot see the second one, and there was a second one. It now
/// scans the WHOLE crate, not just `commands/` — a guard held in `lib.rs` or `pipeline.rs` across
/// such a call wedges identically — and it watches `share_to_org_placed_notifying`, the symbol that
/// actually re-acquires, as well as the reconcile that reaches it.
///
/// LIMIT, stated rather than left to be discovered: this matches CALL TEXT, so moving the call one
/// level down into a helper hides it. An adversarial review demonstrated exactly that. I tried
/// replacing it with a name-based transitive call-graph closure and threw that away: this codebase's
/// correct pattern is "public wrapper takes the lock, then calls the lock-free `_inner`", which such
/// a closure cannot distinguish from a wedge — it flagged ~40 correct sites, and a check that fails
/// on correct code gets deleted rather than fixed.
///
/// DEPTH IS COVERED AT RUNTIME INSTEAD, and better: `state.rs`'s debug re-entrancy bookkeeping sees
/// the real dynamic path — any depth, through closures, trait objects and macros alike — and since
/// 2026-09-08 it registers the BOUNDED door too, so it covers both ways in. This oracle's job is the
/// static one it can actually do: catch the hoist that keeps happening.
///
/// WHERE NEITHER NET REACHES, said plainly. The runtime guard only fires on a path that EXECUTES in
/// a debug build, and nothing in `cargo test --lib` can execute `org_sync_now`'s container-reconcile
/// phase — it needs a real `tauri::AppHandle`. So a wedge on that specific phase, hidden behind one
/// level of indirection, is caught by neither: it surfaces when somebody presses Sync now in the dev
/// app. That is the honest residual, and it is why the hoist-catching half above is worth keeping
/// even though it is only a text scan.
///
/// RED CONTROL (run 2026-09-08, observed): restoring `org_sync_now`'s guard to the function's first
/// statement fails with "org.rs: `reconcile_container_shares` is called at byte … while an
/// org_share_mutation_lock guard is held".
#[test]
fn no_production_call_site_runs_a_reentrant_callee_under_the_org_mutex() {
    /// Callees known to acquire the same mutex, directly or one hop down.
    const REENTRANT: [&str; 2] = [
        "reconcile_container_shares(",
        "share_to_org_placed_notifying(",
    ];
    let mut offenders = Vec::new();
    let mut scanned = 0usize;
    let mut sites = 0usize;
    let mut stack = vec![PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src")];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).unwrap_or_else(|e| panic!("read {dir:?}: {e}")) {
            let path = entry.expect("dir entry").path();
            if path.is_dir() {
                // Test support may legitimately hold the guard while calling anything; the property
                // under test is about what SHIPS.
                if path.file_name().and_then(|n| n.to_str()) != Some("tests") {
                    stack.push(path);
                }
                continue;
            }
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if !(name.ends_with(".rs") || name.ends_with(".inc")) {
                continue;
            }
            let text = sanitize_for_scan(&std::fs::read_to_string(&path).unwrap_or_default());
            scanned += 1;
            let held = guard_is_held_at(&text);
            for needle in REENTRANT {
                let mut from = 0usize;
                while let Some(found) = text[from..].find(needle) {
                    let at = from + found;
                    from = at + 1;
                    // The definition itself is not a call site.
                    if text[..at].trim_end().ends_with("fn") {
                        continue;
                    }
                    sites += 1;
                    if held[at] {
                        offenders.push(format!("{name}: {needle} at byte {at}"));
                    }
                }
            }
        }
    }
    // Six real call sites today (three per needle). A margin loose enough to survive halving the
    // coverage is not a vacuity guard.
    assert!(
        scanned > 20 && sites >= 5,
        "the scan found {sites} call sites across {scanned} files — it has gone vacuous, fix it"
    );
    assert!(
        offenders.is_empty(),
        "a callee that acquires `org_share_mutation_lock` is called while a guard on that same \
         mutex is held, at {offenders:?}. `tokio::sync::Mutex` is not reentrant, so this deadlocks \
         permanently and takes every later org operation with it — the app then needs a restart. \
         Drop the guard before the call."
    );
}

/// `unlock_folder` must RE-VALIDATE after taking the mutex, not merely serialize the write.
///
/// Its `folder`, `folder.locked` refusal, `preflight_unlock_subtree` and `folder_wrapped_key` are
/// all read before any lock is held, with an unbounded Touch ID wait in between. A `lock_folder`
/// landing in that window takes its already-locked idempotent branch, bumps the seal epoch and
/// returns Ok — the user sees a successful "Lock". Without the re-check the unlock then resumes on
/// stale reads and restores plaintext, silently undoing it.
///
/// RED CONTROL (run 2026-09-03): deleting the
/// `require_current_content_visibility_snapshot` call fails this test.
#[test]
fn unlock_folder_revalidates_the_visibility_snapshot_after_taking_the_org_mutex() {
    let body = body_of("lock.rs", "unlock_folder");
    let capture = body
        .find("capture_content_visibility_snapshot")
        .expect("unlock_folder no longer captures a visibility snapshot");
    let first_read = body
        .find("folder_by_id")
        .expect("unlock_folder no longer reads the folder — this oracle is stale");
    let acquire = body.find(ACQUIRE).expect("no org mutex acquisition");
    let require = body
        .find("require_current_content_visibility_snapshot")
        .expect(
            "unlock_folder takes the org mutex late but never re-validates: a `lock_folder` that \
             ran during the Touch ID sheet would be silently undone",
        );
    assert!(
        capture < first_read,
        "the snapshot must be captured BEFORE the reads it protects (capture {capture}, read \
         {first_read})"
    );
    assert!(
        acquire < require,
        "the re-validation must happen AFTER the mutex is held (acquire {acquire}, require \
         {require}), or it can be invalidated again before the restore"
    );
}

/// Every acquisition of the org mutex goes through `AppState::lock_org_mutation`.
///
/// The debug re-entrancy guard lives in that one helper, and a guard that covers SOME call sites
/// covers none of the ones that matter: the deadlock it exists for was reached three levels deep,
/// through a callee nobody was thinking about (`reconcile_container_shares` ->
/// `reconcile_one_container_root` -> `share_to_org_placed_notifying`). One raw `.lock()` anywhere
/// is a hole in exactly the place a future author will not be looking.
///
/// `state.rs` is the sole exemption — it is where the helper takes the real lock.
///
/// RED CONTROL (run 2026-09-03): rewriting any single call site back to
/// `state.org_share_mutation_lock.lock().await` fails this test naming that file and line.
#[test]
fn nothing_takes_the_org_mutex_except_the_one_helper() {
    let src = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut raw = Vec::new();
    let mut stack = vec![src.clone()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).unwrap_or_else(|e| panic!("read {dir:?}: {e}")) {
            let path = entry.expect("dir entry").path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if !(name.ends_with(".rs") || name.ends_with(".inc")) || name == "state.rs" {
                continue;
            }
            let text = strip_comments(&std::fs::read_to_string(&path).unwrap_or_default());
            for (i, line) in text.lines().enumerate() {
                // Skip STRING LITERALS: this test's own assertion message names both the field
                // and `.lock()`, and so does prose in error copy. A check that flags itself is a
                // check nobody will keep.
                let code = line.split('"').step_by(2).collect::<String>();
                if code.contains("org_share_mutation_lock") && code.contains(".lock()") {
                    let rel = path.strip_prefix(&src).unwrap_or(&path).display().to_string();
                    raw.push(format!("{rel}:{}", i + 1));
                }
            }
        }
    }
    assert!(
        raw.is_empty(),
        "these take `org_share_mutation_lock` directly instead of `lock_org_mutation()`, so the \
         debug re-entrancy guard cannot see them: {raw:?}"
    );
}
