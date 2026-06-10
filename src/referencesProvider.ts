import * as vscode from 'vscode';
import { ClassifiedRef, RefKind } from './hierarchy';
import { passesFilter } from './filter';

type RefTreeNode =
  | { kind: 'folder'; label: string; path: string; children: RefTreeNode[] }
  | { kind: 'file'; uri: vscode.Uri; refs: ClassifiedRef[]; showDir: boolean }
  | { kind: 'leaf'; ref: ClassifiedRef };

type GroupMode = 'file' | 'folder';

export type KindCat = 'w' | 'r' | 'a' | 'd' | 'u';
const CAT_KINDS: Record<KindCat, RefKind[]> = {
  w: [RefKind.Write],
  r: [RefKind.Read],
  a: [RefKind.Address],
  d: [RefKind.Declaration, RefKind.Definition],
  u: [RefKind.Unknown],
};

const ALL_KINDS: RefKind[] = [
  RefKind.Write,
  RefKind.Read,
  RefKind.Address,
  RefKind.Definition,
  RefKind.Declaration,
  RefKind.Unknown,
];

/** Renders classified references, grouped by file or by folder, with a kind filter. */
export class ReferencesProvider implements vscode.TreeDataProvider<RefTreeNode> {
  private readonly _onDidChange = new vscode.EventEmitter<RefTreeNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private symbolName = '';
  private all: ClassifiedRef[] = [];
  private view: vscode.TreeView<RefTreeNode> | undefined;
  private readonly lineCache = new Map<string, string[]>();

  private groupMode: GroupMode = 'folder';
  private kindFilter = new Set<RefKind>(ALL_KINDS);

  constructor(private readonly extensionUri: vscode.Uri) {}

  attachView(view: vscode.TreeView<RefTreeNode>): void {
    this.view = view;
  }

  setReferences(symbolName: string, classified: ClassifiedRef[]): void {
    this.symbolName = symbolName;
    this.all = classified;
    this.lineCache.clear();
    this.refresh();
  }

  clear(): void {
    this.symbolName = '';
    this.all = [];
    this.lineCache.clear();
    this.refresh();
  }

  refresh(): void {
    this._onDidChange.fire();
    this.updateSummary();
  }

  toggleGrouping(): void {
    this.groupMode = this.groupMode === 'folder' ? 'file' : 'folder';
    this.refresh();
  }

  getGrouping(): GroupMode {
    return this.groupMode;
  }

