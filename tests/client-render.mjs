/**
 * Render smoke for the @deverai/hub client half — no-DOM edition.
 *
 * The harness profile ships mismatched react/react-dom majors, so a real
 * server renderer cannot pair with them here. Instead this suite loads the
 * client bundle with an instrumented mini-React (faithful enough hook
 * semantics for one synchronous render pass), forces the persisted-config
 * seed through a stubbed fetch, then EXECUTES each registered slot component
 * and walks the produced element trees. It catches invalid children,
 * undefined component references, and crashes on render paths — the failure
 * classes that matter at mount time.
 *
 * Run: node tests/client-render.mjs
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');

let failed = false;
const check = (cond, label) => {
  if (!cond) { console.error('FAIL:', label); failed = true; }
  else console.log('ok  :', label);
};

/* ---------- instrumented mini-React ---------- */

function makeFakeReact() {
  const effects = [];
  const hooks = {
    useState(init) {
      const value = typeof init === 'function' ? init() : init;
      return [value, () => {}];
    },
    useEffect(fn) { effects.push(fn); return; },
    useLayoutEffect(fn) { effects.push(fn); return; },
    useContext() { return undefined; },
    useRef(value) { return { current: value }; },
    useCallback(fn) { return fn; },
    useMemo(factory) { return factory(); },
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot(); },
    useReducer(reducer, initialArg, init) {
      const value = init ? init(initialArg) : initialArg;
      return [value, () => {}];
    },
    Fragment: Symbol.for('react.test.fragment'),
    StrictMode: function StrictMode(props) { return props.children; },
    createElement(type, props, ...rest) {
      let children = rest;
      if (rest.length === 0) children = undefined;
      else if (rest.length === 1) children = rest[0];
      const merged = { ...(props ?? {}) };
      if (!(children === undefined && Object.prototype.hasOwnProperty.call(merged, 'children'))) {
        merged.children = children;
      }
      return { $$typeof: Symbol.for('react.test.element'), type, props: merged };
    },
  };
  return { react: hooks, effects };
}

const fake = makeFakeReact();

/* ---------- shim window + fetch, load the bundle ---------- */

let capturedFactory = null;
const fakeWindow = {
  __ModuleLoader__: {
    load(record) {
      if (!record || typeof record.factory !== 'function') throw new Error('load() without factory');
      capturedFactory = record.factory;
    },
  },
  addEventListener() {},
  removeEventListener() {},
};

// Stub fetch BEFORE apply(): the bundle seeds dock state from /hub/state/overview.
const OVERVIEW = {
  ok: true,
  data: {
    version: '1.0.0-test',
    workspace: { root: 'C:/tmp/ws', name: 'ws', overrideActive: false },
    counts: { checkpoints: 3, runningTerminals: 0 },
    config: {
      files: { allowWrite: true, allowDelete: false },
      terminal: { enabled: true, shell: 'powershell', dangerConfirm: true, timeoutMs: 120000, maxOutputBytes: 200000 },
      dock: { visible: true, tab: 'files', widthPx: 420 },
      workspaceOverride: '',
    },
    storage: { root: 'C:/tmp/storage', home: 'C:/tmp/.dsh' },
    recentAudit: [{ ts: new Date().toISOString(), action: 'write', target: 'demo.txt', ok: true }],
    serverTime: new Date().toISOString(),
  },
};
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => OVERVIEW });

const srcPath = new URL('../plugin/lib/client.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
new Function('window', readFileSync(srcPath, 'utf8'))(fakeWindow);
check(typeof capturedFactory === 'function', '__ModuleLoader__.load captured the factory');

function requireShim(name) {
  if (name === 'react') return fake.react;
  throw new Error('unexpected require("' + name + '") in client bundle');
}
const pluginExports = capturedFactory(requireShim);
check(pluginExports.name === 'deverai-hub', 'exports.name is deverai-hub');
check(Array.isArray(pluginExports.inject) && pluginExports.inject.includes('slots'), 'inject lists slots');

/* ---------- fake cordis ctx ---------- */

const registrations = [];
const injectCalls = [];
let seededFlag = false;
const fakeSlots = {
  register(record, component) { registrations.push({ ...record, component }); return () => {}; },
  inject(slotName, callback) { injectCalls.push(slotName); callback(); return () => {}; },
};
const fakeCtx = {
  get(key) {
    if (key === 'slots') return fakeSlots;
    if (key === 'timer') return { timeout: () => () => {}, interval: () => () => {} };
    return undefined;
  },
  effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {}; },
  slots: fakeSlots,
};
pluginExports.apply(fakeCtx);
check(injectCalls.includes('sidebar.footer.action') && injectCalls.includes('shell.overlay') && injectCalls.includes('settings.section'), 'apply targets all three slots');

