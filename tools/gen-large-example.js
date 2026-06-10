/*
 * Generates a deterministic, fully self-contained C project under ../example-large.
 * NO standard-library headers are used, so the #include graph resolves entirely
 * inside the workspace.
 *
 * Layered header hierarchy (each layer includes the one below):
 *   main.c -> app.h -> svc_*.h -> drv_*.h -> hal_*.h -> bus.h / util.h -> common.h
 *
 * Call hierarchy mirrors the layers (downward only, no cycles):
 *   dispatch/app -> service -> driver -> hal -> bus_write/bus_read/util_log
 * The base hubs are the busiest nodes — sized to stay at/under ~100 callers;
 * dispatch/init have a dozen-ish callees.
 *
 * Also emits compile_commands.json (absolute paths) so clangd indexes every TU.
 */
const fs = require('fs');
const path = require('path');

// Size and output dir are configurable via env, e.g.
//   OUT=example-xl HAL=400 DRV=400 SVC=200 K=30 node tools/gen-large-example.js
// Defaults are sized so the busiest hub stays at/under ~100 callers:
//   hub callers = (HAL + DRV + SVC + 1) * K + 2.
const OUT = process.env.OUT || 'example-large';
const ROOT = path.resolve(__dirname, '..', OUT);
const INC = path.join(ROOT, 'include');
const SRC = path.join(ROOT, 'src');

const HAL = +(process.env.HAL || 5); // hardware-abstraction modules
const DRV = +(process.env.DRV || 5); // driver modules
const SVC = +(process.env.SVC || 4); // service modules
const K = +(process.env.K || 6);     // functions per module

// Best-effort clean; the dir may be locked if it is open in VS Code, so fall
// back to overwriting in place (the file set is stable).
try {
  fs.rmSync(ROOT, { recursive: true, force: true });
} catch {
  /* locked by an open editor — overwrite files instead */
}
fs.mkdirSync(INC, { recursive: true });
fs.mkdirSync(SRC, { recursive: true });

const w = (p, s) => fs.writeFileSync(p, s.replace(/\n+$/, '\n'));
const fwd = (p) => p.replace(/\\/g, '/');

// ---- L0: common.h (no includes) — global read/write targets -----------------
w(path.join(INC, 'common.h'), `#ifndef COMMON_H
#define COMMON_H

#define BUS_REGS 256

/* A struct whose FIELDS are read & written in many places (struct-field demo). */
typedef struct {
    int mode;
    int level;
    int flags;
    int errors;
} config_t;

/* Global state — exercised by Find References (read vs write). */
extern int      g_bus[BUS_REGS];
extern int      g_state;
extern long     g_counter;
extern int      g_reads;
extern int      g_writes;
extern config_t g_cfg;        /* global struct instance */
extern int      g_events[32];

#endif /* COMMON_H */
`);

// ---- L1: bus + util (the hubs) ---------------------------------------------
w(path.join(INC, 'bus.h'), `#ifndef BUS_H
#define BUS_H
#include "common.h"

void bus_write(int reg, int val);
int  bus_read(int reg);

#endif /* BUS_H */
`);
w(path.join(SRC, 'bus.c'), `#include "bus.h"

int  g_bus[BUS_REGS];
int  g_state;
long g_counter;
int  g_reads;
int  g_writes;

void bus_write(int reg, int val) {
    g_bus[reg & (BUS_REGS - 1)] = val;   /* write */
    g_writes++;                          /* write */
}

int bus_read(int reg) {
    g_reads++;                           /* write */
    return g_bus[reg & (BUS_REGS - 1)];  /* read */
}
`);

w(path.join(INC, 'util.h'), `#ifndef UTIL_H
#define UTIL_H
#include "common.h"

void util_log(int code);
int  util_mix(int a, int b);

#endif /* UTIL_H */
`);
w(path.join(SRC, 'util.c'), `#include "util.h"

void util_log(int code) {
    g_counter += code;          /* write */
}

int util_mix(int a, int b) {
    int s = g_state;            /* read */
    return (a ^ (b << 1)) + s;
}
`);

