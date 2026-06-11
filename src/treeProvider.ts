import * as vscode from 'vscode';
import * as h from './hierarchy';
import { passesFilter, matchesRuntimeFilter, maxDepth } from './filter';

function showSignatures(): boolean {
  return vscode.workspace.getConfiguration('cCallHierarchyReferences').get<boolean>('showSignatures', true);
}

type NodeKind = 'root' | 'call';

/** One node in the call tree (the root, or a call walked in the active direction). */
export class CallNode {
  readonly key: string;
  constructor(
    readonly kind: NodeKind,
    readonly item: vscode.CallHierarchyItem,
    /** Call-site ranges (relative to `callUri`, not necessarily `item.uri`). */
    readonly fromRanges: vscode.Range[],
    readonly depth: number,
    /** Ancestor function keys, for cycle detection along this branch. */
    readonly ancestry: ReadonlySet<string>,
    readonly parent?: CallNode,
    /**
     * The file the `fromRanges` live in: the caller's file for incoming calls,
     * the *current* function's file for outgoing calls (LSP puts outgoing
     * fromRanges relative to the caller, not the callee).
     */
    readonly callUri?: vscode.Uri,
  ) {
    this.key = h.itemKey(item);
  }
}

export class CallTreeProvider implements vscode.TreeDataProvider<CallNode> {
  private readonly _onDidChange = new vscode.EventEmitter<CallNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private roots: CallNode[] = [];
  private direction: h.Direction = 'incoming';
  /** Cached one-level step promises, keyed by function+direction. */
  private readonly stepCache = new Map<
    string,
    Promise<{ item: vscode.CallHierarchyItem; fromRanges: vscode.Range[] }[]>
  >();

  getRoots(): readonly CallNode[] {
    return this.roots;
  }

  getDirection(): h.Direction {
    return this.direction;
  }

  toggleDirection(): void {
    this.direction = this.direction === 'incoming' ? 'outgoing' : 'incoming';
    this.refresh();
  }

  setRoots(items: vscode.CallHierarchyItem[]): void {
    this.roots = items.map((it) => new CallNode('root', it, [], 0, new Set()));
    this.refresh();
  }

  clear(): void {
    this.roots = [];
    this.refresh();
  }

  refresh(): void {
    this.stepCache.clear();
    this._onDidChange.fire();
  }

  getParent(node: CallNode): CallNode | undefined {
    return node.parent;
  }

  /** Fetch (and cache) one level of calls in the active direction. */
  private fetchStep(item: vscode.CallHierarchyItem): Promise<{ item: vscode.CallHierarchyItem; fromRanges: vscode.Range[] }[]> {
    const cacheKey = `${h.itemKey(item)}|${this.direction}`;
    let p = this.stepCache.get(cacheKey);
    if (!p) {
      p = h
        .step(item, this.direction)
        .then((next) =>
          next.filter((n) =>
            // Outgoing callee uris are often header prototypes; gating file
            // visibility on the header would drop legitimate callees, so keep
            // only the name/path search for that direction.
            this.direction === 'incoming'
              ? passesFilter(n.item.name, n.item.uri)
              : matchesRuntimeFilter(n.item.name, n.item.uri),
          ),
        )
        .catch(() => []);
      this.stepCache.set(cacheKey, p);
    }
    return p;
  }

