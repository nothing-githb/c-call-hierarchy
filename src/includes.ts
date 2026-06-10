import * as vscode from 'vscode';
import * as path from 'path';
import { GraphModel } from './graph';
import { passesFilter, maxDepth } from './filter';

const SOURCE_GLOB = '**/*.{h,hh,hpp,hxx,h++,inc,ipp,tcc,c,cc,cpp,cxx,c++}';

export interface IncludeRef {
  /** The text inside the include, e.g. `foo/bar.h`. */
  spelling: string;
  /** True for `<...>`, false for `"..."`. */
  angle: boolean;
  /** Resolved workspace file, if found. Undefined = unresolved (system/missing). */
  target?: vscode.Uri;
}

const WIN = process.platform === 'win32';

function normKey(fsPath: string): string {
  const n = path.normalize(fsPath).replace(/\\/g, '/');
  return WIN ? n.toLowerCase() : n;
}

/** Extra include search roots from settings, resolved against each workspace folder. */
function configuredIncludeDirs(): string[] {
  const cfg = vscode.workspace.getConfiguration('cCallHierarchyReferences').get<string[]>('includePaths', []);
  const folders = vscode.workspace.workspaceFolders ?? [];
  const dirs: string[] = folders.map((f) => f.uri.fsPath);
  for (const p of cfg) {
    if (path.isAbsolute(p)) {
      dirs.push(p);
    } else {
      for (const f of folders) {
        dirs.push(path.join(f.uri.fsPath, p));
      }
    }
  }
  return dirs;
}

// Matched delimiters only: `<...>` OR `"..."` (group 1 = angle, group 2 = quote).
const INCLUDE_RE = /^[ \t]*#[ \t]*include[ \t]*(?:<([^>\r\n]+)>|"([^"\r\n]+)")/gm;

function parseIncludes(text: string): { spelling: string; angle: boolean }[] {
  const out: { spelling: string; angle: boolean }[] = [];
  const src = stripComments(text);
  INCLUDE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INCLUDE_RE.exec(src)) !== null) {
    const angle = m[1] !== undefined;
    out.push({ spelling: (angle ? m[1] : m[2]).trim(), angle });
  }
  return out;
}

/**
 * Blank out `//` and block comments (preserving newlines and string/char
 * literals) so commented-out `#include`s aren't scanned as real edges. Does not
 * evaluate `#if 0` regions — those are out of scope for this text-only scanner.
 */
function stripComments(text: string): string {
  let out = '';
  let state: 'code' | 'line' | 'block' | 'str' | 'char' = 'code';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const d = text[i + 1];
    switch (state) {
      case 'code':
        if (c === '/' && d === '/') {
          state = 'line';
          i++;
        } else if (c === '/' && d === '*') {
          state = 'block';
          out += '  ';
          i++;
        } else if (c === '"') {
          state = 'str';
          out += c;
        } else if (c === "'") {
          state = 'char';
          out += c;
        } else {
          out += c;
        }
        break;
      case 'line':
        if (c === '\n') {
          state = 'code';
          out += c;
        }
        break;
      case 'block':
        if (c === '*' && d === '/') {
          state = 'code';
          out += '  ';
          i++;
        } else {
          out += c === '\n' ? '\n' : ' ';
        }
        break;
      case 'str':
      case 'char':
        out += c;
        if (c === '\\') {
          out += d ?? '';
          i++;
        } else if ((state === 'str' && c === '"') || (state === 'char' && c === "'")) {
          state = 'code';
        }
        break;
    }
  }
  return out;
}

/**
 * Workspace-wide `#include` graph, built by scanning source/header files and
 * resolving each directive against the including file's directory + include dirs.
 * clangd is not involved — this is pure text + path resolution, so it works even
 * without a compile database.
 */
export class IncludeIndex {
  private forward = new Map<string, IncludeRef[]>();
  private reverse = new Map<string, Set<string>>();
  private byPath = new Map<string, vscode.Uri>();
  private includeDirs: string[] = [];
  built = false;

