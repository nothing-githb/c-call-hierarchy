/*
 * Pure, vscode-free text/range classification helpers. Kept dependency-free so
 * they can be unit-tested in plain Node (see test/logic.test.js, run on every
 * package via the vscode:prepublish script).
 */

export enum RefKind {
  Definition,
  Declaration,
  Write,
  Address,
  Read,
  Unknown,
}

// ---------------------------------------------------------------------------
// Address-of detection
// ---------------------------------------------------------------------------

/**
 * True if the address of the identifier at [start, end) on `line` is taken with
 * unary `&`. Handles whole-symbol (`&x`), member chains (`&cfg.field`,
 * `&p->a->b` — the target is the chain's LAST component), and parenthesised
 * lvalues (`&(x)`, `&(cfg.field)`). Excludes bitwise `a & x` and logical `a && x`.
 */
export function isAddressOf(line: string, start: number, end: number): boolean {
  // Not the target if a member/subscript continues to the right (it's a base).
  // A closing `)` is skipped too, so `&(cfg).field` treats `cfg` as the base.
  let r = end;
  while (r < line.length && (line[r] === ' ' || line[r] === '\t' || line[r] === ')')) {
    r++;
  }
  if (line[r] === '.' || line[r] === '[' || (line[r] === '-' && line[r + 1] === '>')) {
    return false;
  }
  // Walk left over a `.` / `->` member chain to the base of the lvalue.
  let p = start;
  for (;;) {
    let q = p - 1;
    while (q >= 0 && (line[q] === ' ' || line[q] === '\t')) {
      q--;
    }
    const arrow = q >= 1 && line[q] === '>' && line[q - 1] === '-';
    if (q >= 0 && (line[q] === '.' || arrow)) {
      // Peek at the base: a parenthesised base means `&(expr).field` —
      // skip the group and check for a unary `&` in front of it.
      let b = (arrow ? q - 2 : q - 1);
      while (b >= 0 && (line[b] === ' ' || line[b] === '\t')) {
        b--;
      }
      if (b >= 0 && line[b] === ')') {
        return isUnaryAmp(line, skipParenLeft(line, b));
      }
      p = atomStart(line, arrow ? q - 2 : q - 1);
    } else {
      // Skip grouping parentheses: `&(x)`, `&(cfg.field)`, `&((x))`.
      while (q >= 0 && line[q] === '(') {
        q--;
        while (q >= 0 && (line[q] === ' ' || line[q] === '\t')) {
          q--;
        }
      }
      return isUnaryAmp(line, q);
    }
    if (p < 0) {
      return false;
    }
  }
}

/** Given an index at `)`, return the index just left of the matching `(`. */
function skipParenLeft(line: string, idx: number): number {
  let depth = 0;
  for (let p = idx; p >= 0; p--) {
    if (line[p] === ')') {
      depth++;
    } else if (line[p] === '(') {
      depth--;
      if (depth === 0) {
        return p - 1;
      }
    }
  }
  return -1;
}

/** Start index of the identifier atom ending at/before `end` (skips `[...]`). */
function atomStart(line: string, end: number): number {
  let p = end;
  while (p >= 0 && (line[p] === ' ' || line[p] === '\t')) {
    p--;
  }
  while (p >= 0 && line[p] === ']') {
    let depth = 1;
    p--;
    while (p >= 0 && depth > 0) {
      if (line[p] === ']') {
        depth++;
      } else if (line[p] === '[') {
        depth--;
      }
      p--;
    }
    while (p >= 0 && (line[p] === ' ' || line[p] === '\t')) {
      p--;
    }
  }
  if (p < 0 || !/[A-Za-z0-9_]/.test(line[p])) {
    return -1;
  }
  let s = p;
  while (s >= 0 && /[A-Za-z0-9_]/.test(line[s])) {
    s--;
  }
  return s + 1;
}

/** True if `idx` (the char left of an lvalue) is a unary address-of `&`. */
function isUnaryAmp(line: string, idx: number): boolean {
  let q = idx;
  while (q >= 0 && (line[q] === ' ' || line[q] === '\t')) {
    q--;
  }
  if (q < 0 || line[q] !== '&') {
    return false;
  }
  if (q >= 1 && line[q - 1] === '&') {
    return false; // `&&` — logical AND
  }
  let j = q - 1;
  while (j >= 0 && (line[j] === ' ' || line[j] === '\t')) {
    j--;
  }
  if (j < 0 || !/[A-Za-z0-9_)\]]/.test(line[j])) {
    return true; // operator / punctuation / start-of-line before `&` → unary
  }
  // A value before `&` means bitwise AND, unless it's an operand-taking keyword.
  let k = j;
  while (k >= 0 && /[A-Za-z0-9_]/.test(line[k])) {
    k--;
  }
  return /^(return|case|sizeof|co_return|co_yield|co_await)$/.test(line.slice(k + 1, j + 1));
}

// ---------------------------------------------------------------------------
// Read/write heuristic (fallback when the provider gives no role)
// ---------------------------------------------------------------------------

/**
 * Syntactic read/write guess for a variable/field occurrence at [start, end).
 *   - preceded/followed by `++`/`--`   → Write
 *   - lvalue (with `[..]`/`.f`/`->f`) followed by `=`/compound assignment → Write
 *   - immediately followed by `(`       → Unknown (a call, not a variable)
 *   - otherwise                         → Read
 */