  /** Interactive multi-select of which reference kinds to show. */
  async promptKindFilter(): Promise<void> {
    const items: (vscode.QuickPickItem & { kinds: RefKind[] })[] = [
      { label: 'Write', kinds: [RefKind.Write], picked: this.kindFilter.has(RefKind.Write) },
      { label: 'Read', kinds: [RefKind.Read], picked: this.kindFilter.has(RefKind.Read) },
      { label: 'Address-of (&)', kinds: [RefKind.Address], picked: this.kindFilter.has(RefKind.Address) },
      {
        label: 'Declaration / definition',
        kinds: [RefKind.Declaration, RefKind.Definition],
        picked: this.kindFilter.has(RefKind.Declaration),
      },
      { label: 'Unknown', kinds: [RefKind.Unknown], picked: this.kindFilter.has(RefKind.Unknown) },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title: 'Show reference kinds',
      placeHolder: 'Pick which read/write kinds to show',
    });
    if (!picked) {
      return; // cancelled — leave filter unchanged
    }
    this.kindFilter = new Set(picked.flatMap((p) => p.kinds));
    this.refresh();
  }

  /** Toggle a kind category (w/r/d/u) on or off; used by the filter-pane chips. */
  toggleKindCategory(cat: KindCat): void {
    const kinds = CAT_KINDS[cat];
    const allOn = kinds.every((k) => this.kindFilter.has(k));
    for (const k of kinds) {
      if (allOn) {
        this.kindFilter.delete(k);
      } else {
        this.kindFilter.add(k);
      }
    }
    this.refresh();
  }

  kindStates(): Record<KindCat, boolean> {
    return {
      w: this.kindFilter.has(RefKind.Write),
      r: this.kindFilter.has(RefKind.Read),
      a: this.kindFilter.has(RefKind.Address),
      d: this.kindFilter.has(RefKind.Declaration) || this.kindFilter.has(RefKind.Definition),
      u: this.kindFilter.has(RefKind.Unknown),
    };
  }

  private visible(): ClassifiedRef[] {
    return this.all.filter(
      (r) => passesFilter(this.symbolName, r.location.uri) && this.kindFilter.has(r.kind),
    );
  }

  private updateSummary(): void {
    if (!this.view) {
      return;
    }
    const vis = this.visible();
    const hidden = this.all.length - vis.length;
    if (this.all.length === 0) {
      this.view.description = undefined;
      this.view.message = undefined;
      return;
    }
    const kindNote = this.kindFilter.size < ALL_KINDS.length ? ' · filtered' : '';
    if (vis.length === 0) {
      this.view.description = (this.symbolName || '') + kindNote;
      this.view.message = `No references shown (${hidden} hidden by filters).`;
      return;
    }
    const files = new Set(vis.map((r) => r.location.uri.toString())).size;
    let w = 0;
    let rd = 0;
    let a = 0;
    let d = 0;
    for (const r of vis) {
      if (r.kind === RefKind.Write) {
        w++;
      } else if (r.kind === RefKind.Read) {
        rd++;
      } else if (r.kind === RefKind.Address) {
        a++;
      } else if (r.kind === RefKind.Declaration || r.kind === RefKind.Definition) {
        d++;
      }
    }
    this.view.message = undefined;
    this.view.description =
      `${this.symbolName} · ${vis.length} refs in ${files} files · ${w}w ${rd}r${a ? ` ${a}&` : ''} ${d}d` +
      kindNote +
      (hidden ? ` (${hidden} hidden)` : '');
  }

  getTreeItem(node: RefTreeNode): vscode.TreeItem {
    if (node.kind === 'folder') {
      return this.folderItem(node);
    }
    if (node.kind === 'file') {
      return this.fileItem(node.uri, node.refs, node.showDir);
    }
    return this.leafItem(node.ref);
  }

  async getChildren(node?: RefTreeNode): Promise<RefTreeNode[]> {
    if (!node) {
      return this.groupMode === 'folder' ? this.buildFolderTree() : this.buildFileGroups();
    }
    if (node.kind === 'folder') {
      return node.children;
    }
    if (node.kind === 'file') {
      await this.ensureLines(node.uri);
      return [...node.refs]
        .sort(
          (a, b) =>
            rankKind(a.kind) - rankKind(b.kind) ||
            a.location.range.start.line - b.location.range.start.line,
        )
        .map((ref) => ({ kind: 'leaf' as const, ref }));
    }
    return [];
  }

  // ---- grouping ------------------------------------------------------------

  /** Flat list of file nodes (dir shown in the description). */
  private buildFileGroups(): RefTreeNode[] {
    const groups = groupByFile(this.visible());
    return [...groups.entries()]
      .map(([uriStr, refs]) => ({
        kind: 'file' as const,
        uri: vscode.Uri.parse(uriStr),
        refs,
        showDir: true,
      }))
      .sort((a, b) => relOf(a.uri).localeCompare(relOf(b.uri)));
  }

  /** Nested directory tree → files → leaves (single-child folders compacted). */
  private buildFolderTree(): RefTreeNode[] {
    interface Dir {
      name: string;
      dirs: Map<string, Dir>;
      files: Map<string, ClassifiedRef[]>;
    }
    const root: Dir = { name: '', dirs: new Map(), files: new Map() };
    const uris = new Map<string, vscode.Uri>();

    for (const r of this.visible()) {
      const uri = r.location.uri;
      const parts = relOf(uri).split('/');
      parts.pop(); // file name — keyed by uri below
      let cur = root;
      for (const seg of parts) {
        let d = cur.dirs.get(seg);
        if (!d) {
          d = { name: seg, dirs: new Map(), files: new Map() };
          cur.dirs.set(seg, d);
        }
        cur = d;
      }
      const key = uri.toString();
      uris.set(key, uri);
      let bucket = cur.files.get(key);
      if (!bucket) {
        bucket = [];
        cur.files.set(key, bucket);
      }
      bucket.push(r);
    }

    const toNodes = (dir: Dir, parentPath: string): RefTreeNode[] => {
      const folders: RefTreeNode[] = [...dir.dirs.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((sub) => {
          // Compact single-child folder chains (e.g. src/net/ipv4).
          let d = sub;
          let label = d.name;
          let full = parentPath ? `${parentPath}/${d.name}` : d.name;
          while (d.dirs.size === 1 && d.files.size === 0) {
            const only = [...d.dirs.values()][0];
            label += `/${only.name}`;
            full += `/${only.name}`;
            d = only;
          }
          return { kind: 'folder' as const, label, path: full, children: toNodes(d, full) };
        });
      const files: RefTreeNode[] = [...dir.files.entries()]
        .map(([key, refs]) => ({
          kind: 'file' as const,
          uri: uris.get(key)!,
          refs,
          showDir: false,
        }))
        .sort((a, b) => baseOf(a.uri).localeCompare(baseOf(b.uri)));
      return [...folders, ...files];
    };

    return toNodes(root, '');
  }

  // ---- tree items ----------------------------------------------------------

  private folderItem(node: { label: string; path: string; children: RefTreeNode[] }): vscode.TreeItem {
    const count = countRefs(node.children);
    const ti = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
    ti.iconPath = vscode.ThemeIcon.Folder;
    ti.description = `${count} ref${count === 1 ? '' : 's'}`;
    ti.contextValue = 'refFolder';
    ti.tooltip = node.path;
    // Enable "Filter to this folder" on single-root workspaces.
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length === 1) {
      ti.resourceUri = vscode.Uri.joinPath(folders[0].uri, ...node.path.split('/'));
    }
    return ti;
  }

  private fileItem(uri: vscode.Uri, refs: ClassifiedRef[], showDir: boolean): vscode.TreeItem {
    const rel = relOf(uri);
    const slash = rel.lastIndexOf('/');
    const base = slash >= 0 ? rel.slice(slash + 1) : rel;
    const dir = slash >= 0 ? rel.slice(0, slash) : '';
    const ti = new vscode.TreeItem(base, vscode.TreeItemCollapsibleState.Expanded);
    ti.resourceUri = uri;
    ti.iconPath = vscode.ThemeIcon.File;
    ti.description =
      `${showDir && dir ? dir + ' · ' : ''}${refs.length} ref${refs.length === 1 ? '' : 's'}`;
    ti.contextValue = 'refFile';
    ti.tooltip = rel;
    return ti;
  }

  private leafItem(ref: ClassifiedRef): vscode.TreeItem {
    const { uri, range } = ref.location;
    const line = range.start.line;
    const lines = this.lineCache.get(uri.toString());
    const original = lines?.[line] ?? '';
    const text = original.trim();
    // Highlight the referenced symbol within the (trimmed) source line.
    let label: string | vscode.TreeItemLabel = text || `line ${line + 1}`;
    if (text && range.start.line === range.end.line) {
      const lead = original.length - original.trimStart().length;
      const start = range.start.character - lead;
      const end = range.end.character - lead;
      if (start >= 0 && end > start && end <= text.length) {
        label = { label: text, highlights: [[start, end]] };
      }
    }
    const ti = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    ti.description = `:${line + 1}:${range.start.character + 1}`;
    ti.iconPath = this.iconFor(ref.kind);
    const tip = new vscode.MarkdownString();
    tip.appendMarkdown(
      `**${kindWord(ref.kind)}** — ${relOf(uri)}:${line + 1}:${range.start.character + 1}`,
    );
    if (text) {
      tip.appendMarkdown('\n\n```c\n' + (lines?.[line] ?? text) + '\n```');
    }
    ti.tooltip = tip;
    ti.command = {
      command: 'cCallHierarchyReferences.openReference',
      title: 'Open',
      arguments: [uri, range],
    };
    return ti;
  }

  /** Letter-shaped icon: green r (read), red w (write), yellow d (decl/def). */
  private iconFor(k: RefKind): vscode.Uri {
    let file: string;
    switch (k) {
      case RefKind.Write:
        file = 'ref-write.svg';
        break;
      case RefKind.Read:
        file = 'ref-read.svg';
        break;
      case RefKind.Address:
        file = 'ref-addr.svg';
        break;
      case RefKind.Definition:
      case RefKind.Declaration:
        file = 'ref-decl.svg';
        break;
      default:
        file = 'ref-unknown.svg';
    }
    return vscode.Uri.joinPath(this.extensionUri, 'icons', file);
  }

  /** Load and cache a file's lines so leaf labels can show source text. */
  private async ensureLines(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    if (this.lineCache.has(key)) {
      return;
    }
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const lines: string[] = [];
      for (let i = 0; i < doc.lineCount; i++) {
        lines.push(doc.lineAt(i).text);
      }
      this.lineCache.set(key, lines);
    } catch {
      this.lineCache.set(key, []);
    }
  }
}

