import * as vscode from 'vscode';
import { matchGlob, matchesQuery } from './textutil';

const SECTION = 'cCallHierarchyReferences';
const RUNTIME_KEY = 'cCallHierarchyReferences.runtimePathFilter';

export function excludeGlobs(): string[] {
  return vscode.workspace.getConfiguration(SECTION).get<string[]>('excludeGlobs', []);
}

export function includeGlobs(): string[] {
  return vscode.workspace.getConfiguration(SECTION).get<string[]>('includeGlobs', []);
}

export function maxDepth(): number {
  return vscode.workspace.getConfiguration(SECTION).get<number>('maxDepth', 32);
}

/** True if `uri` is hidden by the exclude (deny) list. */
export function isExcluded(uri: vscode.Uri, globs = excludeGlobs()): boolean {
  if (globs.length === 0) {
    return false;
  }
  const rel = vscode.workspace.asRelativePath(uri, false);
  return globs.some((g) => matchGlob(rel, g));
}

/** True if `uri` passes the include allow-list (empty list => everything allowed). */
function isIncluded(uri: vscode.Uri, globs = includeGlobs()): boolean {
  if (globs.length === 0) {
    return true;
  }
  const rel = vscode.workspace.asRelativePath(uri, false);
  return globs.some((g) => matchGlob(rel, g));
}

// ---- Runtime (interactive) path filter -------------------------------------

let runtimeFilter: string | undefined;
let stateStore: vscode.Memento | undefined;

/** Wire up persisted runtime-filter state. Call once from activate(). */
export function initFilterState(context: vscode.ExtensionContext): void {
  stateStore = context.workspaceState;
  runtimeFilter = stateStore.get<string>(RUNTIME_KEY) || undefined;
}

export function setRuntimeFilter(glob: string | undefined): void {
  runtimeFilter = glob && glob.trim() ? glob.trim() : undefined;
  void stateStore?.update(RUNTIME_KEY, runtimeFilter);
}

export function getRuntimeFilter(): string | undefined {
  return runtimeFilter;
}

/**
 * Single visibility predicate (true = SHOW). Composition:
 *   exclude (deny) wins  →  static include allow-list  →  runtime glob.
 * Note the polarity flip vs isExcluded: callers gate on `!isVisible(uri)` to hide.
 */
export function isVisible(uri: vscode.Uri): boolean {
  if (isExcluded(uri)) {
    return false;
  }
  if (!isIncluded(uri)) {
    return false;
  }
  return true;
}

/**
 * The interactive search/filter box. Matches the query against the symbol NAME
 * and the relative PATH (either may match):
 *   - `/regex/flags` → regular expression,
 *   - contains `*` or `?` → glob,
 *   - otherwise → case-insensitive "contains".
 */
export function matchesRuntimeFilter(name: string, uri: vscode.Uri): boolean {
  if (!runtimeFilter) {
    return true;
  }
  const rel = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
  return matchesQuery(runtimeFilter, [name, rel]);
}

/** Visible by file (exclude/include) AND matching the search box (name or path). */
export function passesFilter(name: string, uri: vscode.Uri): boolean {
  return isVisible(uri) && matchesRuntimeFilter(name, uri);
}

/** Search-box match against a bare name only (no file — e.g. unresolved includes). */
export function matchesRuntimeName(name: string): boolean {
  if (!runtimeFilter) {
    return true;
  }
  return matchesQuery(runtimeFilter, [name]);
}

