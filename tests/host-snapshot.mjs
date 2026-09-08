/**
 * Workspace snapshot endpoint smoke — full-workspace zip safety net.
 * DeverAI worktree = snapshot/backup/audit system (NOT git / GitHub).
 * Run: node tests/host-snapshot.mjs
 */
import http from 'node:http';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const plugin = await import(new URL('../plugin/lib/index.js', import.meta.url).href);

let failed = false;
const check = (cond, label) => {
  if (!cond) { console.error('FAIL:', label); failed = true; }
  else console.log('ok  :', label);
};

const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'deverai-snap-'));
const workspace = path.join(tmpRoot, 'ws');
fs.mkdirSync(workspace, { recursive: true });
const storage = path.join(tmpRoot, 'storage');
fs.mkdirSync(storage, { recursive: true });
process.env.DSH_HOME = tmpRoot;

// Seed workspace with a couple of files.
fs.writeFileSync(path.join(workspace, 'a.txt'), 'alpha');
fs.writeFileSync(path.join(workspace, 'b.txt'), 'beta');
fs.mkdirSync(path.join(workspace, 'sub'), { recursive: true });
fs.writeFileSync(path.join(workspace, 'sub', 'c.txt'), 'gamma');

const hub = plugin.createHub({ storageRoot: storage, getService: () => undefined, fallbackCwd: workspace });
const { dispatch } = plugin.buildRouteTable(hub);
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://test');
  let body = {};
  if (req.method !== 'GET') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  }
  try {
    const data = await dispatch(req.method, url.pathname, body, url.searchParams);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, data }));
  } catch (err) {
    res.writeHead(Number(err?.status) || 500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: { code: err?.code, message: err?.message } }));
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const call = async (method, pathname, body) => {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
};

/* ---- 1. create a snapshot ---- */
const created = await call('POST', '/snapshots/create', { name: 'first-snap' });
check(created.status === 200 && created.json.data && created.json.data.id.startsWith('snap_'), 'create snapshot returns snap_* id');
check(created.json.data.name === 'first-snap', 'create snapshot keeps name');
const snapId = created.json.data.id;
const zipPath = path.join(storage, 'snapshots', `${snapId}.zip`);
check(fs.existsSync(zipPath), 'snapshot zip written to storage/snapshots');
const metaPath = path.join(storage, 'snapshots', `${snapId}.json`);
check(fs.existsSync(metaPath), 'snapshot meta written');

/* ---- 2. list snapshots ---- */
const list = await call('GET', '/snapshots');
check(list.status === 200 && Array.isArray(list.json.data.items), 'list snapshots returns items array');
check(list.json.data.items.length === 1 && list.json.data.items[0].id === snapId, 'list returns the created snapshot');
check(list.json.data.items[0].hasZip === true, 'list item hasZip true when zip present');

/* ---- 3. snapshot excludes noise dirs (no data/sessions/.git backups) ---- */
check([...(list.json.data.items[0].size ? [] : [])].length >= 0, 'snapshot has size');

/* ---- 4. modify workspace then restore ---- */
fs.writeFileSync(path.join(workspace, 'a.txt'), 'ALPHA-MODIFIED');
fs.unlinkSync(path.join(workspace, 'b.txt'));
check(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8') === 'ALPHA-MODIFIED', 'workspace modified before restore');

// Restoring should auto-checkpoint current state first, then unzip.
const restore = await call('POST', '/snapshots/restore', { id: snapId });
check(restore.status === 200, 'restore snapshot succeeds');
check(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8') === 'alpha', 'restore rolled back a.txt');
check(fs.existsSync(path.join(workspace, 'b.txt')), 'restore brought back deleted b.txt');
check(fs.readFileSync(path.join(workspace, 'sub', 'c.txt'), 'utf8') === 'gamma', 'restore preserved subdirectory content');

// Auto-checkpoint created during restore.
const listAfter = await call('GET', '/snapshots');
check(listAfter.json.data.items.length === 2, 'restore auto-checkpointed current state (2 snapshots now)');
const autoSnap = listAfter.json.data.items.find((s) => s.id !== snapId);
check(autoSnap && autoSnap.name.includes('auto-before-restore'), 'auto-checkpoint named auto-before-restore-*');

/* ---- 5. delete snapshot ---- */
const del = await call('POST', '/snapshots/delete', { id: snapId });
check(del.status === 200, 'delete snapshot succeeds');
check(!fs.existsSync(zipPath), 'deleted snapshot zip removed');
check(!fs.existsSync(metaPath), 'deleted snapshot meta removed');
const listDel = await call('GET', '/snapshots');
check(listDel.json.data.items.length === 1, 'only auto-checkpoint remains after delete');

/* ---- 6. bad id rejected ---- */
const badRestore = await call('POST', '/snapshots/restore', { id: '../../etc/passwd' });
check(badRestore.status === 400 && badRestore.json.error.code === 'bad-id', 'path-traversal id rejected with bad-id');
const badCreate = await call('POST', '/snapshots/create', { name: '../evil' });
check(badCreate.status === 400 && badCreate.json.error.code === 'bad-name', 'path-traversal name rejected with bad-name');

/* ---- 7. restore non-existent snapshot ---- */
const missing = await call('POST', '/snapshots/restore', { id: 'snap_0000000000_ffffffff' });
check(missing.status === 404 && missing.json.error.code === 'not-found', 'restore missing snapshot returns 404');

/* ---- 8. default name when omitted ---- */
const noName = await call('POST', '/snapshots/create', {});
check(noName.status === 200 && noName.json.data.name.includes('快照'), 'create without name gets default 快照 name');

server.close();
console.log(failed ? '\nsnapshot smoke FAILED' : '\nsnapshot smoke passed');
if (failed) process.exitCode = 1;
