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
  //   enterCursor — the keyboard Enter walk: each press previews the next site
  //                 while focus stays in the tree. Seeded to the selected node
  //                 (index 0 = the site the arrow-preview already shows) on every
  //                 selection change, so the first Enter advances to the next site.
  const cursorKey = (node: CallNode): string =>
    `${node.key}|${(node.callUri ?? node.item.uri).toString()}`;
  let openCursor: { key: string; index: number } | undefined;
  let enterCursor: { key: string; index: number } | undefined;

  // Pin the Enter-walk cursor to the selected node and flag ×N selections, so the
  // Enter keybinding only overrides Enter on a node that actually has sites to
  // walk. Both keep Enter acting on the CURRENTLY selected node — never a stale one.
  context.subscriptions.push(
    callView.onDidChangeSelection((e) => {
      const sel = e.selection[0];
      enterCursor = sel ? { key: cursorKey(sel), index: 0 } : undefined;
      void vscode.commands.executeCommand(
        'setContext',
        'cCallHierarchyReferences.selectedMulti',
        (sel?.fromRanges.length ?? 0) > 1,
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
    // Keyboard Enter on a ×N node walks its merged call sites — one per press,
    // wrapping — previewing each while focus stays in the tree (bound to Enter via
    // a keybinding gated on `selectedMulti`). Reads the SELECTED node (or an
    // explicit node, for tests) + the per-node enterCursor, so arrowing to another
    // node and pressing Enter walks THAT node, never the previously walked one.
    vscode.commands.registerCommand(
      'cCallHierarchyReferences.nextCallSite',
      async (node?: CallNode): Promise<{ index: number; total: number } | undefined> => {
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
        return { index: r.index, total: r.total };
      },
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