  async build(): Promise<void> {
    this.forward.clear();
    this.reverse.clear();
    this.byPath.clear();
    this.includeDirs = configuredIncludeDirs();

    const files = await vscode.workspace.findFiles(SOURCE_GLOB, '**/node_modules/**');
    for (const uri of files) {
      this.byPath.set(normKey(uri.fsPath), uri);
    }

    // Read + parse files with bounded concurrency to overlap I/O on large trees.
    const decoder = new TextDecoder('utf-8');
    let i = 0;
    const worker = async (): Promise<void> => {
      while (i < files.length) {
        const uri = files[i++];
        let text: string;
        try {
          text = decoder.decode(await vscode.workspace.fs.readFile(uri));
        } catch {
          continue;
        }
        const refs: IncludeRef[] = parseIncludes(text).map((inc) => ({
          ...inc,
          target: this.resolve(uri, inc.spelling, inc.angle),
        }));
        // Keyed by the case-folded path (matching byPath), so a root URI whose
        // drive-letter/path casing differs from findFiles still resolves.
        this.forward.set(normKey(uri.fsPath), refs);
        for (const r of refs) {
          if (r.target) {
            const k = normKey(r.target.fsPath);
            let set = this.reverse.get(k);
            if (!set) {
              set = new Set();
              this.reverse.set(k, set);
            }
            set.add(uri.toString());
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(24, files.length) }, worker));
    this.built = true;
  }

  private resolve(includer: vscode.Uri, spelling: string, angle: boolean): vscode.Uri | undefined {
    const candidates: string[] = [];
    if (!angle) {
      candidates.push(path.join(path.dirname(includer.fsPath), spelling));
    }
    for (const dir of this.includeDirs) {
      candidates.push(path.join(dir, spelling));
    }
    for (const c of candidates) {
      const hit = this.byPath.get(normKey(c));
      if (hit) {
        return hit;
      }
    }
    return undefined;
  }

  /** Files/headers that `uri` includes (with resolution info). */
  includesOf(uri: vscode.Uri): IncludeRef[] {
    return this.forward.get(normKey(uri.fsPath)) ?? [];
  }

  /** Files that include `uri`. */
  includedBy(uri: vscode.Uri): vscode.Uri[] {
    const set = this.reverse.get(normKey(uri.fsPath));
    if (!set) {
      return [];
    }
    return [...set].map((s) => vscode.Uri.parse(s));
  }

  /** Whether the index knows this file at all (was scanned). */
  knows(uri: vscode.Uri): boolean {
    return this.forward.has(normKey(uri.fsPath));
  }
}

export type IncludeDirection = 'includes' | 'includedBy';

/** BFS the include graph from `root` into a model the call-graph webview can render. */
export function buildIncludeGraph(
  index: IncludeIndex,
  root: vscode.Uri,
  direction: IncludeDirection,
): GraphModel {
  const nodes = new Map<string, GraphModel['nodes'][number]>();
  const edges: GraphModel['edges'] = [];
  const edgeSeen = new Set<string>();
  const limit = maxDepth();

  const label = (uri: vscode.Uri) => {
    const rel = vscode.workspace.asRelativePath(uri, false);
    const slash = rel.lastIndexOf('/');
    return slash >= 0 ? rel.slice(slash + 1) : rel;
  };
  const ensure = (uri: vscode.Uri, depth: number, isRoot: boolean) => {
    const id = uri.toString();
    const existing = nodes.get(id);
    if (existing) {
      existing.depth = Math.min(existing.depth, depth);
      return id;
    }
    nodes.set(id, {
      id,
      label: label(uri),
      file: vscode.workspace.asRelativePath(uri, false),
      line: 1,
      uri: id,
      depth,
      isRoot,
    });
    return id;
  };
  const addEdge = (from: string, to: string) => {
    const k = from + ' ' + to;
    if (!edgeSeen.has(k)) {
      edgeSeen.add(k);
      edges.push({ from, to });
    }
  };

  const queue: { uri: vscode.Uri; depth: number }[] = [];
  const visited = new Set<string>();
  ensure(root, 0, true);
  queue.push({ uri: root, depth: 0 });
  visited.add(root.toString());

  while (queue.length > 0) {
    const { uri, depth } = queue.shift()!;
    if (depth >= limit) {
      continue;
    }
    const neighbors =
      direction === 'includes'
        ? index.includesOf(uri).map((r) => r.target).filter((u): u is vscode.Uri => !!u)
        : index.includedBy(uri);
    for (const n of neighbors) {
      if (!passesFilter(label(n), n)) {
        continue;
      }
      const nId = ensure(n, depth + 1, false);
      // Edge always points includer -> included.
      if (direction === 'includes') {
        addEdge(uri.toString(), nId);
      } else {
        addEdge(nId, uri.toString());
      }
      if (!visited.has(nId)) {
        visited.add(nId);
        queue.push({ uri: n, depth: depth + 1 });
      }
    }
  }

  return { direction, nodes: [...nodes.values()], edges };
}