export function heuristicKind(line: string | undefined, start: number, end: number): RefKind {
  if (line === undefined) {
    return RefKind.Unknown;
  }
  if (/(\+\+|--)\s*$/.test(line.slice(0, start))) {
    return RefKind.Write; // pre-increment / pre-decrement
  }
  let rest = line.slice(end);
  if (/^\s*\(/.test(rest)) {
    return RefKind.Unknown; // function/macro call — not a variable read/write
  }
  let prev: string;
  do {
    prev = rest;
    rest = rest.replace(/^\s*(\[[^[\]]*\]|\.[A-Za-z_]\w*|->[A-Za-z_]\w*)/, '');
  } while (rest !== prev);
  rest = rest.replace(/^\s*/, '');
  if (/^(\+\+|--)/.test(rest)) {
    return RefKind.Write; // post-increment / post-decrement
  }
  if (/^(==|!=|<=|>=)/.test(rest)) {
    return RefKind.Read; // comparison
  }
  if (/^([+\-*/%&|^]=|<<=|>>=|=)/.test(rest)) {
    return RefKind.Write; // assignment / compound assignment
  }
  return RefKind.Read;
}

// ---------------------------------------------------------------------------
// Glob / regex / contains matching (the search filter)
// ---------------------------------------------------------------------------

/**
 * Path matcher. `/expr/flags` → JavaScript regex; otherwise a glob supporting
 * `**`, `*`, `?`. An invalid regex falls back to glob matching.
 */
export function matchGlob(path: string, pattern: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  const rx = pattern.match(/^\/(.*)\/([a-zA-Z]*)$/);
  if (rx) {
    try {
      return new RegExp(rx[1], rx[2]).test(normalized);
    } catch {
      /* malformed regex → fall through to glob */
    }
  }
  return globToRegExp(pattern.replace(/\\/g, '/')).test(normalized);
}

function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++; // consume the second '*'
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

/**
 * Ranges of `text` (a symbol name) that the search `query` matches, for
 * highlighting in a tree label. `[start, end)` pairs, left-to-right,
 * non-overlapping. A plain query highlights every case-insensitive occurrence;
 * a `/regex/flags` query highlights each match in the name. A glob matches the
 * whole *path* (not a substring of the name), so it highlights nothing. Empty
 * when there is no match — callers fall back to a plain string label.
 */
export function queryHighlights(text: string, query: string): [number, number][] {
  if (!text || !query) {
    return [];
  }
  const isRegex = /^\/.*\/[a-zA-Z]*$/.test(query);
  const isGlob = !isRegex && /[*?]/.test(query);
  if (isRegex) {
    const m = query.match(/^\/(.*)\/([a-zA-Z]*)$/);
    if (!m) {
      return [];
    }
    let rx: RegExp;
    try {
      rx = new RegExp(m[1], m[2].includes('g') ? m[2] : m[2] + 'g');
    } catch {
      return []; // malformed regex → no highlight
    }
    const out: [number, number][] = [];
    let match: RegExpExecArray | null;
    let guard = 0;
    while ((match = rx.exec(text)) !== null && guard++ < 1000) {
      if (match[0].length === 0) {
        rx.lastIndex++; // zero-width match → avoid an infinite loop
        continue;
      }
      out.push([match.index, match.index + match[0].length]);
    }
    return out;
  }
  if (isGlob) {
    return [];
  }
  const q = query.toLowerCase();
  const lower = text.toLowerCase();
  const out: [number, number][] = [];
  let i = lower.indexOf(q);
  while (i !== -1 && out.length < 1000) {
    // Cap matches as the regex branch does — a symbol name never has 1000
    // occurrences, so this only bounds pathological input.
    out.push([i, i + q.length]);
    i = lower.indexOf(q, i + q.length);
  }
  return out;
}

/** Match `query` against any candidate (name / path): regex, glob, or contains. */
export function matchesQuery(query: string, candidates: string[]): boolean {
  if (!query) {
    return true;
  }
  const isRegex = /^\/.*\/[a-zA-Z]*$/.test(query);
  const isGlob = !isRegex && /[*?]/.test(query);
  if (isRegex || isGlob) {
    return candidates.some((c) => matchGlob(c, query));
  }
  const q = query.toLowerCase();
  return candidates.some((c) => c.toLowerCase().includes(q));
}

// ---------------------------------------------------------------------------
// Call-site cursor (walking a ×N node's merged call sites)
// ---------------------------------------------------------------------------

/**
 * Advance a single-slot cursor over a ×N node's merged call sites. Re-invoking
 * on the SAME node (`key` unchanged) steps to the next site, wrapping around;
 * invoking on a DIFFERENT node — a key mismatch, or no prior cursor — restarts
 * at the first site. So one node's walk state never leaks into another node: the
 * caller keeps a single `{ key, index }` and replaces it with the result each
 * time. `total <= 1` always yields index 0.
 */
export function nextSiteIndex(
  cursor: { key: string; index: number } | undefined,
  key: string,
  total: number,
): { key: string; index: number; total: number } {
  const n = total > 0 ? total : 1;
  const index = cursor && cursor.key === key ? (cursor.index + 1) % n : 0;
  return { key, index, total: n };
}
