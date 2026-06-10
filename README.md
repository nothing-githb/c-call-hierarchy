<h1 align="center">C Call Hierarchy & References</h1>

<p align="center">
  See <b>who calls what</b>, <b>who reads vs writes</b> a symbol, and <b>what includes what</b> in C/C++ —
  powered by your <a href="https://clangd.llvm.org/">clangd</a>.
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=halistahasahin.c-call-hierarchy-references"><img alt="Marketplace version" src="https://img.shields.io/visual-studio-marketplace/v/halistahasahin.c-call-hierarchy-references?color=2d6cdf&label=Marketplace"></a>
  <img alt="VS Code" src="https://img.shields.io/badge/VS%20Code-%5E1.75-2d6cdf">
  <img alt="requires clangd" src="https://img.shields.io/badge/requires-clangd-8a56e2">
  <img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-3FB950">
</p>

<p align="center">
  <img alt="C Call Hierarchy & References — toggle callers/callees, parameter signatures, and a previewed call site"
       src="assets/hero.png" width="900">
</p>

clangd already knows your code. **C Call Hierarchy & References** re-presents what it knows the way you actually want
it: callers **and** callees at once, references split into **reads vs writes**, third-party noise filtered
out, and headers laid out as an include tree — without leaving the sidebar.

> It does **not** run its own language server. It consumes clangd's results through VS Code's provider
> commands, so accuracy equals clangd's accuracy — with zero extra setup.

---

## ✨ Features

### Call hierarchy — incoming or outgoing
Put the cursor on a function and run **Show call hierarchy**. The tree shows **callers (incoming)** or
**callees (outgoing)** — flip between them with the toggle in the view title. Nodes show the function's
**parameter types**, a **×N** badge when clangd merges several call sites into one, and are cycle-safe and
depth-capped. Selecting a node **previews** the call site — selected, centered and briefly flashed — while
**focus stays in the tree**, so you can keep arrowing up and down the hierarchy. The inline **Open in
editor** action jumps there for real and moves focus to the editor.

### Find references — read vs write
<img alt="References grouped by folder with read/write/declaration letter icons"
     src="assets/references.png" width="430" align="right">

**Find references** opens a dedicated tree where every occurrence is badged:

- <b style="color:#E69595">w</b> — **write** (assignment, `++`/`--`, compound assignment)
- <b style="color:#8FC79F">r</b> — **read**
- <b style="color:#5FB7C9">&</b> — **address-of** (`&x`) — a potential write through the pointer
- <b style="color:#D7BA1D">d</b> — **declaration / definition**
- **·** — unknown (e.g. inside a macro)

Group by **folder** or flat by **file**, toggle which kinds show with the **w r d ·** chips, and the
matched symbol is highlighted on each line. Read/write comes from clangd's `documentHighlight` roles, with
a syntactic fallback when the provider doesn't tag a role.

<br clear="right">

### Header includes
<img alt="Header include hierarchy"
     src="assets/includes.png" width="400" align="right">

**Show include hierarchy** on a file builds a tree of which headers it `#include`s — toggle to
**included-by** to see what pulls in the current header. Unresolved (system) includes are shown but not
expanded, and an **include graph** webview visualises the whole thing. This view is clangd-independent —
it scans `#include` directives directly, so it works even without a compile database.

<br clear="right">

### One filter for everything
A fixed **Filter** pane at the top searches by **function name or path** across all three views, live:

| You type | Match |
| --- | --- |
| `bus` | case-insensitive **contains** (name or path) |
| `src/net/**` | **glob** |
| `/drv_\d+/` | **regular expression** |

---

## ✅ Requirements

- The **clangd** extension (`llvm-vs-code-extensions.vscode-clangd`), installed and active — for the call
  hierarchy, references and signatures.
- A clangd index for your project: a `compile_commands.json` or `compile_flags.txt`.
- The **Header Includes** view needs no clangd — only the files on disk (set `cCallHierarchyReferences.includePaths`
  to resolve `<...>` includes).

> If both **clangd** and **ms-vscode.cpptools** are installed, make sure clangd is the active C/C++
> provider for best read/write accuracy.

## 🚀 Getting started

1. Install this extension and **clangd**, and open a C/C++ project that clangd can index.
2. Click the **C Call Hierarchy & References** icon in the Activity Bar.
3. Right-click a function → **Show call hierarchy** / **Find references**, or a file → **Show include
   hierarchy**.

## ⚙️ Settings

| Setting | Default | Description |
| --- | --- | --- |
| `cCallHierarchyReferences.maxDepth` | `32` | Max expansion/walk depth for the call and include trees. |
| `cCallHierarchyReferences.excludeGlobs` | `[]` | Deny-list of path globs hidden from all views. |
| `cCallHierarchyReferences.includeGlobs` | `[]` | Allow-list of path globs; empty = show everything. |
| `cCallHierarchyReferences.showSignatures` | `true` | Show caller parameter types in the call tree. |
| `cCallHierarchyReferences.includePaths` | `[]` | Extra include search dirs for resolving `#include <...>`. |

## 🧠 How it works

For call hierarchy, references and signatures the extension calls VS Code's built-in provider commands
(`prepareCallHierarchy`, `provideIncoming/OutgoingCalls`, `executeReferenceProvider`,
`executeDocumentHighlights`, `executeHoverProvider`) which delegate to **your clangd**. No second language
server is spawned. The Header Includes feature is a self-contained `#include` scanner that runs even
without a compile database (≈200 ms for a 2,000-file project, cached afterwards).

## ❓ FAQ

**Nothing shows up.** Make sure the clangd extension is installed, active, and has finished indexing
(watch its status item), and that clangd — not cpptools — is answering.

**Read/write looks wrong.** Read/write is recovered from clangd's highlight roles; if another provider
answers without roles, a syntactic fallback kicks in. Globals/struct fields are the clearest demo.

**Both callers and callees are shown — can I get only one?** Expand just the branch you care about; the
other stays collapsed.

## 🛠️ Develop

```sh
npm install
npm run compile      # or: npm run watch
```

Press **F5** to launch an Extension Development Host with the bundled `example-large/` project (regenerate
or scale it with `node tools/gen-large-example.js`).

## 📄 License

[MIT](LICENSE) © Halis Taha Sahin