  async getTreeItem(node: CallNode): Promise<vscode.TreeItem> {
    const item = node.item;
    const recursive = node.ancestry.has(node.key);
    const leaf = node.kind === 'call' && (node.depth >= maxDepth() || recursive);
    const ti = new vscode.TreeItem(
      item.name,
      node.kind === 'root'
        ? vscode.TreeItemCollapsibleState.Expanded
        : leaf
          ? vscode.TreeItemCollapsibleState.None
          : vscode.TreeItemCollapsibleState.Collapsed,
    );
    const rel = vscode.workspace.asRelativePath(item.uri, false);

    let sig: h.Signature | undefined;
    if (showSignatures()) {
      sig = await h.signature(item);
    }
    // clangd merges multiple call sites to the same function into one node; show
    // the call-site count so 3 calls don't look like 1.
    const calls = node.fromRanges.length;
    const countBadge = calls > 1 ? `×${calls}  ·  ` : '';
    const base = sig?.params ? `${sig.params}  ·  ${rel}` : item.detail || rel;
    ti.description = countBadge + base;
    ti.iconPath = iconFor(item.kind);

    const tip = new vscode.MarkdownString();
    tip.appendMarkdown(`**${item.name}**\n\n${rel}:${item.selectionRange.start.line + 1}`);
    if (sig?.full) {
      tip.appendMarkdown('\n\n```c\n' + sig.full + '\n```');
    }
    if (calls > 1) {
      const list = node.fromRanges
        .map((r) => `\`:${r.start.line + 1}:${r.start.character + 1}\``)
        .join(', ');
      tip.appendMarkdown(`\n\n${calls} call site(s): ${list}`);
    }
    if (recursive) {
      tip.appendMarkdown('\n\n_recursive (cycle)_');
    }
    ti.tooltip = tip;

    // Select → preview the call site (or, for the root, the definition); focus
    // stays in the tree so you can keep browsing. The inline action opens it for
    // real (see nodeTarget for how the location is chosen).
    const t = nodeTarget(node);
    ti.command = {
      command: 'cCallHierarchyReferences.openReference',
      title: 'Open',
      arguments: [t.uri, t.range],
    };
    // `...Multi` marks a node with several merged call sites — enables the
    // inline "Go to call site…" picker to browse between them.
    const multi = node.fromRanges.length > 1 ? 'Multi' : '';
    ti.contextValue = (recursive ? 'recursive' : node.kind) + multi;
    return ti;
  }

  async getChildren(node?: CallNode): Promise<CallNode[]> {
    if (!node) {
      return [...this.roots];
    }
    if (node.kind === 'call' && (node.depth >= maxDepth() || node.ancestry.has(node.key))) {
      return [];
    }
    const next = await this.fetchStep(node.item);
    const childAncestry = new Set(node.ancestry).add(node.key);
    return next.map(({ item, fromRanges }) => {
      // Incoming: call sites are in the caller's file (the child itself).
      // Outgoing: they are in the file being expanded (this node's function).
      const callUri = this.direction === 'incoming' ? item.uri : node.item.uri;
      return new CallNode('call', item, fromRanges, node.depth + 1, childAncestry, node, callUri);
    });
  }
}

/**
 * The location a node opens: its call site when it has one (callers/callees),
 * otherwise the function's definition (the root). Definition-preferring already,
 * so no go-to-definition bounce.
 */
export function nodeTarget(node: CallNode): { uri: vscode.Uri; range: vscode.Range } {
  const hasCall = node.fromRanges.length > 0 && !!node.callUri;
  return hasCall
    ? { uri: node.callUri!, range: node.fromRanges[0] }
    : { uri: node.item.uri, range: node.item.selectionRange };
}

// Colour the symbol icon with the theme's standard symbol colours (the same
// `symbolIcon.*Foreground` keys VS Code's built-in call hierarchy / outline use),
// so the function `ƒ` etc. show coloured instead of monochrome.
function iconFor(kind: vscode.SymbolKind): vscode.ThemeIcon {
  let id: string;
  let color: string;
  switch (kind) {
    case vscode.SymbolKind.Function:
      id = 'symbol-function';
      color = 'symbolIcon.functionForeground';
      break;
    case vscode.SymbolKind.Method:
      id = 'symbol-method';
      color = 'symbolIcon.methodForeground';
      break;
    case vscode.SymbolKind.Constructor:
      id = 'symbol-constructor';
      color = 'symbolIcon.constructorForeground';
      break;
    case vscode.SymbolKind.Field:
      id = 'symbol-field';
      color = 'symbolIcon.fieldForeground';
      break;
    case vscode.SymbolKind.Property:
      id = 'symbol-property';
      color = 'symbolIcon.propertyForeground';
      break;
    case vscode.SymbolKind.Variable:
      id = 'symbol-variable';
      color = 'symbolIcon.variableForeground';
      break;
    default:
      id = 'symbol-misc';
      color = 'symbolIcon.functionForeground';
  }
  return new vscode.ThemeIcon(id, new vscode.ThemeColor(color));
}
