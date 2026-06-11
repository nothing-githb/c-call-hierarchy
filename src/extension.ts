import * as vscode from 'vscode';
import * as h from './hierarchy';
import { CallTreeProvider, CallNode, nodeTarget } from './treeProvider';
import { ReferencesProvider } from './referencesProvider';
import { FilterPanelProvider } from './filterPanel';
import {
  initFilterState,
  setRuntimeFilter,
  getRuntimeFilter,
} from './filter';

export function activate(
  context: vscode.ExtensionContext,
): { tree: CallTreeProvider; references: ReferencesProvider } {
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

  // Browse a node's several merged call sites with the keyboard (F4 / Shift+F4):
  // cycle through its fromRanges, previewing each; focus stays in the tree.
  let callSiteCursor: { key: string; index: number } | undefined;
  const cycleCallSite = (
    delta: number,
    node?: CallNode,
  ): { index: number; total: number } | undefined => {
    node = node ?? callView.selection[0];
    if (!node || !node.callUri || node.fromRanges.length === 0) {
      return undefined;
    }
    const sites = node.fromRanges;
    const key = `${node.key}|${node.callUri.toString()}`;
    // A fresh node's click target is site 0, so the first "next" lands on site 1.
    const prev = callSiteCursor && callSiteCursor.key === key ? callSiteCursor.index : 0;
    const index = (prev + delta + sites.length) % sites.length;
    callSiteCursor = { key, index };
    void revealAt(node.callUri, sites[index], { preserveFocus: true, preview: true });
    if (sites.length > 1) {
      vscode.window.setStatusBarMessage(`Call site ${index + 1} / ${sites.length}`, 2500);
    }
    return { index, total: sites.length };
  };

  // Enter on a ×N node walks its call sites (see the keybinding). Reset the cursor
  // when the selection changes, and expose a context key gating that keybinding.
  context.subscriptions.push(
    callView.onDidChangeSelection((e) => {
      callSiteCursor = undefined;
      void vscode.commands.executeCommand(
        'setContext',
        'cCallHierarchyReferences.selectedMulti',
        (e.selection[0]?.fromRanges.length ?? 0) > 1,
      );
    }),
  );

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
    // Invoked from the inline node action, so it receives the CallNode.
    vscode.commands.registerCommand('cCallHierarchyReferences.openReferenceInEditor', (node: CallNode) => {
      const t = nodeTarget(node);
      return revealAt(t.uri, t.range, { preserveFocus: false, preview: false });
    }),
    // Browse between a node's several merged call sites (the ×N badge): arrow to
    // preview each, Enter to open the chosen one.
    vscode.commands.registerCommand('cCallHierarchyReferences.goToCallSite', async (node: CallNode) => {
      const uri = node.callUri;
      const sites = node.fromRanges;
      if (!uri || sites.length <= 1) {
        const t = nodeTarget(node);
        return revealAt(t.uri, t.range, { preserveFocus: false, preview: false });
      }
      let doc: vscode.TextDocument | undefined;
      try {
        doc = await vscode.workspace.openTextDocument(uri);
      } catch {
        /* labels fall back to the line number */
      }
      const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { range: vscode.Range }>();
      qp.title = `${node.item.name} — ${sites.length} call sites`;
      qp.placeholder = 'Arrow to preview · Enter to open';
      qp.items = sites.map((r, i) => ({
        label: doc?.lineAt(r.start.line).text.trim() || `call site ${i + 1}`,
        description: `:${r.start.line + 1}:${r.start.character + 1}`,
        range: r,
      }));
      qp.onDidChangeActive((active) => {
        if (active[0]) {
          void revealAt(uri, active[0].range, { preserveFocus: true, preview: true });
        }
      });
      qp.onDidAccept(() => {
        const picked = qp.activeItems[0];
        qp.hide();
        if (picked) {
          void revealAt(uri, picked.range, { preserveFocus: false, preview: false });
        }
      });
      qp.onDidHide(() => qp.dispose());
      qp.show();
    }),
    // Enter on a ×N node walks its merged call sites (one per press, wrapping);
    // bound to Enter via a keybinding gated on `selectedMulti`.
    vscode.commands.registerCommand('cCallHierarchyReferences.nextCallSite', (node?: CallNode) =>
      cycleCallSite(1, node),
    ),
    vscode.commands.registerCommand('cCallHierarchyReferences.toggleReferenceGrouping', () => {
      refProvider.toggleGrouping();
      vscode.window.setStatusBarMessage(
        `References grouped by ${refProvider.getGrouping()}`,
        2000,
      );
    }),
    vscode.commands.registerCommand('cCallHierarchyReferences.filterReferenceKinds', async () => {
      await refProvider.promptKindFilter();
      filterPanel?.updateKinds();
    }),

    // ---- Path filter (live: applies as you type, reverts on Escape) ----
    vscode.commands.registerCommand('cCallHierarchyReferences.setPathFilter', () => {
      const original = getRuntimeFilter();
      const input = vscode.window.createInputBox();
      input.title = 'Filter by name or path (contains, glob, or /regex/)';
      input.placeholder = 'bus   ·   src/net/**   ·   /drv_\\d+/   (live)';
      input.value = original ?? '';
      let accepted = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const live = (value: string) => {
        if (timer) {
          clearTimeout(timer);
        }
        // Debounce so each keystroke doesn't re-query clangd for the call tree.
        timer = setTimeout(() => {
          setRuntimeFilter(value);
          void applyPathFilter();
        }, 250);
      };
      input.onDidChangeValue(live);
      input.onDidAccept(() => {
        accepted = true;
        if (timer) {
          clearTimeout(timer);
        }
        setRuntimeFilter(input.value);
        void applyPathFilter();
        input.hide();
      });
      input.onDidHide(() => {
        if (timer) {
          clearTimeout(timer);
        }
        if (!accepted) {
          // Escape / focus loss — restore the filter that was active on open.
          setRuntimeFilter(original);
          void applyPathFilter();
        }
        input.dispose();
      });
      input.show();
    }),

    vscode.commands.registerCommand('cCallHierarchyReferences.clearPathFilter', async () => {
      setRuntimeFilter(undefined);
      await applyPathFilter();
    }),

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
        e.affectsConfiguration('cCallHierarchyReferences.includeGlobs') ||
        e.affectsConfiguration('cCallHierarchyReferences.excludeGlobs') ||
        e.affectsConfiguration('cCallHierarchyReferences.showSignatures')
      ) {
        tree.refresh();
        refProvider.refresh();
      }
    }),
  );

  // Restore the persisted path-filter indicator on startup.
  void applyPathFilter();

  // Exposed for integration tests to drive the real providers.
  return { tree, references: refProvider };
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
