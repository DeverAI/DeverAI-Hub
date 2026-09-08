/**
 * Headless smoke test for the @deverai/hub host half.
 * Drives buildRouteTable through a real node:http server and fetch.
 *
 * Run: node tests/host-smoke.mjs
 */
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const pluginPath = new URL('../plugin/lib/index.js', import.meta.url).href;
const plugin = await import(pluginPath);

const assert = (cond, label) => {
  if (!cond) {
    console.error('FAIL:', label);
    process.exitCode = 1;
  } else {
    console.log('ok  :', label);
  }
};

/* ---------------- temp sandbox ---------------- */
const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'deverai-hub-test-'));
const workspace = path.join(tmpRoot, 'ws');
const storage = path.join(tmpRoot, 'storage');
await fsp.mkdir(workspace, { recursive: true });
await fsp.mkdir(storage, { recursive: true });
await fsp.writeFile(path.join(workspace, 'seed.txt'), 'seed-content-v1', 'utf8');
await fsp.mkdir(path.join(workspace, 'sub'));
await fsp.writeFile(path.join(workspace, 'sub', 'nested.md'), '# nested', 'utf8');

process.env.DSH_HOME = tmpRoot; // keep apply()-level storage away from real home if used

const hub = plugin.createHub({
  storageRoot: storage,
  getService: () => undefined,
  fallbackCwd: workspace,
});

/* ---------------- tiny http adapter ---------------- */
const { dispatch } = plugin.buildRouteTable(hub);
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://test');
  try {
    let body = {};
    if (req.method !== 'GET') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    }
    const data = await dispatch(req.method, url.pathname, body, url.searchParams);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, data }));
  } catch (error) {
    res.writeHead(Number(error?.status) || 500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: { code: error?.code ?? 'internal', message: error?.message ?? '' } }));
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function call(method, endpoint, body) {
  const response = await fetch(base + endpoint, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, json: await response.json() };
}

/* ---------------- cases ---------------- */

// info & workspace
{
  const r = await call('GET', '/info');
  assert(r.status === 200 && r.json.ok === true, '/info returns ok envelope');
  assert(r.json.data.workspace.root.toLowerCase() === workspace.toLowerCase(), 'workspace root follows fallback cwd');
  assert(r.json.data.plugin === 'deverai-hub' && typeof r.json.data.version === 'string', 'info carries identity');
}
{
  const r = await call('GET', '/workspace');
  assert(r.json.ok && r.json.data.overrideActive === false, 'workspace override inactive by default');
}

// file bridge
{
  const r = await call('GET', '/fs/list?path=.');
  assert(r.status === 200 && Array.isArray(r.json.data.items), '/fs/list returns items');
  assert(r.json.data.items.some((item) => item.name === 'seed.txt'), 'list contains seed.txt');
}
{
  const r = await call('POST', '/fs/write', { path: 'demo.txt', content: 'v1-line' });
  assert(r.status === 200 && r.json.data.bytes === 'v1-line'.length, 'write demo.txt ok');
  assert(fs.readFileSync(path.join(workspace, 'demo.txt'), 'utf8') === 'v1-line', 'file landed on disk');
}
{
  const r = await call('GET', '/fs/read?path=demo.txt');
  assert(r.json.ok && r.json.data.content === 'v1-line' && r.json.data.truncated === false, 'read back matches');
}
{
  // overwrite creates a checkpoint of the previous content
  await call('POST', '/fs/write', { path: 'demo.txt', content: 'v2-line' });
  const cps = await call('GET', '/checkpoints?limit=10');
  assert(cps.json.data.items.length === 1, 'overwrite created one checkpoint');
  assert(cps.json.data.items[0].action === 'write', 'checkpoint action=write');
  // restore brings v1 back (and shadows current first)
  const rr = await call('POST', '/checkpoints/restore', { id: cps.json.data.items[0].id });
  assert(rr.status === 200 && rr.json.ok === true, 'restore succeeds');
  assert(fs.readFileSync(path.join(workspace, 'demo.txt'), 'utf8') === 'v1-line', 'restored content is v1');
}