// ---- L1: state — struct-field & global read/write demo ---------------------
w(path.join(INC, 'state.h'), `#ifndef STATE_H
#define STATE_H
#include "common.h"

void cfg_set_mode(int m);
int  cfg_get_mode(void);
void cfg_bump_level(void);
int  cfg_level(void);
void cfg_enable(int bit);
void cfg_disable(int bit);
int  cfg_is_enabled(int bit);
void state_tick(int ev);
int  state_health(void);
void state_record(int idx, int value);
void state_load(int *dst);

#endif /* STATE_H */
`);
w(path.join(SRC, 'state.c'), `#include "state.h"

config_t g_cfg;
int      g_events[32];

/* --- struct field writes --- */
void cfg_set_mode(int m) {
    g_cfg.mode = m;                 /* write field: mode */
}
void cfg_bump_level(void) {
    g_cfg.level++;                  /* write field: level (read-modify-write) */
}
void cfg_enable(int bit) {
    g_cfg.flags |= (1 << bit);      /* write field: flags */
}
void cfg_disable(int bit) {
    g_cfg.flags &= ~(1 << bit);     /* write field: flags */
}

/* --- struct field reads --- */
int cfg_get_mode(void) {
    return g_cfg.mode;              /* read field: mode */
}
int cfg_level(void) {
    return g_cfg.level;             /* read field: level */
}
int cfg_is_enabled(int bit) {
    return (g_cfg.flags >> bit) & 1;   /* read field: flags */
}

/* --- mixed global + field read/write --- */
void state_tick(int ev) {
    g_events[ev & 31] = g_state;       /* write array elem, read g_state */
    g_counter += g_cfg.level;          /* write g_counter, read field level */
    if (g_state > 100) {               /* read g_state */
        g_state = 0;                   /* write g_state */
        g_cfg.errors++;                /* write field: errors */
    }
    g_state += cfg_get_mode();         /* read+write g_state */
    state_load(&g_state);              /* address-of g_state (& — potential write) */
    state_load(&g_cfg.errors);         /* address-of g_cfg / field */
}

/* writes through the pointer — why &g_state is a potential write */
void state_load(int *dst) {
    *dst = g_counter & 0xff;           /* write via pointer */
}

int state_health(void) {
    int e = g_cfg.errors;              /* read field: errors */
    if (g_counter > 1000) {            /* read g_counter */
        return g_state - e;            /* read g_state, read e */
    }
    return g_cfg.level + g_events[0];  /* read field: level, read array elem */
}

void state_record(int idx, int value) {
    g_events[idx & 31] = value;        /* write array elem */
    g_cfg.mode = g_events[idx & 31];   /* write field mode, read array elem */
}
`);

// ---- L2: HAL modules (include bus + util) ----------------------------------
for (let h = 0; h < HAL; h++) {
  let hdr = `#ifndef HAL_${h}_H\n#define HAL_${h}_H\n#include "bus.h"\n#include "util.h"\n\n`;
  for (let i = 0; i < K; i++) hdr += `int hal${h}_f${i}(int x);\n`;
  hdr += `\n#endif /* HAL_${h}_H */\n`;
  w(path.join(INC, `hal_${h}.h`), hdr);

  let c = `#include "hal_${h}.h"\n\n`;
  for (let i = 0; i < K; i++) {
    const reg = h * 16 + i;
    c += `int hal${h}_f${i}(int x) {\n`;
    c += `    g_counter++;                  /* write */\n`;
    c += `    int s = g_state;              /* read  */\n`;
    c += `    util_log(x + ${i});           /* hub */\n`;
    c += `    bus_write(${reg}, s + x);      /* hub */\n`;
    c += `    int r = bus_read(${reg});      /* hub */\n`;
    c += `    g_state = util_mix(r, x) & 0xffff;   /* write */\n`;
    c += `    return r + s + x;\n`;
    c += `}\n\n`;
  }
  w(path.join(SRC, `hal_${h}.c`), c);
}

// ---- L3: driver modules (each includes 2 HAL headers) ----------------------
for (let d = 0; d < DRV; d++) {
  const a = d % HAL;
  const b = (d + 1) % HAL;
  let hdr = `#ifndef DRV_${d}_H\n#define DRV_${d}_H\n#include "hal_${a}.h"\n#include "hal_${b}.h"\n\n`;
  for (let i = 0; i < K; i++) hdr += `int drv${d}_f${i}(int x);\n`;
  hdr += `\n#endif /* DRV_${d}_H */\n`;
  w(path.join(INC, `drv_${d}.h`), hdr);

  let c = `#include "drv_${d}.h"\n\n`;
  for (let i = 0; i < K; i++) {
    c += `int drv${d}_f${i}(int x) {\n`;
    c += `    util_log(x);                  /* hub */\n`;
    c += `    int u = hal${a}_f${i % K}(x);\n`;
    c += `    int v = hal${b}_f${(i + 1) % K}(u);\n`;
    c += `    bus_write(${d * 16 + i}, u + v);   /* hub */\n`;
    c += `    return u + v;\n`;
    c += `}\n\n`;
  }
  w(path.join(SRC, `drv_${d}.c`), c);
}