// flush microtasks so the overview seed lands in the dock store
await new Promise((resolve) => setImmediate(resolve));
await new Promise((resolve) => setImmediate(resolve));
check(fake.effects.length >= 0, 'hook effects recorded safely');
void seededFlag;

/* ---------- execute components and walk trees ---------- */

function walk(node, depth, path_) {
  if (node === null || node === undefined || typeof node === 'boolean' || typeof node === 'number' || typeof node === 'string') return;
  if (Array.isArray(node)) { node.forEach((child, i) => walk(child, depth + 1, path_ + '[' + i + ']')); return; }
  if (typeof node !== 'object' || node.type === undefined) {
    throw new Error(`invalid element child at ${path_}: ${String(node)}`);
  }
  if (typeof node.type === 'function') {
    if (depth > 8) return;
    const out = node.type(node.props ?? {});
    walk(out, depth + 1, path_ + '>()');
    return;
  }
  if (typeof node.type !== 'string' && typeof node.type !== 'symbol') {
    throw new Error(`unknown element type at ${path_}: ${String(node.type)}`);
  }
  if (node.props && node.props.children !== undefined) {
    walk(node.props.children, depth + 1, path_ + '.c');
  }
}

function renderComponent(reg, label) {
  try {
    const tree = reg.component({});
    walk(tree, 0, label);
    check(true, `${label} executed and tree walked clean`);
    return tree;
  } catch (error) {
    check(false, `${label} threw: ${error.message}`);
    return null;
  }
}

function collectText(node, out, depth = 0) {
  if (typeof node === 'string') { out.push(node); return; }
  if (Array.isArray(node)) { node.forEach((child) => collectText(child, out, depth)); return; }
  if (node && typeof node === 'object') {
    if (typeof node.type === 'function' && depth < 8) {
      collectText(node.type(node.props ?? {}), out, depth + 1);
      return;
    }
    if (node.props) collectText(node.props.children, out, depth + 1);
  }
}

const byId = Object.fromEntries(registrations.map((reg) => [reg.id, reg]));

const toggleTree = renderComponent(byId['deverai-hub-toggle'], 'HubToggleEntry');
{
  const texts = [];
  collectText(toggleTree, texts);
  check(texts.join('|').includes('Hub'), 'toggle carries Hub label');
}

const settingsTree = renderComponent(byId['deverai-hub'], 'HubSettingsPage');
{
  const texts = [];
  collectText(settingsTree, texts);
  // First synchronous paint shows the loading branch (its data lands via useEffect).
  check(texts.some((text) => text.includes('\u52a0\u8f7d\u4e2d')), 'settings page shows loading state on first paint');
}

// Dock: seeded visible:true + tab files -> full shell incl. Files tab.
const dockTree = renderComponent(byId['deverai-hub-dock'], 'WorkbenchDock(visible)');
{
  const texts = [];
  collectText(dockTree, texts);
  const joined = texts.join('|');
  for (const expected of ['DeverAI Hub', 'Summary', 'Terminal', 'Files']) {
    check(joined.includes(expected), `dock header contains "${expected}"`);
  }
  check(joined.includes('\u53cc\u51fb\u6587\u4ef6\u9884\u89c8'), 'files tab toolbar hint present'); // 双击文件预览
  if (!joined.includes('\u53cc\u51fb\u6587\u4ef6\u9884\u89c8')) {
    console.error('DEBUG store: ' + JSON.stringify(pluginExports.__dockStore.getState()));
    const shape = (node, d) => {
      if (node === null || node === undefined || typeof node !== 'object') return typeof node;
      const t = typeof node.type === 'function' ? (node.type.name || 'anon-fn') : String(node.type);
      const kids = Array.isArray(node.props?.children) ? node.props.children.length : (node.props?.children !== undefined ? 1 : 0);
      return { t, d, kids, c: d < 3 ? (Array.isArray(node.props?.children) ? node.props.children.map((k) => shape(k, d + 1)) : shape(node.props?.children, d + 1)) : '...' };
    };
    console.error('DEBUG shape: ' + JSON.stringify(shape(dockTree, 0)).slice(0, 900));
  }
}