function relOf(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
}

function baseOf(uri: vscode.Uri): string {
  const rel = relOf(uri);
  const slash = rel.lastIndexOf('/');
  return slash >= 0 ? rel.slice(slash + 1) : rel;
}

function groupByFile(refs: ClassifiedRef[]): Map<string, ClassifiedRef[]> {
  const groups = new Map<string, ClassifiedRef[]>();
  for (const r of refs) {
    const k = r.location.uri.toString();
    let bucket = groups.get(k);
    if (!bucket) {
      bucket = [];
      groups.set(k, bucket);
    }
    bucket.push(r);
  }
  return groups;
}

function countRefs(nodes: RefTreeNode[]): number {
  let n = 0;
  for (const node of nodes) {
    if (node.kind === 'file') {
      n += node.refs.length;
    } else if (node.kind === 'folder') {
      n += countRefs(node.children);
    }
  }
  return n;
}

/** decl/def first, then writes, then reads, then unknown. */
function rankKind(k: RefKind): number {
  switch (k) {
    case RefKind.Definition:
      return 0;
    case RefKind.Declaration:
      return 1;
    case RefKind.Write:
      return 2;
    case RefKind.Address:
      return 3;
    case RefKind.Read:
      return 4;
    default:
      return 5;
  }
}

function kindWord(k: RefKind): string {
  switch (k) {
    case RefKind.Definition:
      return 'Definition';
    case RefKind.Declaration:
      return 'Declaration';
    case RefKind.Write:
      return 'Write';
    case RefKind.Address:
      return 'Address-of (&)';
    case RefKind.Read:
      return 'Read';
    default:
      return 'Reference';
  }
}
