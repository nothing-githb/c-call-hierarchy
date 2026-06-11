/*
 * Unit tests for the pure text/range logic (out/textutil.js). Run on every
 * package via the `vscode:prepublish` script (npm run compile && npm test).
 * No VS Code runtime needed.
 */
const path = require('path');
const T = require(path.join(__dirname, '..', 'out', 'textutil.js'));
const { RefKind, isAddressOf, heuristicKind, matchGlob, matchesQuery, nextSiteIndex, queryHighlights } = T;

let fail = 0;
function eq(actual, expected, msg) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}` + (ok ? '' : `  got=${actual} want=${expected}`));
}
// address-of for the (first/nth) occurrence of id in line
function addr(line, id, n = 1) {
  let i = -1;
  for (let c = 0; c < n; c++) i = line.indexOf(id, i + 1);
  return isAddressOf(line, i, i + id.length);
}
function kind(line, id, n = 1) {
  let i = -1;
  for (let c = 0; c < n; c++) i = line.indexOf(id, i + 1);
  return heuristicKind(line, i, i + id.length);
}

console.log('# address-of (&)');
eq(addr('    f(&x);', 'x'), true, '&x');
eq(addr('    p = &x;', 'x'), true, 'p = &x');
eq(addr('    scanf("%d", &val);', 'val'), true, 'scanf(.., &val)');
eq(addr('    return &node;', 'node'), true, 'return &node');
eq(addr('    int z = a & x;', 'x'), false, 'a & x (bitwise)');
eq(addr('    if (a && x) {', 'x'), false, 'a && x (logical)');
eq(addr('    z = arr[i] & mask;', 'mask'), false, 'arr[i] & mask (bitwise)');

console.log('# address-of — member chains');
eq(addr('    p = &cfg.field;', 'field'), true, '&cfg.field: field');
eq(addr('    p = &cfg.field;', 'cfg'), false, '&cfg.field: cfg (base)');
eq(addr('    g(&node->next->val);', 'val'), true, '&a->b->val: val');
eq(addr('    g(&node->next->val);', 'node'), false, '&a->..: node (base)');
eq(addr('    h(&arr[i].field);', 'field'), true, '&arr[i].field: field');
eq(addr('    h(&arr[i].field);', 'arr'), false, '&arr[i].field: arr (base)');

console.log('# address-of — PARENTHESISED');
eq(addr('    p = &(x);', 'x'), true, '&(x)');
eq(addr('    p = &( x );', 'x'), true, '&( x ) spaces');
eq(addr('    p = &((x));', 'x'), true, '&((x)) nested');
eq(addr('    p = &(((x)));', 'x'), true, '&(((x))) deep');
eq(addr('    f(&(x));', 'x'), true, 'f(&(x)) as arg');
eq(addr('    return &(node);', 'node'), true, 'return &(node)');
eq(addr('    p = &(cfg.field);', 'field'), true, '&(cfg.field): field');
eq(addr('    p = &(cfg.field);', 'cfg'), false, '&(cfg.field): cfg (base)');
eq(addr('    p = &( cfg.field );', 'field'), true, '&( cfg.field ): field (spaces)');
eq(addr('    p = &(p->a->b);', 'b'), true, '&(p->a->b): b');
eq(addr('    p = &(p->a->b);', 'p'), false, '&(p->a->b): p (base)');
eq(addr('    p = &(s.a.b.c);', 'c'), true, '&(s.a.b.c): c');
eq(addr('    h(&(arr[i].field));', 'field'), true, '&(arr[i].field): field');
// parenthesised BASE, member outside: &(expr).field == &((expr).field)
eq(addr('    p = &(cfg).field;', 'field'), true, '&(cfg).field: field');
eq(addr('    p = &(cfg).field;', 'cfg'), false, '&(cfg).field: cfg (base, not address)');
eq(addr('    p = &(a.b).c;', 'c'), true, '&(a.b).c: c');
// NOT address-of even with parens
eq(addr('    z = a & (x);', 'x'), false, 'a & (x) (bitwise)');
eq(addr('    z = (a) & x;', 'x'), false, '(a) & x (bitwise)');
eq(addr('    z = a & (b);', 'b'), false, 'a & (b) (bitwise)');
eq(addr('    foo((x));', 'x'), false, 'foo((x)) arg (not address)');
eq(addr('    g(&node->arr[k]);', 'k'), false, '&node->arr[k]: k index');

console.log('# address-of — ARRAYS & POINTERS');
eq(addr('    p = &arr[i];', 'arr'), false, '&arr[i]: arr (element, base)');
eq(addr('    p = &arr[i];', 'i'), false, '&arr[i]: i (index, read)');
eq(addr('    p = &(arr[i]);', 'arr'), false, '&(arr[i]): arr (base)');
eq(addr('    p = &arr[i].field;', 'field'), true, '&arr[i].field: field');
eq(addr('    p = &arr[i].field;', 'arr'), false, '&arr[i].field: arr (base)');
eq(addr('    p = &arr[i][j];', 'arr'), false, '&arr[i][j]: arr (base)');
eq(addr('    p = &grid[r][c];', 'grid'), false, '&grid[r][c]: grid (base)');
eq(addr('    p = &m.rows[i];', 'rows'), false, '&m.rows[i]: rows (base)');
eq(addr('    p = &q->field;', 'field'), true, '&q->field: field');
eq(addr('    p = &q->field;', 'q'), false, '&q->field: q (base)');
eq(addr('    p = &q->a->b;', 'b'), true, '&q->a->b: b');
eq(addr('    p = &q->a->b;', 'q'), false, '&q->a->b: q (base)');
eq(addr('    p = &*q;', 'q'), false, '&*q: q (deref, not address)');
eq(addr('    p = &(*q);', 'q'), false, '&(*q): q (deref)');
eq(addr('    p = &(*q).field;', 'field'), true, '&(*q).field: field');
eq(addr('    p = &(*q).field;', 'q'), false, '&(*q).field: q (base)');
eq(addr('    p = &q->arr[i];', 'q'), false, '&q->arr[i]: q (base)');

console.log('# address-of — MULTI-ADDRESS (several & per line)');
eq(addr('    f(&a, &b);', 'a'), true, 'f(&a, &b): a');
eq(addr('    f(&a, &b);', 'b'), true, 'f(&a, &b): b');
eq(addr('    swap(&x, &y);', 'x'), true, 'swap(&x, &y): x');
eq(addr('    swap(&x, &y);', 'y'), true, 'swap(&x, &y): y');
eq(addr('    p = &a.x + &b.y;', 'x'), true, '&a.x + &b.y: x');
eq(addr('    p = &a.x + &b.y;', 'y'), true, '&a.x + &b.y: y');
eq(addr('    memcpy(&dst, &src, n);', 'dst'), true, 'memcpy(&dst, &src): dst');
eq(addr('    memcpy(&dst, &src, n);', 'src'), true, 'memcpy(&dst, &src): src');
eq(addr('    g(&a->b, &c->d);', 'b'), true, 'g(&a->b, &c->d): b');
eq(addr('    g(&a->b, &c->d);', 'd'), true, 'g(&a->b, &c->d): d');

console.log('# read/write heuristic');
eq(kind('    g_state = 0;', 'g_state'), RefKind.Write, 'g_state = 0 -> W');
eq(kind('    int s = g_state;', 'g_state'), RefKind.Read, 'rhs g_state -> R');
eq(kind('    g_counter += d;', 'g_counter'), RefKind.Write, 'g_counter += -> W');
eq(kind('    g_cfg.flags |= f;', 'flags'), RefKind.Write, 'flags |= -> W');
eq(kind('    if (g_state > 100) {', 'g_state'), RefKind.Read, 'g_state > 100 -> R');
eq(kind('    cfg_get_mode();', 'cfg_get_mode'), RefKind.Unknown, 'call -> Unknown');
eq(kind('    ++g_counter;', 'g_counter'), RefKind.Write, 'pre-increment -> W');
eq(kind('    arr[i] = x;', 'arr'), RefKind.Write, 'arr[i] = x -> W');
eq(kind('    y = arr[i];', 'arr'), RefKind.Read, 'rhs arr[i] -> R');
eq(kind('    arr[i]++;', 'arr'), RefKind.Write, 'arr[i]++ -> W');
eq(kind('    m.cells[i][j] = v;', 'cells'), RefKind.Write, 'cells[i][j] = -> W');
eq(kind('    total += arr[i];', 'arr'), RefKind.Read, 'rhs arr[i] (+=) -> R');
eq(kind('    return tbl[k];', 'tbl'), RefKind.Read, 'return tbl[k] -> R');

console.log('# glob / regex / contains');
eq(matchGlob('a/test/b.c', '**/test/**'), true, '**/test/** matches a/test/b.c');
eq(matchGlob('a/mytest/b.c', '**/test/**'), false, '**/test/** excludes mytest');
eq(matchGlob('src/net/foo.c', 'src/net/**'), true, 'src/net/**');
eq(matchGlob('src/drv_3.c', '/drv_\\d+/'), true, 'regex /drv_\\d+/');
eq(matchesQuery('bus', ['bus_write', 'x.c']), true, 'contains name');
eq(matchesQuery('net', ['foo', 'src/net/x.c']), true, 'contains path');
eq(matchesQuery('zzz', ['foo', 'src/x.c']), false, 'contains none');
eq(matchesQuery('bus*', ['bus_write', 'x.c']), true, 'glob name');

console.log('# call-site cursor (×N walk — per-node, no leak)');
{
  const A = 'A|file', B = 'B|file';
  // Re-clicking "Open in editor" on the SAME ×N node walks its sites & wraps.
  let c = nextSiteIndex(undefined, A, 3);
  eq([c.index, c.total], [0, 3], 'A: first click → site 1/3');
  c = nextSiteIndex(c, A, 3);
  eq(c.index, 1, 'A: re-click → site 2');
  c = nextSiteIndex(c, A, 3);
  eq(c.index, 2, 'A: re-click → site 3');
  c = nextSiteIndex(c, A, 3);
  eq(c.index, 0, 'A: re-click wraps → site 1');
  // Switching to a DIFFERENT node restarts at site 0 (the reported bug fix:
  // walk state must not leak from one node into another).
  let walkedA = nextSiteIndex(nextSiteIndex(undefined, A, 3), A, 3); // A now at site 2
  eq(walkedA.index, 1, 'A: walked to site 2 before switching');
  const onB = nextSiteIndex(walkedA, B, 2);
  eq(onB.index, 0, 'switch A→B restarts at site 1 (no leak from A)');
  const backA = nextSiteIndex(onB, A, 3);
  eq(backA.index, 0, 'switch B→A restarts at site 1 (cursor was on B)');
  // A single-site node always opens its one site, no matter the prior cursor.
  eq(nextSiteIndex(undefined, A, 1).index, 0, 'single site → 0');
  eq(nextSiteIndex({ key: A, index: 0 }, A, 1).index, 0, 'single site stays at 0');
  eq(nextSiteIndex({ key: B, index: 5 }, A, 0).index, 0, 'no sites (total 0) → 0');
  // Enter-walk seeding: a selection change seeds {key, 0} (the arrow-preview
  // already shows site 0), so the FIRST Enter advances to site 1, the next to 2.
  eq(nextSiteIndex({ key: A, index: 0 }, A, 3).index, 1, 'seeded at 0 (arrow preview) → first Enter → site 2');
  eq(nextSiteIndex({ key: A, index: 1 }, A, 3).index, 2, 'next Enter → site 3');
}

console.log('# query highlights (filter-match emphasis in the call tree)');
eq(queryHighlights('bus_write', 'bus'), [[0, 3]], 'contains at start → [0,3]');
eq(queryHighlights('bus_write', 'BUS'), [[0, 3]], 'contains is case-insensitive');
eq(queryHighlights('bus_write', 'write'), [[4, 9]], 'contains mid-name → [4,9]');
eq(queryHighlights('banana', 'a'), [[1, 2], [3, 4], [5, 6]], 'all occurrences highlighted');
eq(queryHighlights('bus_write', 'xyz'), [], 'no match → []');
eq(queryHighlights('drv_3', '/drv_\\d+/'), [[0, 5]], 'regex /drv_\\d+/ → [0,5]');
eq(queryHighlights('a1b2', '/\\d/'), [[1, 2], [3, 4]], 'regex matches all (implicit g)');
eq(queryHighlights('bus_write', 'bus*'), [], 'glob → [] (matches path, not a name substring)');
eq(queryHighlights('bus_write', ''), [], 'empty query → []');
eq(queryHighlights('', 'bus'), [], 'empty text → []');
eq(queryHighlights('bus', '/[/'), [], 'malformed regex → []');

console.log(fail === 0 ? `\nALL PASS (logic)` : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