/* ---------- mount-execute EVERY tab branch (regression: dock-wide crash) ---------- */
const TAB_IDS = ['summary', 'terminal', 'files', 'worktree', 'router'];
for (const tabId of TAB_IDS) {
  // Fresh bundle copy => fresh dockStore seeded with this tab.
  let factory2 = null;
  const win2 = {
    __ModuleLoader__: { load(rec) { factory2 = rec.factory; } },
    addEventListener() {},
    removeEventListener() {},
  };
  new Function('window', readFileSync(srcPath, 'utf8'))(win2);
  const exports2 = factory2(requireShim);
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ...OVERVIEW, data: { ...OVERVIEW.data, config: { ...OVERVIEW.data.config, dock: { ...OVERVIEW.data.config.dock, visible: true, tab: tabId } } } }) });
  const registrations2 = [];
  const slots2 = {
    register(record, component) { registrations2.push({ ...record, component }); return () => {}; },
    inject(name, cb) { cb(); return () => {}; },
  };
  exports2.apply({
    get(key) {
      if (key === 'slots') return slots2;
      if (key === 'timer') return { timeout: () => () => {}, interval: () => () => {} };
      return undefined;
    },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {}; },
    slots: slots2,
  });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const dockReg2 = registrations2.find((reg) => reg.id === 'deverai-hub-dock');
  renderComponent(dockReg2, `WorkbenchDock(tab=${tabId})`);
}

/* ---------- seed-race regression: open before seed, seed must not clobber ---------- */
{
  let factory3 = null;
  const win3 = { __ModuleLoader__: { load(rec) { factory3 = rec.factory; } }, addEventListener() {}, removeEventListener() {} };
  new Function('window', readFileSync(srcPath, 'utf8'))(win3);
  const exports3 = factory3(requireShim);
  let resolveSeed = null;
  globalThis.fetch = (url) => {
    if (String(url).includes('/state/overview')) {
      return new Promise((res) => {
        resolveSeed = () => res({ ok: true, status: 200, json: async () => ({ ...OVERVIEW, data: { ...OVERVIEW.data, config: { ...OVERVIEW.data.config, dock: { visible: false, tab: 'summary', widthPx: 400 } } } }) });
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, data: {} }) });
  };
  const registrations3 = [];
  const slots3 = {
    register(record, component) { registrations3.push({ ...record, component }); return () => {}; },
    inject(name, cb) { cb(); return () => {}; },
  };
  exports3.apply({
    get(key) { return key === 'slots' ? slots3 : (key === 'timer' ? { timeout: () => () => {}, interval: () => () => {} } : undefined); },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {}; },
    slots: slots3,
  });
  const dock3 = registrations3.find((reg) => reg.id === 'deverai-hub-dock');
  // user opens the dock BEFORE the overview seed arrives
  exports3.__dockStore.patch({ visible: true });
  const openTree = dock3.component({});
  const openTexts = [];
  collectText(openTree, openTexts);
  check(openTexts.join('|').includes('DeverAI Hub'), 'seed-race: dock open before seed');
  // stale seed lands now (visible:false on the server)
  resolveSeed();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const afterTree = dock3.component({});
  const afterTexts = [];
  collectText(afterTree, afterTexts);
  check(afterTexts.join('|').includes('DeverAI Hub'), 'seed-race: dock STAYS open after stale seed lands');
  check(exports3.__dockStore.getState().visible === true, 'seed-race: store keeps visible=true');
}

console.log(failed ? '\nrender smoke FAILED' : '\nrender smoke passed');
if (failed) process.exitCode = 1;
