# Changelog

All notable changes to **C Call Hierarchy & References** are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.28]

### Removed
- **Trimmed redundant commands.** Removed **Set path filter…**, **Clear path filter**, and **Filter
  references by kind** — the always-visible **Filter** pane already does all of this (its input, **Clear**
  button, and **w / r / & / d / ·** chips), so the separate Command Palette entries were dead duplicates.
  Also removed **Next call site** from the Command Palette: it is the call-tree node's own Enter/click
  command (`TreeItem.command`), not meant to be run from the palette. No behaviour changes — the call tree,
  references and filtering all work exactly as before.

## [0.1.27]

### Changed
- **A path filter match shows the path once, in the label, with the description dropped.** When the Filter
  matches a node's path, the path is shown in the label (matched part tinted) and the **description is
  dropped** for that node, so the path isn't shown twice. (VS Code can't grey the non-matched part of a
  label, so the path there is in the normal colour; a name-only match still keeps its description.)

## [0.1.26]

### Changed
- **Path-match highlight now leaves the rest of the node unchanged.** When the Filter matches a node's
  path, the path's matched part is tinted in the label, but the **description is left exactly as before**
  (it still shows the full `params · path` in grey) — only the highlight is added. (VS Code only supports
  highlighting the matched range on the label, so the non-matched path text can't be greyed there.)

## [0.1.25]

### Added
- **Filter matches in the path are highlighted too.** When a **Filter** query matches a call-tree node's
  **path** (e.g. `src/bus`), the path is now shown next to the name in the node label with the matched part
  tinted — previously only name matches were highlighted (the path sits in the description, which VS Code
  can't highlight, so it's surfaced in the label when it matches).

### Changed
- **New icon:** a white call-tree mark on a rounded **blue** background, so the extension stands out in the
  Extensions list and Marketplace (was a faint monochrome mark on a transparent background).

### Removed
- The **`excludeGlobs`** and **`includeGlobs`** settings. The fixed **Filter** pane already filters by name
  or path live (contains / glob / `/regex/`), so the static glob lists were redundant.

## [0.1.24]

### Changed
- **Enter now acts on the node you're on — including via the arrow keys.** The Enter-walk no longer goes
  through a keybinding that read the (arrow-stale) selection. Instead each call-tree node's **own command**
  runs, which VS Code invokes for the **focused** node on Enter. So arrowing down to a callee and pressing
  **Enter** goes to that callee's call site; on a **×N** node each Enter steps to the next merged call site
  (wrapping). Clicking a node does the same. (This restores the pre-0.1.17 "Enter runs the focused node's
  command" behaviour, with the ×N stepping layered on top.)

## [0.1.23]

### Fixed
- **Reverted the 0.1.22 change, which broke Enter entirely.** 0.1.22 tried to make Enter follow the arrow
  keys by recording the focused node from each node's activation command — but VS Code does **not** run that
  command on arrow navigation, so the recorded node was never set and Enter could end up doing nothing.
  Enter again reliably steps a node's ×N call sites; select the node (click it) first.

### Known limitation
- Switching which node Enter walks by **arrow keys alone** isn't possible: VS Code's tree moves keyboard
  *focus* with the arrows but does not update the view *selection*, and gives the extension no signal on
  arrow navigation. Click a node to make Enter act on it, or use the inline **Open in editor** action (which
  walks a node's sites per-click regardless of selection).

## [0.1.21]

### Fixed
- **Enter on a ×N node could feel "stuck" on the previously walked node — hardened.** The Enter keybinding
  now fires for the whole call tree (no longer gated on an async context key), and `Next call site` always
  acts on the **currently selected** node, so after walking one node, arrowing to another function and
  pressing **Enter** reliably switches to *that* node.

### Tests
- Added an integration test that drives the **real view selection** (select a node, press Enter with no
  argument — exactly what the keybinding does) and asserts Enter acts on the selected node and switches when
  the selection changes. The earlier test only called the command with an explicit node, so it could not
  catch a selection-path regression.

## [0.1.20]

### Added
- **Filter matches are highlighted in the call tree.** When you type in the **Filter** pane, the part of
  each call-tree function name the query matches is tinted (the standard list match-highlight) — so it's
  clear at a glance why a node is shown. Works for plain **contains** queries (every occurrence) and
  `/regex/` queries; glob queries match the path, so nothing in the name is highlighted.

## [0.1.19]

### Added
- **Walk a ×N node's call sites with Enter — fixed and back.** Pressing **Enter** on a node that merges
  several call sites (the **×N** badge) steps to the next site, previewing each while focus stays in the
  tree, wrapping around. This complements the re-click **Open in editor** walk (which opens each site for
  real). Both walks are **per-node**: after stepping through one node, arrowing to another function and
  pressing **Enter** acts on *that* node — it no longer keeps walking the previous node's sites. The
  per-node cursor is the unit-tested pure `nextSiteIndex`, and a new integration test drives the real
  Enter command and asserts the walk plus the reset-after-switching-nodes invariant.

## [0.1.18]

### Changed
- **Walk a ×N node's merged call sites by re-clicking _Open in editor_.** Each click of the inline
  **Open in editor** action on a node that merges several call sites (the **×N** badge) opens the next
  site, wrapping around. The cursor is **per-node**, so the walk never leaks into another node.

### Fixed
- **Enter no longer gets stuck cycling a ×N node.** Pressing **Enter** now always previews the focused
  node, so arrowing to another function and pressing Enter goes to *that* function — instead of continuing
  to step through the previously selected ×N node's call sites.

### Removed
- The **Go to call site…** quick-pick action and the Enter-to-cycle keybinding (`nextCallSite` /
  `goToCallSite` commands), superseded by the re-click **Open in editor** walk above.

## [0.1.17]

### Added
- **Keyboard: walk a ×N node's call sites with Enter.** With a call-tree node that merges several call
  sites (the **×N** badge) selected, pressing **Enter** steps to the next call site — previewing each and
  wrapping around — while focus stays in the tree. Other nodes keep the normal Enter behaviour.

## [0.1.16]

### Docs
- README screenshots now use **absolute image URLs** so they render on the **Marketplace** page (relative
  paths only resolve on GitHub / in VS Code).
- Clarified that the extension works with **any C/C++ provider — clangd (recommended) or Microsoft C/C++**
  (`ms-vscode.cpptools`) — not clangd only. (Both are exercised by the integration tests.)

### Tests
- Added integration coverage for the v0.1.15 changes: coloured symbol icons, the ×N **call-site picker**
  (clangd merges call sites into one node; cpptools returns one node each — both verified), and the
  folder-mode **expand-on-open**.

## [0.1.15]

### Added
- **Browse a node's multiple call sites.** When the call tree merges several call sites into one node
  (the **×N** badge), a new inline **Go to call site…** action opens a quick pick — arrow to preview each
  site, Enter to open it.

### Fixed
- **Find references** now shows results directly in **folder** grouping: the top folder levels render
  expanded (it previously opened to a row of collapsed folders, looking empty).
- Call-tree **symbol icons** are now coloured with the theme's standard `symbolIcon.*` colours (the `ƒ`
  and friends match VS Code's built-in call hierarchy / outline) instead of monochrome.

## [0.1.14]

### Removed
- The **Header Includes** view, its commands (show include hierarchy, toggle includes / included-by,
  rescan, open include graph), and the `cCallHierarchyReferences.includePaths` setting. The extension now
  focuses on the call hierarchy and read/write references.

## [0.1.13]

### Changed
- Renamed the internal command / setting / view identifier prefix `cCallHierarchy.*` →
  `cCallHierarchyReferences.*` to match the extension name. Settings keys (e.g.
  `cCallHierarchyReferences.maxDepth`, `cCallHierarchyReferences.includePaths`) and command ids changed
  accordingly. Pre-release, so no published users are affected — if you set any `cCallHierarchy.*` keys
  locally, rename them to the new prefix.

## [0.1.12]

### Changed
- Renamed to **C Call Hierarchy & References** (extension id `c-call-hierarchy-references`) to avoid a
  display-name clash with another extension. The command and setting identifiers (`cCallHierarchy.*`) are
  unchanged, so keybindings and settings keep working.

## [0.1.11]

### Changed
- New **monochrome icon** (transparent background): a branching call tree with directional arrows that
  also reads as the read/write reference split — a hollow callee (read) and a filled callee (write).
  The Activity Bar icon and README screenshots were updated to match.

## [0.1.10]

### Fixed
- **Address-of** detection now handles a parenthesised base whose member is taken outside the parens —
  `&(cfg).field` (≡ `&(cfg.field)`): the field is flagged address-of and `cfg` is no longer mis-flagged.
  Adds to the already-supported `&(x)`, `&(cfg.field)`, `&((x))`, `&( x )`, `&(p->a->b)`, `&(arr[i].field)`.

## [0.1.9]

### Added
- **Browse without leaving the panel.** Selecting a call-tree node now **previews** the call site
  (or, for the root, the definition) while keeping focus in the tree — so you can keep arrowing up and
  down the hierarchy. An inline **Open in editor** (`$(go-to-file)`) action on each node opens the
  location for real and moves focus to the editor.

## [0.1.8]

### Fixed
- Invoking call hierarchy on a function's **header declaration** (e.g. a prototype in a `.h`) now
  re-anchors the root to its **definition**. Previously the root stayed on the declaration, so clangd
  stripped the call-site ranges of its outgoing calls (they live in the `.c`), and clicking a callee
  opened the callee's *definition* instead of the place it is called. Callee → call site now works
  regardless of whether you start from the declaration or the definition. Verified under clangd and cpptools.

## [0.1.7]

### Tests
- Added an integration test that drives the **real `CallTreeProvider`** and asserts the actual
  `command.arguments` each node opens: **root → definition**, **caller → call site** (in the caller),
  **callee → call site** (in the inspected function). Verified under **both clangd and cpptools**.
  `activate()` now returns the tree provider so tests can exercise it (no runtime change).

## [0.1.6]

### Fixed
- Clicking the **root** node (the function itself, at the top of the tree) now opens the function's
  **definition** instead of its header declaration. The root uses the call-hierarchy item's own
  (definition-preferring) location directly, rather than running go-to-definition — which, when invoked
  from the definition, could bounce to the prototype in the header.

### Tests
- The integration suites now also assert the root's click target resolves to the `.c` definition (not a
  header), verified under **both clangd and cpptools**.

## [0.1.5]

### Changed
- Hardened the click-to-open command (no longer relies on `instanceof` to tell a call site from a
  definition).

### Tests
- Added **real clangd integration tests** that drive the configured clangd over LSP and the VS Code
  command layer, verifying that outgoing calls keep their `fromRanges` and that a callee's click target
  lands on the line that actually calls it — across several functions in the example workspace. The
  headless LSP test runs on every package; `npm run test:vscode` runs the full VS Code + clangd suite.

## [0.1.4]

### Fixed
- Clicking a node always jumps to the **call site** (where the function is called) when one exists —
  for callees too. Only when clangd provides no call site does it fall back to the symbol's
  **definition** (resolved decl→def), never a raw header declaration.
- The **callee list** no longer drops functions whose clangd item resolves to a header prototype:
  for the outgoing direction, file `excludeGlobs`/`includeGlobs` no longer hide header-anchored callees
  (the name/path search filter still applies).

## [0.1.3]

### Changed
- The call tree now shows **one direction at a time** — callers (incoming) **or** callees (outgoing) —
  toggled from the view title, instead of both branches at once. The subtitle shows the active direction.

## [0.1.2]

### Changed
- **Address-of** now also recognises parenthesised forms: `&(x)`, `&(cfg.field)`, `&((x))`.
- The read/write, address-of and search-matching logic moved to a dependency-free module with a
  unit-test suite that runs automatically on every package (`npm test` via `vscode:prepublish`).

## [0.1.1]

### Fixed
- Call-tree click now jumps to the **actual call site in the correct file**. Outgoing (Calls) nodes
  previously opened the callee's file at the *caller's* line number — they now open the calling
  function's file at the call.
- **Address-of** (`&a.b.c`) now targets the chain's last component (`c`), with `a`/`b` read — and
  correctly excludes bitwise `a & x` / logical `a && x` and handles `return &x` / `sizeof &x`.

## [0.1.0] — Initial release

### Call hierarchy
- Shows **callers and callees at once** (Callers / Calls branches per root) with per-branch counts.
- Caller **parameter-type signatures** in the node description and full declaration in the tooltip
  (`cCallHierarchy.showSignatures`).
- **×N** badge and tooltip list when clangd merges multiple call sites into one node.
- Cycle-safe, depth-capped (`cCallHierarchy.maxDepth`); theme symbol colors.
- Click → the call site is selected, centered and briefly flashed.

### Find references (read / write)
- Dedicated tree with **read / write / address-of / declaration** letter icons (`r` / `w` / `&` / `d`)
  and a neutral dot. `&x` (address taken — a potential write through the pointer) is flagged distinctly.
- Group by **folder** (nested, compacted) or flat by **file**; toggle with the title action.
- **Kind filter chips** (`w r d ·`) in the Filter pane.
- The matched symbol is highlighted on each result line.
- Read/write from clangd's `documentHighlight` roles, with a syntactic fallback.

### Header includes
- `#include` hierarchy with **includes** / **included-by** directions and unresolved-include leaves.
- Visual **include graph** webview.
- Pure text scanner — works without a compile database; `cCallHierarchy.includePaths` for `<...>` resolution.

### Filtering
- Fixed **Filter** pane: live search by **name or path** (contains / glob / `/regex/`) across all views,
  plus `excludeGlobs` / `includeGlobs` settings.

[0.1.28]: https://github.com/nothing-githb/c-call-hierarchy-references/releases/tag/v0.1.28
[0.1.27]: https://github.com/nothing-githb/c-call-hierarchy-references/releases/tag/v0.1.27
[0.1.26]: https://github.com/nothing-githb/c-call-hierarchy-references/releases/tag/v0.1.26
[0.1.25]: https://github.com/nothing-githb/c-call-hierarchy-references/releases/tag/v0.1.25
[0.1.24]: https://github.com/nothing-githb/c-call-hierarchy-references/releases/tag/v0.1.24
[0.1.23]: https://github.com/nothing-githb/c-call-hierarchy-references/releases/tag/v0.1.23
[0.1.21]: https://github.com/nothing-githb/c-call-hierarchy-references/releases/tag/v0.1.21
[0.1.20]: https://github.com/nothing-githb/c-call-hierarchy-references/releases/tag/v0.1.20
[0.1.19]: https://github.com/nothing-githb/c-call-hierarchy-references/releases/tag/v0.1.19
[0.1.18]: https://github.com/nothing-githb/c-call-hierarchy-references/releases/tag/v0.1.18
[0.1.17]: https://github.com/nothing-githb/c-call-hierarchy-references/releases/tag/v0.1.17
[0.1.16]: https://github.com/nothing-githb/c-call-hierarchy-references/releases/tag/v0.1.16
[0.1.15]: https://github.com/nothing-githb/c-call-hierarchy-references/releases/tag/v0.1.15
[0.1.14]: https://github.com/nothing-githb/c-call-hierarchy-references/releases/tag/v0.1.14
[0.1.13]: https://github.com/nothing-githb/c-call-hierarchy-references/releases/tag/v0.1.13
[0.1.12]: https://github.com/nothing-githb/c-call-hierarchy-references/releases/tag/v0.1.12
[0.1.11]: https://github.com/nothing-githb/c-call-hierarchy-references/releases/tag/v0.1.11
[0.1.10]: https://github.com/nothing-githb/c-call-hierarchy-references/releases/tag/v0.1.10
[0.1.9]: https://github.com/nothing-githb/c-call-hierarchy-references/releases/tag/v0.1.9
[0.1.8]: https://github.com/nothing-githb/c-call-hierarchy-references/releases/tag/v0.1.8
[0.1.7]: https://github.com/nothing-githb/c-call-hierarchy-references/releases/tag/v0.1.7
[0.1.6]: https://github.com/nothing-githb/c-call-hierarchy-references/releases/tag/v0.1.6
[0.1.5]: https://github.com/nothing-githb/c-call-hierarchy-references/releases/tag/v0.1.5
[0.1.4]: https://github.com/nothing-githb/c-call-hierarchy-references/releases/tag/v0.1.4
[0.1.3]: https://github.com/nothing-githb/c-call-hierarchy-references/releases/tag/v0.1.3
[0.1.2]: https://github.com/nothing-githb/c-call-hierarchy-references/releases/tag/v0.1.2
[0.1.1]: https://github.com/nothing-githb/c-call-hierarchy-references/releases/tag/v0.1.1
[0.1.0]: https://github.com/nothing-githb/c-call-hierarchy-references/releases/tag/v0.1.0
