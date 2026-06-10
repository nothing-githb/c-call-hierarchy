/* Scenarios around "where you invoke call hierarchy from" — the root must always
 * re-anchor to the function's DEFINITION so callee→call-site (and root→def)
 * navigation works whether you start from:
 *   - a header DECLARATION (prototype in a .h),
 *   - a USAGE / call site (in some other .c),
 *   - the DEFINITION itself.
 * Drives the REAL extension flow (cCallHierarchyReferences.showHierarchy → h.prepare) and
 * inspects the actual command.arguments of each tree node. */
const assert = require('assert');
const vscode = require('vscode');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROVIDER = (process.env.PROVIDER || 'clangd').toLowerCase();
const PROVIDER_EXT =
  PROVIDER === 'cpptools' ? 'ms-vscode.cpptools' : 'llvm-vs-code-extensions.vscode-clangd';
const bareName = (n) => n.replace(/\(.*$/, '').replace(/.*[\s:*&]/, '').trim();

let tree;
async function getTree() {
  if (tree) return tree;
  await vscode.extensions.getExtension(PROVIDER_EXT).activate();
  const me = vscode.extensions.getExtension('halistahasahin.c-call-hierarchy-references');
  tree = (await me.activate()).tree;
  return tree;
}

// Open `fileUri`, place the cursor at findPos(lines), run the real showHierarchy
// command, and return the root CallNode the extension produced.
async function showHierarchyAt(fileUri, findPos) {
  const t = await getTree();
  const doc = await vscode.workspace.openTextDocument(fileUri);
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  const lines = doc.getText().split(/\r?\n/);
  const pos = findPos(lines);
  assert.ok(pos, `found target position in ${fileUri.fsPath}`);
  editor.selection = new vscode.Selection(pos, pos);

  let prep = [];
  for (let i = 0; i < 60 && prep.length === 0; i++) {
    await sleep(2000);
    prep = (await vscode.commands.executeCommand('vscode.prepareCallHierarchy', fileUri, pos)) || [];
  }
  assert.ok(prep.length > 0, `clangd/cpptools resolved the symbol at the cursor`);

  await vscode.window.showTextDocument(doc, { preview: false });
  editor.selection = new vscode.Selection(pos, pos);
  try {
    await vscode.commands.executeCommand('cCallHierarchyReferences.showHierarchy');
  } catch {
    /* reveal may reject headless; roots are set regardless */
  }
  return t.getRoots()[0];
}

async function lineAtCmd(cmdArgs) {
  const [uri, range] = cmdArgs;
  assert.ok(uri instanceof vscode.Uri && range && range.start, 'command args are [Uri, Range]');
  const d = await vscode.workspace.openTextDocument(uri);
  return { uri, line: d.lineAt(range.start.line).text, lineNo: range.start.line + 1 };
}

// callee → a call site inside the DEFINITION file (line actually calls the callee)
async function assertCalleesAreCallSites(rootNode, defUri) {
  if (tree.getDirection() !== 'outgoing') tree.toggleDirection();
  const callees = await tree.getChildren(rootNode);
  for (const n of callees) {
    const x = await lineAtCmd((await tree.getTreeItem(n)).command.arguments);
    assert.strictEqual(
      x.uri.fsPath,
      defUri.fsPath,
      `callee ${n.item.name} call site must be in the definition file`,
    );
    const name = bareName(n.item.name);
    assert.ok(x.line.includes(name), `callee ${name} call site (${x.lineNo}): "${x.line.trim()}"`);
  }
  return callees.length;
}

// caller → a call site (line actually calls the inspected function)
async function assertCallersAreCallSites(rootNode, fnName) {
  if (tree.getDirection() !== 'incoming') tree.toggleDirection();
  const callers = await tree.getChildren(rootNode);
  for (const n of callers) {
    const x = await lineAtCmd((await tree.getTreeItem(n)).command.arguments);
    assert.ok(
      x.line.includes(fnName),
      `caller ${n.item.name} call site (${x.uri.fsPath.split(/[\\/]/).pop()}:${x.lineNo}) calls ${fnName}: "${x.line.trim()}"`,
    );
  }
  return callers.length;
}

async function assertRootIsDefinition(rootNode, defUri, fnRe) {
  assert.strictEqual(rootNode.item.uri.fsPath, defUri.fsPath, 'root re-anchored to the definition file');
  const x = await lineAtCmd((await tree.getTreeItem(rootNode)).command.arguments);
  assert.strictEqual(x.uri.fsPath, defUri.fsPath, 'root click opens the definition file');
  assert.ok(fnRe.test(x.line) && x.line.includes('{'), `root click → definition body: "${x.line.trim()}"`);
}

const root = () => vscode.workspace.workspaceFolders[0].uri;
const U = (...p) => vscode.Uri.joinPath(root(), ...p);
const declFinder = (fn) => (lines) => {
  // a prototype line: calls out the name, has a ';', no body '{' (tolerates a trailing comment)
  const i = lines.findIndex(
    (l) => new RegExp(`\\b${fn}\\s*\\(`).test(l) && l.includes(';') && !l.includes('{'),
  );
  return i >= 0 ? new vscode.Position(i, lines[i].indexOf(fn)) : null;
};
const usageFinder = (fn) => (lines) => {
  const i = lines.findIndex((l) => new RegExp(`=\\s*${fn}\\s*\\(`).test(l));
  return i >= 0 ? new vscode.Position(i, lines[i].indexOf(fn)) : null;
};

suite(`invocation-site scenarios [${PROVIDER}]`, () => {
  test('header decl (hal0_f3 in hal_0.h): root→def, callees & callers → call sites', async function () {
    this.timeout(240000);
    const halc = U('src', 'hal_0.c');
    const rootNode = await showHierarchyAt(U('include', 'hal_0.h'), declFinder('hal0_f3'));
    await assertRootIsDefinition(rootNode, halc, /\bhal0_f3\s*\(/);
    const nCallees = await assertCalleesAreCallSites(rootNode, halc);
    const nCallers = await assertCallersAreCallSites(rootNode, 'hal0_f3');
    assert.ok(nCallees > 0, 'hal0_f3 has callees');
    assert.ok(nCallers > 0, 'hal0_f3 has callers');
    console.log(`  hal0_f3 (header decl): root→def, ${nCallers} callers, ${nCallees} callees ✔`);
  });

  test('header decl (dispatch in app.h): root→def, callees → call sites', async function () {
    this.timeout(240000);
    const appc = U('src', 'app.c');
    const rootNode = await showHierarchyAt(U('include', 'app.h'), declFinder('dispatch'));
    await assertRootIsDefinition(rootNode, appc, /\bdispatch\s*\(/);
    const nCallees = await assertCalleesAreCallSites(rootNode, appc);
    assert.ok(nCallees > 0, 'dispatch has callees');
    console.log(`  dispatch (header decl): root→def, ${nCallees} callees ✔`);
  });

  test('header decl (bus_read in bus.h, a leaf hub): root→def, callers → call sites', async function () {
    this.timeout(240000);
    const busc = U('src', 'bus.c');
    const rootNode = await showHierarchyAt(U('include', 'bus.h'), declFinder('bus_read'));
    await assertRootIsDefinition(rootNode, busc, /\bbus_read\s*\(/);
    const nCallers = await assertCallersAreCallSites(rootNode, 'bus_read');
    assert.ok(nCallers > 0, 'bus_read has callers');
    console.log(`  bus_read (header decl): root→def, ${nCallers} callers ✔`);
  });

  test('usage (hal0_f3 called inside drv_0.c): root re-anchors to def, callees → call sites', async function () {
    this.timeout(240000);
    const halc = U('src', 'hal_0.c');
    const rootNode = await showHierarchyAt(U('src', 'drv_0.c'), usageFinder('hal0_f3'));
    await assertRootIsDefinition(rootNode, halc, /\bhal0_f3\s*\(/);
    const nCallees = await assertCalleesAreCallSites(rootNode, halc);
    assert.ok(nCallees > 0, 'hal0_f3 has callees (from a usage-site invocation)');
    console.log(`  hal0_f3 (usage in drv_0.c): root→def, ${nCallees} callees ✔`);
  });

  // The definition lives IN the header (static inline) — re-anchor must NOT move
  // it away; callee navigation must use the header's own call sites.
  test('header-DEFINED static inline (edge_inline in edge.h): stays in the header', async function () {
    this.timeout(240000);
    const edgeh = U('include', 'edge.h');
    const rootNode = await showHierarchyAt(edgeh, (lines) => {
      const i = lines.findIndex((l) => /\bedge_inline\s*\(/.test(l) && l.includes('{'));
      return i >= 0 ? new vscode.Position(i, lines[i].indexOf('edge_inline')) : null;
    });
    assert.strictEqual(
      rootNode.item.uri.fsPath,
      edgeh.fsPath,
      'header-defined function must stay anchored in the header (not re-anchored away)',
    );
    const rootX = await lineAtCmd((await tree.getTreeItem(rootNode)).command.arguments);
    assert.strictEqual(rootX.uri.fsPath, edgeh.fsPath, 'root click stays in edge.h (its definition)');
    const nCallees = await assertCalleesAreCallSites(rootNode, edgeh);
    assert.ok(nCallees > 0, 'edge_inline calls util_mix');
    console.log(`  edge_inline (header-defined): root in edge.h, ${nCallees} callee call sites ✔`);
  });

  // Isolated function: declared in a header, defined in .c, calls nothing and is
  // called by nobody.
  test('isolated function (edge_orphan): root→def, no callers, no callees', async function () {
    this.timeout(240000);
    const edgec = U('src', 'edge.c');
    const rootNode = await showHierarchyAt(U('include', 'edge.h'), declFinder('edge_orphan'));
    await assertRootIsDefinition(rootNode, edgec, /\bedge_orphan\s*\(/);
    if (tree.getDirection() !== 'incoming') tree.toggleDirection();
    const callers = await tree.getChildren(rootNode);
    tree.toggleDirection();
    const callees = await tree.getChildren(rootNode);
    assert.strictEqual(callers.length, 0, 'edge_orphan has no callers');
    assert.strictEqual(callees.length, 0, 'edge_orphan has no callees');
    console.log(`  edge_orphan: root→def, 0 callers, 0 callees ✔`);
  });

  // Same name, two files: each static `dup_local` resolves to its own file.
  test('same-name file-local functions (dup_local) resolve per file', async function () {
    this.timeout(240000);
    for (const tag of ['a', 'b']) {
      const dupc = U('src', `dup_${tag}.c`);
      const rootNode = await showHierarchyAt(dupc, (lines) => {
        const i = lines.findIndex((l) => /\bdup_local\s*\(/.test(l) && l.includes('{'));
        return i >= 0 ? new vscode.Position(i, lines[i].indexOf('dup_local')) : null;
      });
      assert.strictEqual(
        rootNode.item.uri.fsPath,
        dupc.fsPath,
        `dup_local invoked in dup_${tag}.c resolves to that file's symbol`,
      );
    }
    console.log(`  dup_local: resolves to its own file in dup_a.c and dup_b.c ✔`);
  });
});
