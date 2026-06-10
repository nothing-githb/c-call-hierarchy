import * as vscode from 'vscode';
import * as h from './hierarchy';
import { CallTreeProvider, CallNode, nodeTarget } from './treeProvider';
import { ReferencesProvider } from './referencesProvider';
import { IncludeIndex, buildIncludeGraph } from './includes';
import { IncludeTreeProvider } from './includesProvider';
import { GraphView } from './graphView';
import { FilterPanelProvider } from './filterPanel';
import {
  initFilterState,
  setRuntimeFilter,
  getRuntimeFilter,
} from './filter';

export function activate(context: vscode.ExtensionContext): { tree: CallTreeProvider } {
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

  // --- Include hierarchy view ---
  const includeIndex = new IncludeIndex();
  const includeProvider = new IncludeTreeProvider(includeIndex);
  const includeView = vscode.window.createTreeView('cCallHierarchyReferences.includes', {
    treeDataProvider: includeProvider,
    showCollapseAll: true,
  });
  includeProvider.attachView(includeView);

  context.subscriptions.push(callView, refView, includeView);

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

  let filterPanel: FilterPanelProvider | undefined;

  const applyPathFilter = async (): Promise<void> => {
    const active = !!getRuntimeFilter();
    await vscode.commands.executeCommand('setContext', 'cCallHierarchyReferences.pathFilterActive', active);
    tree.refresh();
    refProvider.refresh();
    includeProvider.refresh();
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

  const ensureIndex = (title: string) =>
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title },
      () => includeIndex.build(),
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

    // ---- Include hierarchy ----
    vscode.commands.registerCommand('cCallHierarchyReferences.showIncludeHierarchy', async (arg?: unknown) => {
      const uri = uriFromArg(arg) ?? vscode.window.activeTextEditor?.document.uri;
      if (!uri) {
        vscode.window.showInformationMessage('Open or select a C/C++ file first.');
        return;
      }
      if (!includeIndex.built || !includeIndex.knows(uri)) {
        await ensureIndex('Scanning #include graph…');
      }
      includeProvider.setRoot(uri);
      await vscode.commands.executeCommand('cCallHierarchyReferences.includes.focus');
    }),

    vscode.commands.registerCommand('cCallHierarchyReferences.toggleIncludeDirection', () =>
      includeProvider.toggleDirection(),
    ),

    vscode.commands.registerCommand('cCallHierarchyReferences.refreshIncludes', async () => {
      await ensureIndex('Rescanning #include graph…');
      includeProvider.refresh();
    }),

    vscode.commands.registerCommand('cCallHierarchyReferences.openIncludeGraph', async () => {
      const root = includeProvider.getRootUri();
      if (!root) {
        vscode.window.showInformationMessage('Run "Show include hierarchy" first.');
        return;
      }
      if (!includeIndex.built) {
        await ensureIndex('Scanning #include graph…');
      }
      const model = buildIncludeGraph(includeIndex, root, includeProvider.getDirection());
      GraphView.show(model, context.extensionUri);
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
        includeProvider.refresh();
      }
      if (e.affectsConfiguration('cCallHierarchyReferences.includePaths')) {
        includeIndex.built = false; // force a rescan on next use
      }
    }),
  );

  // Restore the persisted path-filter indicator on startup.
  void applyPathFilter();

  // Exposed for integration tests to drive the real tree provider.
  return { tree };
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
