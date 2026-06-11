import * as vscode from 'vscode';
import * as h from './hierarchy';
import { CallTreeProvider, CallNode, nodeTarget } from './treeProvider';
import { ReferencesProvider } from './referencesProvider';
import { FilterPanelProvider } from './filterPanel';
import { nextSiteIndex } from './textutil';
import {
  initFilterState,
  setRuntimeFilter,
  getRuntimeFilter,
} from './filter';

export function activate(
  context: vscode.ExtensionContext,
): {
  tree: CallTreeProvider;
  references: ReferencesProvider;
  setFilter: (query?: string) => void;
  callView: vscode.TreeView<CallNode>;
} {
  initFilterState(context);

  // --- Call hierarchy view ---
  const tree = new CallTreeProvider();
  const callView = vscode.window.createTreeView('cCallHierarchyReferences.tree', {
    treeDataProvider: tree,
    showCollapseAll: true,
  });

  // --- References view ---
  const refProvider = new ReferencesProvider(context.extensionUri);
  const refView = vscode.window.createTreeView('cCallHierarchyReferences.references', {
    treeDataProvider: refProvider,
    showCollapseAll: true,
  });
  refProvider.attachView(refView);

  context.subscriptions.push(callView, refView);

  // Transient "flash" highlight so a clicked reference stands out from nearby ones.
  const flash = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.findMatchBackground'),
    border: '1px solid',
    borderColor: new vscode.ThemeColor('editor.findMatchBorder'),
    borderRadius: '2px',
    overviewRulerColor: new vscode.ThemeColor('editor.findMatchBackground'),
    overviewRulerLane: vscode.OverviewRulerLane.Full,
  });
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push(flash);

  // Reveal a location, select + centre + flash it. `preserveFocus` keeps focus in
  // the tree (preview-while-browsing); the explicit "open in editor" action moves
  // focus and opens a non-preview tab.
  const revealAt = async (
    uri: vscode.Uri,
    range: vscode.Range,
    opts: { preserveFocus: boolean; preview: boolean },
  ): Promise<void> => {
    const editor = await vscode.window.showTextDocument(uri, {
      preserveFocus: opts.preserveFocus,
      preview: opts.preview,
    });
    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    editor.setDecorations(flash, [range]);
    if (flashTimer) {
      clearTimeout(flashTimer);
    }
    flashTimer = setTimeout(() => {
      try {
        editor.setDecorations(flash, []);
      } catch {
        /* editor closed — nothing to clear */
      }
    }, 1500);
  };

  // Per-node cursors for walking a ×N node's merged call sites. `nextSiteIndex`
  // keys each step on the node, so a walk NEVER leaks into another node — acting
  // on a different node always restarts from its first site.
  //   openCursor  — the inline "Open in editor" action: each click opens the next
  //                 site for real (focus moves to the editor).
  //   enterCursor — activating a node (Enter or click) steps to its next call
  //                 site, previewing while focus stays in the tree. The node's own
  //                 command (nextCallSite) drives this, keyed per node, so the
  //                 first activation of a node lands on its first site and a walk
  //                 never leaks into another node.
  const cursorKey = (node: CallNode): string =>
    `${node.key}|${(node.callUri ?? node.item.uri).toString()}`;
  let openCursor: { key: string; index: number } | undefined;
  let enterCursor: { key: string; index: number } | undefined;

  let filterPanel: FilterPanelProvider | undefined;

  const applyPathFilter = async (): Promise<void> => {
    const active = !!getRuntimeFilter();
    await vscode.commands.executeCommand('setContext', 'cCallHierarchyReferences.pathFilterActive', active);
    tree.refresh();
    refProvider.refresh();
    filterPanel?.setValue(getRuntimeFilter());
    callView.message = active ? `Filtered to: ${getRuntimeFilter()}` : undefined;
  };

  // --- Fixed filter pane: live name/path search + reference-kind chips ---
  filterPanel = new FilterPanelProvider(context.extensionUri, {
    onFilter: (value) => {
      setRuntimeFilter(value);
      void applyPathFilter();
    },
    onToggleKind: (cat) => refProvider.toggleKindCategory(cat),
    getKindStates: () => refProvider.kindStates(),
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(FilterPanelProvider.viewType, filterPanel),
  );

  // Reflect the call-tree direction in the view subtitle + a context key (button).
  const syncCallDir = (): void => {
    const outgoing = tree.getDirection() === 'outgoing';
    callView.description = outgoing ? 'callees (outgoing)' : 'callers (incoming)';
    void vscode.commands.executeCommand('setContext', 'cCallHierarchyReferences.callOutgoing', outgoing);
  };
  syncCallDir();

  context.subscriptions.push(
    // ---- Call hierarchy ----
    vscode.commands.registerCommand('cCallHierarchyReferences.showHierarchy', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage('Open a C/C++ file and place the cursor on a symbol.');
        return;
      }
      const items = await h.prepare(editor.document.uri, editor.selection.active);
      if (items.length === 0) {
        vscode.window.showInformationMessage(
          'No call-hierarchy symbol here. Is clangd active and indexing finished?',
        );
        return;
      }
      tree.setRoots(items);
      callView.title = `Call Hierarchy: ${items[0].name}`;
      syncCallDir();
      if (items.length === 1) {
        await callView.reveal(tree.getRoots()[0], { expand: true, focus: true });
      }
    }),

    vscode.commands.registerCommand('cCallHierarchyReferences.toggleDirection', () => {
      tree.toggleDirection();
      syncCallDir();
    }),

    vscode.commands.registerCommand('cCallHierarchyReferences.refresh', () => tree.refresh()),

    // ---- References (read/write) ----
    vscode.commands.registerCommand('cCallHierarchyReferences.findReferences', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      const classified = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Classifying references…' },
        () => h.classifyReferences(editor.document.uri, editor.selection.active),
      );
      refProvider.setReferences(symbolNameAt(editor), classified);
      await vscode.commands.executeCommand('cCallHierarchyReferences.references.focus');
    }),

    vscode.commands.registerCommand('cCallHierarchyReferences.refreshReferences', () => refProvider.refresh()),
    vscode.commands.registerCommand('cCallHierarchyReferences.clearReferences', () => refProvider.clear()),
    // Select/preview: focus stays in the tree so you can keep browsing up/down.
    vscode.commands.registerCommand(
      'cCallHierarchyReferences.openReference',
      (uri: vscode.Uri, range: vscode.Range) =>
        revealAt(uri, range, { preserveFocus: true, preview: true }),
    ),
    // Explicit "open in editor": moves focus and opens a real (non-preview) tab.
    // Invoked from the inline node action, so it receives the CallNode. For a ×N
    // node (several merged call sites), each re-click walks to the NEXT site,
    // wrapping around; the cursor is keyed to the node, so clicking it on a
    // different node starts that node from its first site (no cross-node leak).
    vscode.commands.registerCommand(
      'cCallHierarchyReferences.openReferenceInEditor',
      async (node: CallNode): Promise<{ index: number; total: number }> => {
        const sites = node.fromRanges;
        const hasSites = !!node.callUri && sites.length > 0;
        const r = nextSiteIndex(openCursor, cursorKey(node), hasSites ? sites.length : 1);
        openCursor = { key: r.key, index: r.index };
        const target = hasSites
          ? { uri: node.callUri!, range: sites[r.index] }
          : nodeTarget(node);
        if (r.total > 1) {
          vscode.window.setStatusBarMessage(`Call site ${r.index + 1} / ${r.total}`, 2500);
        }
        await revealAt(target.uri, target.range, { preserveFocus: false, preview: false });
        return { index: r.index, total: r.total };
      },
    ),
    // The call-tree node's command (set as TreeItem.command, so VS Code runs it
    // for the FOCUSED node on Enter — and on click). A ×N node steps to its next
    // merged call site each activation, wrapping; any other node previews its call
    // site / definition. Either way it previews while focus stays in the tree. The
    // node is passed as the argument (so it acts on the node the user is on, not a
    // stale selection); the per-node enterCursor keys the walk so it never leaks
    // into another node. Returns the resolved target so tests can assert it.
    vscode.commands.registerCommand(
      'cCallHierarchyReferences.nextCallSite',
      async (
        node?: CallNode,
      ): Promise<{ index: number; total: number; uri: string; line: number } | undefined> => {
        const target = node ?? callView.selection[0];
        if (!target) {
          return undefined;
        }
        const sites = target.fromRanges;
        const hasSites = !!target.callUri && sites.length > 0;
        const r = nextSiteIndex(enterCursor, cursorKey(target), hasSites ? sites.length : 1);
        enterCursor = { key: r.key, index: r.index };
        const loc = hasSites
          ? { uri: target.callUri!, range: sites[r.index] }
          : nodeTarget(target);
        if (r.total > 1) {
          vscode.window.setStatusBarMessage(`Call site ${r.index + 1} / ${r.total}`, 2500);
        }
        await revealAt(loc.uri, loc.range, { preserveFocus: true, preview: true });
        return { index: r.index, total: r.total, uri: loc.uri.toString(), line: loc.range.start.line };
      },
    ),
    vscode.commands.registerCommand('cCallHierarchyReferences.toggleReferenceGrouping', () => {
      refProvider.toggleGrouping();
      vscode.window.setStatusBarMessage(
        `References grouped by ${refProvider.getGrouping()}`,
        2000,
      );
    }),
    // The path filter and reference-kind toggles are driven entirely by the fixed
    // Filter pane (its input, Clear button and w/r/&/d/· chips), so there are no
    // separate setPathFilter / clearPathFilter / filterReferenceKinds commands.

    // ---- Filter to a folder from the Explorer context menu ----
    vscode.commands.registerCommand('cCallHierarchyReferences.filterToFolder', async (arg?: unknown) => {
      const uri = uriFromArg(arg);
      if (!uri) {
        return;
      }
      let dir = uri;
      try {
        const st = await vscode.workspace.fs.stat(uri);
        if (!(st.type & vscode.FileType.Directory)) {
          dir = vscode.Uri.joinPath(uri, '..');
        }
      } catch {
        dir = vscode.Uri.joinPath(uri, '..');
      }
      const rel = vscode.workspace.asRelativePath(dir, false).replace(/\\/g, '/');
      setRuntimeFilter(rel && rel !== '.' ? `${rel}/**` : '**');
      await applyPathFilter();
    }),

    // ---- React to settings ----
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('cCallHierarchyReferences.showSignatures') ||
        e.affectsConfiguration('cCallHierarchyReferences.maxDepth')
      ) {
        tree.refresh();
        refProvider.refresh();
      }
    }),
  );

  // Restore the persisted path-filter indicator on startup.
  void applyPathFilter();

  // Exposed for integration tests to drive the real providers. `setFilter`
  // applies the runtime search filter (normally typed in the Filter pane) so
  // tests can assert filter-dependent rendering like the match highlight.
  return {
    tree,
    references: refProvider,
    setFilter: (query?: string) => {
      setRuntimeFilter(query);
      void applyPathFilter();
    },
    // Exposed so integration tests can drive the real view selection (reveal +
    // select) and verify Enter acts on the selected node.
    callView,
  };
}

function symbolNameAt(editor: vscode.TextEditor): string {
  const range = editor.document.getWordRangeAtPosition(editor.selection.active);
  return range ? editor.document.getText(range) : 'symbol';
}

function uriFromArg(arg: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) {
    return arg;
  }
  if (arg && typeof arg === 'object') {
    const a = arg as { uri?: unknown; resourceUri?: unknown; location?: { uri?: unknown } };
    if (a.uri instanceof vscode.Uri) {
      return a.uri;
    }
    if (a.resourceUri instanceof vscode.Uri) {
      return a.resourceUri;
    }
    if (a.location && (a.location.uri as unknown) instanceof vscode.Uri) {
      return a.location.uri as vscode.Uri;
    }
  }
  return undefined;
}

export function deactivate(): void {
  /* nothing to clean up */
}