// ---- L4: service modules (each includes 2 driver headers) ------------------
for (let s = 0; s < SVC; s++) {
  const a = s % DRV;
  const b = (s + 3) % DRV;
  let hdr = `#ifndef SVC_${s}_H\n#define SVC_${s}_H\n#include "drv_${a}.h"\n#include "drv_${b}.h"\n\n`;
  for (let i = 0; i < K; i++) hdr += `int svc${s}_f${i}(int x);\n`;
  hdr += `\n#endif /* SVC_${s}_H */\n`;
  w(path.join(INC, `svc_${s}.h`), hdr);

  let c = `#include "svc_${s}.h"\n\n`;
  for (let i = 0; i < K; i++) {
    c += `int svc${s}_f${i}(int x) {\n`;
    c += `    util_log(x);                  /* hub */\n`;
    c += `    int p = drv${a}_f${i % K}(x);\n`;
    c += `    int q = drv${b}_f${(i + 2) % K}(p);\n`;
    c += `    bus_write(${s * 16 + i}, p ^ q);   /* hub */\n`;
    c += `    return p + q;\n`;
    c += `}\n\n`;
  }
  w(path.join(SRC, `svc_${s}.c`), c);
}

// ---- L5: app.h umbrella (includes all services) + dispatch/init ------------
let appHdr = `#ifndef APP_H\n#define APP_H\n`;
for (let s = 0; s < SVC; s++) appHdr += `#include "svc_${s}.h"\n`;
appHdr += `#include "bus.h"\n#include "util.h"\n#include "state.h"\n\n`;
for (let i = 0; i < K; i++) appHdr += `int app_f${i}(int x);\n`;
appHdr += `void dispatch(int ev);\nvoid init_all(void);\n\n#endif /* APP_H */\n`;
w(path.join(INC, 'app.h'), appHdr);

let app = `#include "app.h"\n\n`;
for (let i = 0; i < K; i++) {
  app += `int app_f${i}(int x) {\n`;
  app += `    util_log(x);                  /* hub */\n`;
  app += `    int a = svc${i % SVC}_f${i % K}(x);\n`;
  app += `    int b = svc${(i + 2) % SVC}_f${(i + 1) % K}(a);\n`;
  app += `    bus_write(${i}, a + b);        /* hub */\n`;
  app += `    return a + b;\n`;
  app += `}\n\n`;
}
// dispatch: dozens of callees
app += `void dispatch(int ev) {\n    util_log(ev);\n`;
app += `    cfg_set_mode(ev & 3);\n`;
app += `    state_tick(ev);\n`;
app += `    state_record(ev, g_state);   /* read g_state */\n`;
for (let s = 0; s < SVC; s++) {
  app += `    bus_write(${s}, svc${s}_f0(ev + ${s}));\n`;
  app += `    bus_write(${s + SVC}, svc${s}_f1(ev + ${s + SVC}));\n`;
}
for (let d = 0; d < DRV; d++) app += `    bus_write(${100 + d}, drv${d}_f0(ev + ${d}));\n`;
app += `}\n\nvoid init_all(void) {\n    g_state = 0;\n    g_counter = 0;\n`;
app += `    cfg_set_mode(1);\n    cfg_bump_level();\n    cfg_enable(0);\n    cfg_enable(2);\n`;
app += `    g_cfg.errors = 0;   /* write field: errors */\n`;
for (let h = 0; h < HAL; h++) app += `    bus_write(${200 + h}, hal${h}_f0(${h}));\n`;
for (let i = 0; i < K; i++) app += `    bus_write(${220 + i}, app_f${i}(${i}));\n`;
app += `}\n`;
w(path.join(SRC, 'app.c'), app);

w(path.join(SRC, 'main.c'), `#include "app.h"

int main(void) {
    init_all();
    for (int i = 0; i < 100; i++) {
        dispatch(i);
    }
    return g_state + g_reads + g_writes + state_health();
}
`);

