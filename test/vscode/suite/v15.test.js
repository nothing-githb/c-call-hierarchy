/* Tests for the v0.1.15 changes:
 *  - call-tree symbol icons are coloured with the theme's symbolIcon.* colours
 *  - a ×N (multi call-site) node is contextValue `…Multi` + goToCallSite command
 *  - References in folder grouping render the top folder levels Expanded
 * Drives the REAL providers exposed by the extension's activate(). */
const assert = require('assert');
const vscode = require('vscode');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROVIDER = (process.env.PROVIDER || 'clangd').toLowerCase();
const PROVIDER_EXT =
  PROVIDER === 'cpptools' ? 'ms-vscode.cpptools' : 'llvm-vs-code-extensions.vscode-clangd';

async function dispatchRoots(tree) {
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
  return tree.getRoots()[0];
}

suite(`v0.1.15 features [${PROVIDER}]`, () => {
  let api, tree;
  suiteSetup(async function () {
    this.timeout(180000);
    await vscode.extensions.getExtension(PROVIDER_EXT).activate();
    api = await vscode.extensions.getExtension('halistahasahin.c-call-hierarchy-references').activate();
    tree = api.tree;
  });

  test('symbol icons are coloured with theme symbolIcon.* colours', async function () {
    this.timeout(180000);
    const rootNode = await dispatchRoots(tree);
    const ti = await tree.getTreeItem(rootNode);
    assert.ok(ti.iconPath instanceof vscode.ThemeIcon, 'iconPath is a ThemeIcon');
    assert.strictEqual(ti.iconPath.id, 'symbol-function', 'uses the function symbol codicon');
    assert.ok(ti.iconPath.color instanceof vscode.ThemeColor, 'the icon carries a ThemeColor');
    assert.strictEqual(
      ti.iconPath.color.id,
      'symbolIcon.functionForeground',
      'coloured with the theme symbol colour',
    );
    console.log(`  icon ${ti.iconPath.id} / ${ti.iconPath.color.id} ✔`);
  });

  test('×N node is contextValue "…Multi" and goToCallSite is registered', async function () {
    this.timeout(180000);
    const rootNode = await dispatchRoots(tree);
    if (tree.getDirection() !== 'outgoing') tree.toggleDirection();
    const callees = await tree.getChildren(rootNode);

    const cmds = await vscode.commands.getCommands(true);
    assert.ok(cmds.includes('cCallHierarchyReferences.goToCallSite'), 'goToCallSite command registered');

    // clangd MERGES several call sites to the same callee into one ×N node;
    // cpptools instead returns each call site as its own ×1 node. The "…Multi"
    // marker / picker only applies to merged (×N) nodes.
    const multi = callees.find((n) => n.fromRanges.length > 1);
    for (const n of callees) {
      const cv = (await tree.getTreeItem(n)).contextValue;
      const expectMulti = n.fromRanges.length > 1;
      assert.strictEqual(
        /Multi$/.test(cv),
        expectMulti,
        `${n.item.name} ×${n.fromRanges.length}: contextValue "${cv}" Multi=${/Multi$/.test(cv)} expected ${expectMulti}`,
      );
    }
    console.log(
      multi
        ? `  ${multi.item.name} ×${multi.fromRanges.length} → callMulti + goToCallSite ✔`
        : `  provider returns one node per call site (no ×N merge) — goToCallSite registered, no Multi nodes ✔`,
    );
  });

  test('References in folder mode render the top folders Expanded', async function () {
    this.timeout(180000);
    const refs = api.references;
    assert.ok(refs, 'references provider is exposed');
    assert.strictEqual(refs.getGrouping(), 'folder', 'default grouping is folder');

    // bus_write is referenced across many src/*.c files (and its header).
    const root = vscode.workspace.workspaceFolders[0].uri;
    const busc = vscode.Uri.joinPath(root, 'src', 'bus.c');
    const doc = await vscode.workspace.openTextDocument(busc);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const lines = doc.getText().split(/\r?\n/);
    const defLine = lines.findIndex((l) => /\bbus_write\s*\(/.test(l) && l.includes('{'));
    const pos = new vscode.Position(defLine, lines[defLine].indexOf('bus_write'));
    editor.selection = new vscode.Selection(pos, pos);

    let ready = [];
    for (let i = 0; i < 50 && ready.length === 0; i++) {
      await sleep(2000);
      ready = (await vscode.commands.executeCommand('vscode.prepareCallHierarchy', busc, pos)) || [];
    }
    await vscode.window.showTextDocument(doc, { preview: false });
    editor.selection = new vscode.Selection(pos, pos);
    try {
      await vscode.commands.executeCommand('cCallHierarchyReferences.findReferences');
    } catch {
      /* the view-focus step may reject headless; references are still set */
    }

    let roots = [];
    for (let i = 0; i < 30 && roots.length === 0; i++) {
      await sleep(500);
      roots = await refs.getChildren();
    }
    assert.ok(roots.length > 0, 'references populated');
    const folder = roots.find((n) => n.kind === 'folder');
    assert.ok(folder, `a folder node exists (roots: ${roots.map((n) => n.kind).join(', ')})`);
    assert.strictEqual(
      refs.getTreeItem(folder).collapsibleState,
      vscode.TreeItemCollapsibleState.Expanded,
      'a top folder renders Expanded (so Find references shows results directly)',
    );
    console.log(`  references folder "${folder.label}" → Expanded ✔`);
  });
});
