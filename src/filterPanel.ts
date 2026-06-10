import * as vscode from 'vscode';
import { KindCat } from './referencesProvider';

export interface FilterPanelCallbacks {
  onFilter: (value: string | undefined) => void;
  onToggleKind: (cat: KindCat) => void;
  getKindStates: () => Record<KindCat, boolean>;
}

/**
 * Always-visible webview pane at the top of the container: a live name/path
 * search box plus read/write/decl toggle chips for the References view.
 */
export class FilterPanelProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'cCallHierarchyReferences.filterPanel';

  private view: vscode.WebviewView | undefined;
  private current = '';

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly cb: FilterPanelCallbacks,
  ) {}

  /** Reflect a filter value set elsewhere into the input. */
  setValue(value: string | undefined): void {
    this.current = value ?? '';
    void this.view?.webview.postMessage({ type: 'value', value: this.current });
  }

  /** Push the current reference-kind chip states to the webview. */
  updateKinds(): void {
    void this.view?.webview.postMessage({ type: 'kinds', states: this.cb.getKindStates() });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((msg: { type: string; value?: string; cat?: KindCat }) => {
      if (msg.type === 'filter') {
        const v = (msg.value ?? '').trim();
        this.current = v;
        this.cb.onFilter(v ? v : undefined);
      } else if (msg.type === 'toggleKind' && msg.cat) {
        this.cb.onToggleKind(msg.cat);
        this.updateKinds();
      }
    });
    void view.webview.postMessage({ type: 'value', value: this.current });
    this.updateKinds();
  }

  private html(webview: vscode.Webview): string {
    const nonce = nonceString();
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  body { margin: 0; padding: 6px 8px; font-family: var(--vscode-font-family); }
  .row { display: flex; gap: 4px; align-items: center; }
  input {
    flex: 1; min-width: 0; padding: 3px 6px;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px; outline: none; font-size: 12px;
  }
  input:focus { border-color: var(--vscode-focusBorder); }
  button {
    flex: 0 0 auto; padding: 3px 6px; cursor: pointer;
    color: var(--vscode-foreground);
    background: var(--vscode-button-secondaryBackground, transparent);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 2px;
  }
  button:hover { background: var(--vscode-toolbar-hoverBackground); }
  .kinds { display: flex; gap: 5px; align-items: center; margin-top: 6px; }
  .kinds .lbl { font-size: 11px; opacity: .6; margin-right: 2px; }
  .chip {
    width: 18px; height: 18px; line-height: 18px; text-align: center;
    border-radius: 3px; font-size: 12px; cursor: pointer; user-select: none;
    border: 1px solid currentColor;
  }
  .chip.w { color: #E69595; }
  .chip.r { color: #8FC79F; }
  .chip.a { color: #5FB7C9; }
  .chip.d { color: #D7BA1D; }
  .chip.u { color: #9DA5B4; }
  .chip.off { opacity: .3; }
  .hint { margin-top: 6px; font-size: 11px; opacity: .6; }
</style>
</head>
<body>
<div class="row">
  <input id="f" type="text" spellcheck="false"
    placeholder="filter by name or path…" aria-label="Filter" />
  <button id="c" title="Clear filter">Clear</button>
</div>
<div class="kinds" title="Toggle which reference kinds are shown">
  <span class="lbl">refs:</span>
  <span class="chip w" data-k="w" title="Write">w</span>
  <span class="chip r" data-k="r" title="Read">r</span>
  <span class="chip a" data-k="a" title="Address-of (&amp;)">&amp;</span>
  <span class="chip d" data-k="d" title="Declaration / definition">d</span>
  <span class="chip u" data-k="u" title="Unknown">·</span>
</div>
<div class="hint">Name/path: contains · <code>src/**</code> glob · <code>/re/</code> regex. Chips filter the References view.</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const f = document.getElementById('f');
const c = document.getElementById('c');
let t;
function send() { clearTimeout(t); vscode.postMessage({ type: 'filter', value: f.value }); }
f.addEventListener('input', () => { clearTimeout(t); t = setTimeout(send, 250); });
f.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
c.addEventListener('click', () => { f.value = ''; send(); f.focus(); });
document.querySelectorAll('.chip').forEach((el) => {
  el.addEventListener('click', () => vscode.postMessage({ type: 'toggleKind', cat: el.dataset.k }));
});
window.addEventListener('message', (e) => {
  const m = e.data;
  if (!m) return;
  if (m.type === 'value' && document.activeElement !== f) { f.value = m.value; }
  if (m.type === 'kinds') {
    for (const k of ['w','r','a','d','u']) {
      const el = document.querySelector('.chip[data-k="' + k + '"]');
      if (el) el.classList.toggle('off', !m.states[k]);
    }
  }
});
</script>
</body>
</html>`;
  }
}

function nonceString(): string {
  let s = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}
