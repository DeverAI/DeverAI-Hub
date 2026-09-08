/**
 * Adversarial smoke test for the @deverai/hub host half — clumsy-user edition.
 * Drives buildRouteTable through node:http exactly like the real webServer.
 *
 * Run: node tests/host-smoke-adv.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const plugin = await import(new URL('../plugin/lib/index.js', import.meta.url).href);

let failed = false;
const check = (cond, label) => {
  if (!cond) { console.error('FAIL:', label); failed = true; }
  else console.log('ok  :', label);
};

const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'deverai-hub-adv-'));
const workspace = path.join(tmpRoot, 'ws');
const storage = path.join(tmpRoot, 'storage');
await fsp.mkdir(workspace, { recursive: true });
await fsp.mkdir(storage, { recursive: true });

process.env.DSH_HOME = tmpRoot;
const hub = plugin.createHub({ storageRoot: storage, getService: () => undefined, fallbackCwd: workspace });
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

/* ---------- traversal & injection shapes ---------- */
{
  // URLSearchParams already decodes %2e%2e%2f into ../ — resolver must still refuse.
  const r1 = await call('GET', '/fs/read?path=' + encodeURIComponent('../outside.txt'));
  check(r1.status === 403, 'encoded ../ rejected');
  const r2 = await call('GET', '/fs/list?path=' + encodeURIComponent('..%2F..'));
  check(r2.status === 403 || r2.status === 404, 'double-encoded traversal never escapes (got ' + r2.status + ')');
}
{
  const r = await call('GET', `/fs/read?path=${encodeURIComponent('sub\\..\\..\\..\\Windows\\win.ini')}`);
  check(r.status === 403 || r.status === 404, 'backslash traversal never escapes (got ' + r.status + ')');
}
{
  const r = await call('POST', '/fs/write', { path: 'C:\\Windows\\Temp\\evil.txt', content: 'x' });
  check(r.status === 403, 'absolute path outside workspace rejected');
}
{
  const r = await call('GET', '/fs/list?path=/etc');
  check(r.status === 403, 'absolute posix-style path rejected');
}
{
  // null byte and control chars
  const r = await call('GET', '/fs/read?path=' + encodeURIComponent('seed.txt\u0000.exe'));
  check(r.status >= 400 && r.status < 500, 'null-byte path rejected gracefully (' + r.status + ')');
}

/* ---------- windows reserved names & odd names ---------- */
{
  const r = await call('POST', '/fs/write', { path: 'CON', content: 'x' });
  check(r.status !== 500, 'reserved device name does not crash (status ' + r.status + ')');
}
{
  const r = await call('POST', '/fs/write', { path: '中文 目录/文件 A.txt', content: 'ok' });
  check(r.status === 200, 'unicode + spaces path works');
  const back = await call('GET', '/fs/read?path=' + encodeURIComponent('中文 目录/文件 A.txt'));
  check(back.json.ok && back.json.data.content === 'ok', 'unicode content round-trips');
}

/* ---------- depth & size ---------- */
{
  const r = await call('POST', '/fs/mkdir', { path: 'a/b/c/d/e/f' });
  check(r.status === 200 && fs.existsSync(path.join(workspace, 'a/b/c/d/e/f')), 'six-level nested mkdir works');
}
{
  const big = 'x'.repeat(3 * 1024 * 1024);
  const w = await call('POST', '/fs/write', { path: 'big.bin', content: big });
  check(w.status === 200 && w.json.data.bytes === big.length, '3MB write accepted');
  const rd = await call('GET', '/fs/read?maxBytes=65536&path=big.bin');
  check(rd.json.data.truncated === true && rd.json.data.content.length <= 70000, 'read truncates with flag');
}
{
  // checkpoint accumulation: three overwrites -> at least two checkpoints of demo lifecycle
  for (let i = 0; i < 3; i++) await call('POST', '/fs/write', { path: 'big.bin', content: 'v' + i });
  const cps = await call('GET', '/checkpoints?limit=100');
  check(cps.json.data.items.length >= 3, 'repeated overwrites accumulate checkpoints');
}

/* ---------- restore edge cases ---------- */
{
  const bad = await call('POST', '/checkpoints/restore', { id: '../../etc' });
  check(bad.status === 400, 'malformed checkpoint id rejected 400');
  const missing = await call('POST', '/checkpoints/restore', { id: '999999999999-deadbeef' });
  check(missing.status >= 400 && missing.status < 500, 'missing checkpoint id rejected cleanly');
}

