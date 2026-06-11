/* Does call hierarchy resolve a function call hidden inside a function-like
 * MACRO? mac_user() calls util_log via MAC_LOG and bus_write via MAC_WRITE, plus
 * a plain bus_read for contrast. Reports what the provider returns and where the
 * call site lands, then asserts the macro-hidden calls resolve. */
const assert = require('assert');
const vscode = require('vscode');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROVIDER = (process.env.PROVIDER || 'clangd').toLowerCase();
const PROVIDER_EXT =
  PROVIDER === 'cpptools' ? 'ms-vscode.cpptools' : 'llvm-vs-code-extensions.vscode-clangd';
const bareName = (n) => n.replace(/\(.*$/, '').replace(/.*[\s:*&]/, '').trim();

// The call-tree node command is nextCallSite([node]); derive its target.
function nodeTarget(node) {
  const hasCall = node.fromRanges.length > 0 && !!node.callUri;
  return hasCall
    ? { uri: node.callUri, range: node.fromRanges[0] }
    : { uri: node.item.uri, range: node.item.selectionRange };
}

suite(`macro-hidden calls [${PROVIDER}]`, () => {
  test('mac_user: calls hidden in macros resolve as callees', async function () {
    this.timeout(240000);
    await vscode.extensions.getExtension(PROVIDER_EXT).activate();
    const me = vscode.extensions.getExtension('halistahasahin.c-call-hierarchy-references');
    const tree = (await me.activate()).tree;

    const root = vscode.workspace.workspaceFolders[0].uri;
    const macc = vscode.Uri.joinPath(root, 'src', 'mac.c');
    const doc = await vscode.workspace.openTextDocument(macc);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const lines = doc.getText().split(/\r?\n/);
    const defLine = lines.findIndex((l) => /\bmac_user\s*\(/.test(l) && l.includes('{'));
    const pos = new vscode.Position(defLine, lines[defLine].indexOf('mac_user'));
    editor.selection = new vscode.Selection(pos, pos);

    let prep = [];
    for (let i = 0; i < 60 && prep.length === 0; i++) {
      await sleep(2000);
      prep = (await vscode.commands.executeCommand('vscode.prepareCallHierarchy', macc, pos)) || [];
    }
    assert.ok(prep.length > 0, 'resolved mac_user');

    await vscode.window.showTextDocument(doc, { preview: false });
    editor.selection = new vscode.Selection(pos, pos);
    try {
      await vscode.commands.executeCommand('cCallHierarchyReferences.showHierarchy');
    } catch {
      /* reveal may reject headless */
    }
    const rootNode = tree.getRoots()[0];
    if (tree.getDirection() !== 'outgoing') tree.toggleDirection();
    const callees = await tree.getChildren(rootNode);

    const found = {};
    for (const n of callees) {
      const name = bareName(n.item.name);
      const { uri: u, range } = nodeTarget((await tree.getTreeItem(n)).command.arguments[0]);
      const d = await vscode.workspace.openTextDocument(u);
      (found[name] = found[name] || []).push({
        file: u.fsPath.split(/[\\/]/).pop(),
        lineNo: range.start.line + 1,
        line: d.lineAt(range.start.line).text.trim(),
      });
    }
    console.log(`  mac_user callees (${PROVIDER}): ${Object.keys(found).join(', ') || '(none)'}`);
    for (const [k, sites] of Object.entries(found)) {
      for (const s of sites) console.log(`    ${k} → ${s.file}:${s.lineNo}  "${s.line}"`);
    }

    // sanity: the plain (non-macro) call resolves
    assert.ok(found['bus_read'], 'plain bus_read call is a callee');
    // the real question: do macro-hidden calls resolve?
    assert.ok(found['util_log'], 'util_log (hidden in MAC_LOG) resolves as a callee');
    assert.ok(found['bus_write'], 'bus_write (hidden in MAC_WRITE) resolves as a callee');

    // and the macro-call click should land at the macro USE site in mac.c
    const logSites = found['util_log'] || [];
    assert.ok(
      logSites.some((s) => s.file === 'mac.c' && /MAC_LOG|util_log/.test(s.line)),
      `util_log call site lands at the macro use in mac.c (got: ${JSON.stringify(logSites)})`,
    );
    console.log(`  macro-hidden calls resolve ✔`);
  });
});