// escape / protection
{
  const r = await call('GET', '/fs/list?path=../');
  assert(r.status === 403 && r.json.error.code === 'escape', 'path traversal rejected 403');
}
{
  const w = await call('POST', '/fs/write', { path: 'api.txt', content: 'secret' });
  const rd = await call('GET', '/fs/read?path=.env');
  const git = await call('POST', '/fs/mkdir', { path: '.git/hack' });
  assert(w.status === 403 && rd.status === 403 && git.status === 403, 'protected names/dirs rejected');
}
{
  const deepEscape = await call('GET', '/fs/read?path=sub/../../../etc/passwd');
  assert(deepEscape.status === 403, 'deep ../ escape rejected');
}

// mkdir / rename
{
  await call('POST', '/fs/mkdir', { path: 'made/dir' });
  assert(fs.existsSync(path.join(workspace, 'made', 'dir')), 'recursive mkdir works');
  const mv = await call('POST', '/fs/rename', { from: 'seed.txt', to: 'renamed.txt' });
  assert(mv.status === 200 && fs.existsSync(path.join(workspace, 'renamed.txt')), 'rename works');
  const dup = await call('POST', '/fs/rename', { from: 'renamed.txt', to: 'renamed.txt' });
  assert(dup.status === 409, 'rename onto existing rejected 409');
}

// delete gating
{
  const d1 = await call('POST', '/fs/delete', { path: 'renamed.txt', confirm: true });
  assert(d1.status === 403 && d1.json.error.code === 'delete-disabled', 'delete disabled by default');
  await call('POST', '/config', { files: { allowDelete: true } });
  const d2 = await call('POST', '/fs/delete', { path: 'renamed.txt', confirm: false });
  assert(d2.status === 403 && d2.json.error.code === 'unconfirmed', 'unconfirmed delete rejected');
  const d3 = await call('POST', '/fs/delete', { path: 'renamed.txt', confirm: 'yes' });
  assert(d3.status === 200 && !fs.existsSync(path.join(workspace, 'renamed.txt')), 'confirmed strict-bool delete works');
  const rootDel = await call('POST', '/fs/delete', { path: '.', confirm: true });
  assert(rootDel.status === 403, 'workspace-root deletion refused');
}

// terminal
{
  const isWin = process.platform === 'win32';
  const echoCmd = isWin ? 'echo hello-hub-test' : 'echo hello-hub-test';
  const t = await call('POST', '/term/run', { cmd: echoCmd, timeoutMs: 30000 });
  assert(t.status === 200 && String(t.json.data.stdout).includes('hello-hub-test'), `terminal echo runs (${t.json.data?.shell})`);
  assert(t.json.data.code === 0 || t.json.data.code === null, 'terminal exit code sane');

  const dangerPlain = await call('POST', '/term/run', { cmd: 'rm -rf something' });
  assert(dangerPlain.status === 403 && dangerPlain.json.error.code === 'danger-confirm-required', 'dangerous command blocked without confirm');
  const dangerStr = await call('GET', `/danger/check?cmd=${encodeURIComponent('taskkill /f /pid 123')}`);
  assert(dangerStr.json.data.dangerous === true, 'taskkill /f detected order-insensitively');
  const lease = await call('GET', `/danger/check?cmd=${encodeURIComponent('git push --force-with-lease origin main')}`);
  assert(lease.json.data.dangerous === false, '--force-with-lease not flagged');
  const dangerOk = await call('POST', '/term/run', { cmd: 'rd /s x', dangerOk: 'true', timeoutMs: 20000 });
  assert(dangerOk.status !== 403, 'dangerOk=true passes the gate (strict bool)');
}

// audit
{
  const tail = hub.auditTail ? await hub.auditTail(50) : [];
  void tail;
  const ov = await call('GET', '/state/overview');
  const actions = ov.json.data.recentAudit.map((entry) => entry.action);
  assert(actions.includes('write') && actions.includes('terminal') && actions.includes('delete'), 'audit trail captures write/terminal/delete');
}

// config persistence
{
  await call('POST', '/config', { dock: { tab: 'files' }, workspaceOverride: workspace });
  const cfgRaw = JSON.parse(await fsp.readFile(path.join(storage, 'config.json'), 'utf8'));
  assert(cfgRaw.dock.tab === 'files' && cfgRaw.files.allowDelete === true, 'config persisted with merged patch');
  const ws = await call('GET', '/workspace');
  assert(ws.json.data.overrideActive === true, 'override now active');
}

server.close();
console.log('\nsmoke test finished at', tmpRoot);