/* ---------- terminal variants ---------- */
{
  const s1 = await call('GET', '/term/state');
  check(s1.json.ok && Array.isArray(s1.json.data.running) && s1.json.data.running.length === 0, 'term/state starts empty');
  const st = await call('POST', '/term/stop', { id: 'nonexistent' });
  check(st.json.ok && st.json.data.stopped === false, 'stop unknown id answers stopped:false (no crash)');
}
{
  const t = await call('POST', '/term/run', {});
  check(t.status === 400, 'empty command rejected 400');
}
{
  const d1 = await call('GET', '/danger/check?cmd=' + encodeURIComponent('Remove-Item -Force -Recurse C:\\x'));
  const d2 = await call('GET', '/danger/check?cmd=' + encodeURIComponent('Remove-Item -Recurse -Force C:\\x'));
  const d3 = await call('GET', '/danger/check?cmd=' + encodeURIComponent('rd /s /q folder'));
  const d4 = await call('GET', '/danger/check?cmd=' + encodeURIComponent('DEL /F /S /Q file.txt'));
  const d5 = await call('GET', '/danger/check?cmd=' + encodeURIComponent('shutdown /r /t 0'));
  const benign1 = await call('GET', '/danger/check?cmd=' + encodeURIComponent('taskkill /pid 123'));
  const benign2 = await call('GET', '/danger/check?cmd=' + encodeURIComponent('git push --force-with-lease origin main'));
  const benign3 = await call('GET', '/danger/check?cmd=' + encodeURIComponent('npm run format -- --write'));
  check(d1.json.data.dangerous && d2.json.data.dangerous, 'Remove-Item flags order-insensitive');
  check(d3.json.data.dangerous && d4.json.data.dangerous, 'rd/del switch orders caught');
  check(d5.json.data.dangerous, 'shutdown flagged');
  check(!benign1.json.data.dangerous, 'taskkill without /f not flagged');
  check(!benign2.json.data.dangerous, '--force-with-lease not flagged');
  check(!benign3.json.data.dangerous, 'format subcommand not flagged');
}
{
  // danger gate disabled entirely -> even rm -rf runs without confirm
  await call('POST', '/config', { terminal: { dangerConfirm: false } });
  const t = await call('POST', '/term/run', { cmd: 'echo gate-off-check', timeoutMs: 15000 });
  check(t.json.ok && String(t.json.data.stdout).includes('gate-off-check'), 'dangerConfirm=false lets commands through (documented behavior)');
  await call('POST', '/config', { terminal: { dangerConfirm: true } });
  const blocked = await call('POST', '/term/run', { cmd: 'echo still-blocked & rd /s q', timeoutMs: 15000 });
  check(blocked.status === 403, 'gate restored after config flip');
}

/* ---------- config merge semantics ---------- */
{
  const before = (await call('GET', '/info')).json.data.config;
  await call('POST', '/config', { terminal: { timeoutMs: 42000 } });
  const after = (await call('GET', '/info')).json.data.config;
  check(after.terminal.timeoutMs === 42000, 'partial terminal patch applies');
  check(after.files.allowWrite === true && after.files.allowDelete === false, 'unrelated sections preserved');
  check(before.terminal.shell === after.terminal.shell, 'shell untouched by sibling patch');
  const junk = await call('POST', '/config', { nonsenseTopLevel: 123, files: null });
  check(junk.status === 200, 'junk keys tolerated without crash');
}

/* ---------- list/read type mismatches ---------- */
{
  await call('POST', '/fs/write', { path: 'plain.txt', content: 'hi' });
  const l = await call('GET', '/fs/list?path=plain.txt');
  const r = await call('GET', '/fs/read?path=a');
  check(l.status === 400, 'list on a file rejected 400');
  check(r.status === 400, 'read on a directory rejected 400');
}

/* ---------- protected at depth ---------- */
{
  await call('POST', '/fs/mkdir', { path: 'deep/deeper' });
  const w = await call('POST', '/fs/write', { path: 'deep/deeper/api.txt', content: 'secret' });
  const w2 = await call('POST', '/fs/write', { path: 'deep/node_modules/pkg/index.js', content: 'x' });
  check(w.status === 403 && w2.status === 403, 'DENY_ALL/DENY_WRITE_DIRS enforced at any depth');
}

server.close();
console.log(failed ? '\nadversarial FAILED' : '\nadversarial passed');
if (failed) process.exitCode = 1;
