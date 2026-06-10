import * as vscode from 'vscode';
import { GraphModel } from './graph';

/** Singleton webview panel that renders a call graph and round-trips clicks. */
export class GraphView {
  private static panel: vscode.WebviewPanel | undefined;

  static show(model: GraphModel, extensionUri: vscode.Uri): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (GraphView.panel) {
      GraphView.panel.reveal(column);
    } else {
      GraphView.panel = vscode.window.createWebviewPanel(
        'cCallHierarchyReferences.graph',
        'Call Graph',
        column,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      GraphView.panel.onDidDispose(() => (GraphView.panel = undefined));
      GraphView.panel.webview.onDidReceiveMessage((msg) => {
        if (msg?.type === 'open' && typeof msg.uri === 'string') {
          const uri = vscode.Uri.parse(msg.uri);
          const line = Math.max(0, (msg.line ?? 1) - 1);
          vscode.window.showTextDocument(uri, {
            selection: new vscode.Range(line, 0, line, 0),
          });
        }
      });
    }
    const webview = GraphView.panel.webview;
    GraphView.panel.title = `Call Graph (${model.direction})`;
    webview.html = GraphView.render(webview, model);
  }

  private static render(webview: vscode.Webview, model: GraphModel): string {
    const nonce = nonceString();
    const data = JSON.stringify(model);
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  html, body { height: 100%; margin: 0; overflow: hidden;
    font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
  #toolbar { position: fixed; top: 8px; left: 8px; z-index: 10; font-size: 12px;
    background: var(--vscode-editor-background); opacity: .9; padding: 4px 8px;
    border: 1px solid var(--vscode-panel-border); border-radius: 4px; }
  #svg { width: 100vw; height: 100vh; cursor: grab; }
  .edge { stroke: var(--vscode-editorIndentGuide-activeBackground, #888); stroke-width: 1.2; fill: none; opacity: .7; }
  .node rect { fill: var(--vscode-editorWidget-background); stroke: var(--vscode-panel-border); rx: 4; }
  .node.root rect { stroke: var(--vscode-focusBorder); stroke-width: 2; }
  .node text { fill: var(--vscode-foreground); font-size: 12px; dominant-baseline: middle; cursor: pointer; }
  .node:hover rect { stroke: var(--vscode-focusBorder); }
</style>
</head>
<body>
<div id="toolbar"></div>
<svg id="svg"><g id="viewport"></g></svg>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const model = ${data};
const NODE_W = 180, NODE_H = 28, COL_GAP = 90, ROW_GAP = 14;

// Layered layout: column = depth, rows stacked within a column.
const byDepth = new Map();
for (const n of model.nodes) {
  if (!byDepth.has(n.depth)) byDepth.set(n.depth, []);
  byDepth.get(n.depth).push(n);
}
const pos = new Map();
let maxRows = 0;
for (const [depth, list] of [...byDepth.entries()].sort((a,b)=>a[0]-b[0])) {
  list.forEach((n, i) => {
    pos.set(n.id, { x: depth * (NODE_W + COL_GAP), y: i * (NODE_H + ROW_GAP) });
  });
  maxRows = Math.max(maxRows, list.length);
}

const vp = document.getElementById('viewport');
const svgNS = 'http://www.w3.org/2000/svg';

for (const e of model.edges) {
  const a = pos.get(e.from), b = pos.get(e.to);
  if (!a || !b) continue;
  const x1 = a.x + NODE_W, y1 = a.y + NODE_H/2;
  const x2 = b.x, y2 = b.y + NODE_H/2;
  const mx = (x1 + x2) / 2;
  const path = document.createElementNS(svgNS, 'path');
  path.setAttribute('class', 'edge');
  path.setAttribute('d', \`M\${x1},\${y1} C\${mx},\${y1} \${mx},\${y2} \${x2},\${y2}\`);
  vp.appendChild(path);
}

for (const n of model.nodes) {
  const p = pos.get(n.id);
  const g = document.createElementNS(svgNS, 'g');
  g.setAttribute('class', 'node' + (n.isRoot ? ' root' : ''));
  g.setAttribute('transform', \`translate(\${p.x},\${p.y})\`);
  const rect = document.createElementNS(svgNS, 'rect');
  rect.setAttribute('width', NODE_W); rect.setAttribute('height', NODE_H);
  const text = document.createElementNS(svgNS, 'text');
  text.setAttribute('x', 8); text.setAttribute('y', NODE_H/2);
  const label = n.label.length > 24 ? n.label.slice(0,23) + '…' : n.label;
  text.textContent = label;
  const title = document.createElementNS(svgNS, 'title');
  title.textContent = n.label + '\\n' + n.file + ':' + n.line;
  g.appendChild(rect); g.appendChild(text); g.appendChild(title);
  g.addEventListener('click', () => vscode.postMessage({ type:'open', uri:n.uri, line:n.line }));
  vp.appendChild(g);
}

document.getElementById('toolbar').textContent =
  model.nodes.length + ' nodes · ' + model.edges.length + ' edges · ' + model.direction;

// Pan & zoom. Frame so the leftmost node (callers can be at negative x) is visible.
const svg = document.getElementById('svg');
let minX = Infinity, minY = Infinity;
for (const p of pos.values()) { if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; }
if (!isFinite(minX)) { minX = 0; minY = 0; }
let scale = 1, tx = 30 - minX, ty = 30 - minY, dragging = false, sx = 0, sy = 0;
function apply(){ vp.setAttribute('transform', \`translate(\${tx},\${ty}) scale(\${scale})\`); }
apply();
svg.addEventListener('mousedown', e => { dragging = true; sx = e.clientX - tx; sy = e.clientY - ty; svg.style.cursor='grabbing'; });
window.addEventListener('mouseup', () => { dragging = false; svg.style.cursor='grab'; });
window.addEventListener('mousemove', e => { if(!dragging) return; tx = e.clientX - sx; ty = e.clientY - sy; apply(); });
svg.addEventListener('wheel', e => {
  e.preventDefault();
  const f = e.deltaY < 0 ? 1.1 : 1/1.1;
  const mx = e.clientX, my = e.clientY;
  tx = mx - (mx - tx) * f; ty = my - (my - ty) * f; scale *= f; apply();
}, { passive: false });
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
