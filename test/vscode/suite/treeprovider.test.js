/* Drives the REAL CallTreeProvider (exposed by the extension's activate()) and
 * inspects the actual `command.arguments` each tree node would open — catching
 * any wiring bug the data-only tests miss. Expected per the user's choice:
 *   root   → the function's DEFINITION (its .c body)
 *   caller → the CALL SITE in the caller (where the caller calls the fn)
 *   callee → the CALL SITE in the inspected fn (where it calls the callee)
 */
const assert = require('assert');
const vscode = require('vscode');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROVIDER = (process.env.PROVIDER || 'clangd').toLowerCase();
const PROVIDER_EXT =
  PROVIDER === 'cpptools' ? 'ms-vscode.cpptools' : 'llvm-vs-code-extensions.vscode-clangd';

function bareName(name) {
  return name.replace(/\(.*$/, '').replace(/.*[\s:*&]/, '').trim();
}

// The call-tree node's command is nextCallSite([node]) (so Enter acts on the
// focused node); derive the uri+range it opens from the node, mirroring the
// extension's nodeTarget().
function nodeTarget(node) {
  const hasCall = node.fromRanges.length > 0 && !!node.callUri;
  return hasCall
    ? { uri: node.callUri, range: node.fromRanges[0] }
    : { uri: node.item.uri, range: node.item.selectionRange };
}

suite(`real CallTreeProvider — click targets [${PROVIDER}]`, () => {
  test('root → definition, caller → call site, callee → call site', async function () {
    this.timeout(240000);

    await vscode.extensions.getExtension(PROVIDER_EXT).activate();
    const me = vscode.extensions.getExtension('halistahasahin.c-call-hierarchy-references');
    assert.ok(me, 'extension under test is present');
    const api = await me.activate();
    assert.ok(api && api.tree, 'activate() exposes the tree provider');
    const tree = api.tree;

    const root = vscode.workspace.workspaceFolders[0].uri;
    const appc = vscode.Uri.joinPath(root, 'src', 'app.c');
    const doc = await vscode.workspace.openTextDocument(appc);
    await vscode.window.showTextDocument(doc, { preview: false });
    const lines = doc.getText().split(/\r?\n/);
    const defLine = lines.findIndex((l) => /\bvoid\s+dispatch\s*\(/.test(l) && l.includes('{'));
    const pos = new vscode.Position(defLine, lines[defLine].indexOf('dispatch'));

    let items = [];
    for (let i = 0; i < 60 && items.length === 0; i++) {
      await sleep(2000);
      items = (await vscode.commands.executeCommand('vscode.prepareCallHierarchy', appc, pos)) || [];
    }
    assert.ok(items.length > 0, 'prepareCallHierarchy resolved dispatch');

    tree.setRoots(items);
    const rootNode = tree.getRoots()[0];

    // helper: read the file line a node's command target points at (the command
    // arg is [node]; nodeTarget derives the uri+range it opens).
    async function lineAt(cmdArgs) {
      const { uri, range } = nodeTarget(cmdArgs[0]);
      assert.ok(uri instanceof vscode.Uri, 'target uri is a Uri');
      assert.ok(range && range.start, 'target has a Range');
      const d = await vscode.workspace.openTextDocument(uri);
      return { uri, line: d.lineAt(range.start.line).text, lineNo: range.start.line + 1 };
    }

    // ---- ROOT → definition ----
    const rootTi = await tree.getTreeItem(rootNode);
    const r = await lineAt(rootTi.command.arguments);
    assert.ok(!r.uri.fsPath.toLowerCase().endsWith('.h'), `root → .c, got ${r.uri.fsPath}`);
    assert.ok(/\bdispatch\s*\(/.test(r.line) && r.line.includes('{'), `root → definition: "${r.line.trim()}"`);

    // ---- CALLERS (incoming): caller → call site in the caller ----
    if (tree.getDirection() !== 'incoming') tree.toggleDirection();
    const callers = await tree.getChildren(rootNode);
    assert.ok(callers.length > 0, `dispatch has callers (got ${callers.length})`);
    for (const node of callers) {
      const ti = await tree.getTreeItem(node);
      const x = await lineAt(ti.command.arguments);
      assert.ok(
        x.line.includes('dispatch'),
        `caller ${node.item.name} call site (${x.uri.fsPath.split(/[\\/]/).pop()}:${x.lineNo}) calls dispatch: "${x.line.trim()}"`,
      );
    }

    // ---- CALLEES (outgoing): callee → call site in dispatch (app.c) ----
    tree.toggleDirection();
    const callees = await tree.getChildren(rootNode);
    assert.ok(callees.length > 0, `dispatch has callees (got ${callees.length})`);
    for (const node of callees) {
      const ti = await tree.getTreeItem(node);
      const x = await lineAt(ti.command.arguments);
      assert.strictEqual(x.uri.fsPath, appc.fsPath, `callee call site is in dispatch's file (app.c)`);
      const name = bareName(node.item.name);
      assert.ok(
        x.line.includes(name),
        `callee ${name} call site (app.c:${x.lineNo}) calls it: "${x.line.trim()}"`,
      );
    }

    console.log(
      `  real tree: root→def, ${callers.length} caller→call site, ${callees.length} callee→call site (all assert ✔)`,
    );
  });

  // Repro: call hierarchy invoked on a HEADER DECLARATION (hal_0.h: `int hal0_f3(int x);`).
  // Clicking a callee (bus_read) must still go to the CALL SITE in hal_0.c (where
  // hal0_f3 calls bus_read), NOT to bus_read's definition in bus.c.
  test('invoked on a header declaration → callee click goes to the call site', async function () {
    this.timeout(240000);
    await vscode.extensions.getExtension(PROVIDER_EXT).activate();
    const me = vscode.extensions.getExtension('halistahasahin.c-call-hierarchy-references');
    const tree = (await me.activate()).tree;

    const root = vscode.workspace.workspaceFolders[0].uri;
    const halh = vscode.Uri.joinPath(root, 'include', 'hal_0.h');
    const halc = vscode.Uri.joinPath(root, 'src', 'hal_0.c');
    const doc = await vscode.workspace.openTextDocument(halh);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const lines = doc.getText().split(/\r?\n/);
    const declLine = lines.findIndex((l) => /\bhal0_f3\s*\(/.test(l) && l.trim().endsWith(';'));
    assert.ok(declLine >= 0, 'found hal0_f3 declaration in hal_0.h');
    const pos = new vscode.Position(declLine, lines[declLine].indexOf('hal0_f3'));
    editor.selection = new vscode.Selection(pos, pos);

    // wait until clangd answers on this position
    let prep = [];
    for (let i = 0; i < 60 && prep.length === 0; i++) {
      await sleep(2000);
      prep = (await vscode.commands.executeCommand('vscode.prepareCallHierarchy', halh, pos)) || [];
    }
    assert.ok(prep.length > 0, 'clangd resolved hal0_f3 from its declaration');

    // Use the REAL extension flow: showHierarchy → h.prepare (re-anchors a header
    // declaration to the definition so outgoing call sites survive).
    await vscode.window.showTextDocument(doc, { preview: false });
    editor.selection = new vscode.Selection(pos, pos);
    try {
      await vscode.commands.executeCommand('cCallHierarchyReferences.showHierarchy');
    } catch {
      /* reveal may reject in headless; roots are already set */
    }
    const rootNode = tree.getRoots()[0];
    assert.ok(rootNode, 'showHierarchy set a root');
    console.log(
      `  root item: ${rootNode.item.uri.fsPath.split(/[\\/]/).pop()}:${rootNode.item.selectionRange.start.line + 1}`,
    );
    assert.strictEqual(
      rootNode.item.uri.fsPath,
      halc.fsPath,
      'root re-anchored from the header declaration to the .c definition',
    );

    if (tree.getDirection() !== 'outgoing') tree.toggleDirection();
    const callees = await tree.getChildren(rootNode);
    const busRead = callees.find((n) => /bus_read/.test(n.item.name));
    assert.ok(busRead, `bus_read is a callee (got: ${callees.map((c) => c.item.name).join(', ')})`);

    const ti = await tree.getTreeItem(busRead);
    const { uri: u, range } = nodeTarget(ti.command.arguments[0]);
    const tdoc = await vscode.workspace.openTextDocument(u);
    const line = tdoc.lineAt(range.start.line).text;
    console.log(`  bus_read click → ${u.fsPath.split(/[\\/]/).pop()}:${range.start.line + 1} "${line.trim()}"`);
    assert.strictEqual(
      u.fsPath,
      halc.fsPath,
      `bus_read click must go to the CALL SITE in hal_0.c, not its definition`,
    );
    assert.ok(line.includes('bus_read'), `landing line calls bus_read: "${line.trim()}"`);
  });

  // The inline "Open in editor" action opens the node's target in a real editor
  // (focus moves there). Selecting a node only previews (focus stays in the tree)
  // — preview keeps focus, so it isn't asserted here.
  test('"Open in editor" action navigates to the node target and activates the editor', async function () {
    this.timeout(180000);
    await vscode.extensions.getExtension(PROVIDER_EXT).activate();
    const me = vscode.extensions.getExtension('halistahasahin.c-call-hierarchy-references');
    const t = (await me.activate()).tree;

    const root = vscode.workspace.workspaceFolders[0].uri;
    const appc = vscode.Uri.joinPath(root, 'src', 'app.c');
    const doc = await vscode.workspace.openTextDocument(appc);
    await vscode.window.showTextDocument(doc, { preview: false });
    const lines = doc.getText().split(/\r?\n/);
    const defLine = lines.findIndex((l) => /\bvoid\s+dispatch\s*\(/.test(l) && l.includes('{'));
    const pos = new vscode.Position(defLine, lines[defLine].indexOf('dispatch'));

    let items = [];
    for (let i = 0; i < 60 && items.length === 0; i++) {
      await sleep(2000);
      items = (await vscode.commands.executeCommand('vscode.prepareCallHierarchy', appc, pos)) || [];
    }
    assert.ok(items.length > 0, 'resolved dispatch');
    t.setRoots(items);
    const rootNode = t.getRoots()[0];
    if (t.getDirection() !== 'outgoing') t.toggleDirection();
    const callees = await t.getChildren(rootNode);
    assert.ok(callees.length > 0, 'dispatch has callees');

    const node = callees[0];
    const { uri: expUri, range: expRange } = nodeTarget((await t.getTreeItem(node)).command.arguments[0]);
    await vscode.commands.executeCommand('cCallHierarchyReferences.openReferenceInEditor', node);

    const ed = vscode.window.activeTextEditor;
    assert.ok(ed, 'an editor is active after Open in editor');
    assert.strictEqual(ed.document.uri.fsPath, expUri.fsPath, 'opened the node target file');
    assert.strictEqual(ed.selection.start.line, expRange.start.line, 'selected the call-site line');
    console.log(
      `  open-in-editor → ${ed.document.uri.fsPath.split(/[\\/]/).pop()}:${ed.selection.start.line + 1} (editor active) ✔`,
    );
  });
});