// ---- Edge-case fixtures: header-defined inline, isolated, duplicate name -----
w(path.join(INC, 'edge.h'), `#ifndef EDGE_H
#define EDGE_H
#include "util.h"
#include "bus.h"

/* Defined ONLY in this header (static inline): the definition lives in the .h,
   so call hierarchy opened here must stay anchored here (no re-anchor away). */
static inline int edge_inline(int x) {
    return util_mix(x, x) + 1;          /* callee: util_mix */
}

int  edge_orphan(void);                 /* isolated: no callers, no callees */
void edge_use_inline(int x);            /* the caller of edge_inline */

#endif /* EDGE_H */
`);
w(path.join(SRC, 'edge.c'), `#include "edge.h"

/* Isolated: declared in edge.h, defined here, calls nothing, called by nobody. */
int edge_orphan(void) {
    return 7;
}

void edge_use_inline(int x) {
    bus_write(250, edge_inline(x));     /* the only caller of edge_inline */
}
`);

// Two file-local functions with the SAME name in different files (distinct symbols).
for (const tag of ['a', 'b']) {
  const other = tag === 'a' ? 'b' : 'a';
  w(path.join(SRC, `dup_${tag}.c`), `#include "bus.h"

static int dup_local(int x) {           /* same name as the static in dup_${other}.c */
    return bus_read(x & 3);
}

int dup_${tag}_entry(int x) {
    return dup_local(x);                 /* calls THIS file's dup_local */
}
`);
}

// ---- Macro fixture: calls hidden inside function-like macros ----------------
w(path.join(INC, 'mac.h'), `#ifndef MAC_H
#define MAC_H
#include "util.h"
#include "bus.h"

/* Function calls hidden inside function-like macros. */
#define MAC_LOG(v)       util_log((v))
#define MAC_WRITE(r, v)  bus_write((r), (v))

void mac_user(int x);

#endif /* MAC_H */
`);
w(path.join(SRC, 'mac.c'), `#include "mac.h"

void mac_user(int x) {
    MAC_LOG(x);              /* expands to util_log(x) — call via macro */
    MAC_WRITE(9, x + 1);     /* expands to bus_write(9, x + 1) — call via macro */
    int r = bus_read(9);     /* a plain (non-macro) call, for contrast */
    util_log(r);             /* a plain util_log call too */
}
`);

// ---- clangd config: compile_flags.txt (for headers) + compile_commands.json -
w(path.join(ROOT, 'compile_flags.txt'), `-Iinclude\n-std=c11\n-Wall\n`);

// Let the Header Includes scanner resolve <...>/"..." includes under include/.
fs.mkdirSync(path.join(ROOT, '.vscode'), { recursive: true });
w(path.join(ROOT, '.vscode', 'settings.json'), JSON.stringify({ 'cCallHierarchyReferences.includePaths': ['include'] }, null, 2) + '\n');

// Absolute paths (clangd needs them to build its background index for outgoing
// calls). This file is therefore machine-specific and is git-ignored — it is
// regenerated locally by this script; nothing absolute is committed.
const absInc = fwd(INC);
const cc = fs
  .readdirSync(SRC)
  .filter((f) => f.endsWith('.c'))
  .sort()
  .map((f) => ({
    directory: fwd(ROOT),
    file: fwd(path.join(SRC, f)),
    arguments: ['clang', `-I${absInc}`, '-std=c11', '-Wall', '-c', fwd(path.join(SRC, f))],
  }));
w(path.join(ROOT, 'compile_commands.json'), JSON.stringify(cc, null, 2) + '\n');

// ---- summary ---------------------------------------------------------------
const funcs = HAL * K + DRV * K + SVC * K + K /*app*/ + 2 /*bus*/ + 2 /*util*/ + 10 /*state*/ + 2 /*dispatch/init*/ + 1;
console.log(`Generated example-large: ${funcs} functions, ${cc.length} translation units.`);
console.log(`Header layers: app -> svc -> drv -> hal -> bus/util -> common (6 levels).`);
console.log(`Hubs bus_write/bus_read/util_log: ~${HAL * K + DRV * K + SVC * K + K} callers each.`);
console.log(`dispatch(): ~${SVC * 2 + DRV + 1} callees. No standard-library includes.`);
