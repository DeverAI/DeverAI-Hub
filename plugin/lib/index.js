/**
 * @deverai/hub — host half.
 *
 * DeverAI Hub workbench bridge for DeepSeek Harness. Registers an HTTP route
 * prefix `/hub` on the harness webServer and serves JSON endpoints for the
 * client dock: workspace file bridge, terminal execution, checkpoints, audit
 * log, and state overview. Pure workbench: no chat, no LLM channel — the AI
 * capability is the harness session itself.
 *
 * Storage lives under `$DSH_HOME/storages/deverai-hub/`. Every mutating action
 * is audited before it returns; every overwrite/delete checkpoints the target
 * first. Paths are resolved and confined inside the effective workspace root.
 */

import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// Zod is needed for DSH settings service registration. It is NOT a dependency
// of this package (the plugin must stay self-contained). We attempt to resolve
// it from the host environment at runtime; if unavailable, settings integration
// is skipped and the hub falls back to its own config.json.
let zod = null;
try {
  const mod = await import('zod');
  zod = mod?.z || mod?.default?.z || null;
} catch {
  // Try DSH's bundled zod as a last resort (dynamic import, never throws).
  try {
    const dsPath = path.join(os.homedir(), 'AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/zod/index.js');
    const mod = await import(dsPath);
    zod = mod?.z || mod?.default?.z || null;
  } catch { /* zod unavailable — settings integration disabled */ }
}

export const name = 'deverai-hub';
export const version = '1.0.0';

/** Hard dependency: the HTTP carrier of the web profile.
 *  DSH shared services (fs/shell/settings/llm) are declared so file and command
 *  operations route through DSH's sandbox policy and shared configuration
 *  instead of bypassing them with raw node:fs + child_process. */
export const inject = ['webServer', 'sandboxPolicy', 'fs', 'shell', 'settings', 'llm'];

/* ------------------------------------------------------------------ *
 * Small utilities
 * ------------------------------------------------------------------ */

function httpError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

/** Strict boolean parse (DeverAI danger_ok protocol): only true / "1" / "yes" / "on". */
function strictBool(value) {
  if (value === true) return true;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    return lowered === 'true' || lowered === '1' || lowered === 'yes' || lowered === 'on';
  }
  return false;
}

function nowIso() {
  return new Date().toISOString();
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Atomic JSON write: unique temp name + rename, temp cleanup on failure. */
async function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
    await fsp.rename(tmp, filePath);
  } catch (error) {
    try { await fsp.unlink(tmp); } catch { /* best effort */ }
    throw error;
  }
}

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  /** Absolute path override; empty = follow DSH. */
  workspaceOverride: '',
  files: { allowWrite: true, allowDelete: false },
  terminal: {
    enabled: true,
    shell: 'powershell',
    timeoutMs: 120000,
    maxOutputBytes: 200000,
    dangerConfirm: true,
  },
  dock: { visible: false, tab: 'summary', widthPx: 400 },
});

function mergeConfig(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(patch ?? {})) {
    // undefined AND null both mean "leave this key alone" — a null section must
    // never poison the cache into a shape whose readers crash.
    if (value === undefined || value === null) continue;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = mergeConfig(base[key] && typeof base[key] === 'object' ? base[key] : {}, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Protected names and dangerous commands (DeverAI four-endpoint port)
 * ------------------------------------------------------------------ */

/** File basenames denied at ANY depth for read AND write. */
const DENY_ALL = new Set(['api.txt', '.env', 'config.json', 'err.log']);
/** Directory basenames denied for write/delete at any depth (read allowed). */
const DENY_WRITE_DIRS = new Set(['.git', '.dsh', 'node_modules']);

/**
 * Dangerous command patterns, Windows-focused port of DeverAI's same-source
 * list. Order-insensitive where the original was (rd /s, taskkill /f,
 * Remove-Item flag order). Matched against lowercased, whitespace-collapsed
 * command text via case-insensitive regexes.
 */
const DANGEROUS_PATTERNS = [
  /\brm\s+-[a-z]*f[a-z]*\s+-[a-z]*r/i, /\brm\s+-[a-z]*r[a-z]*\s+-[a-z]*f/i, /\brm\s+-[a-z]*r[a-z]*f/i,
  /\brd\s+\/s/i, /\brmdir\s+\/s/i, /\bdeltree\b/i,
  /\bdel\s+(\/[a-z]\s+)*\/[fsq]/i,
  /\bremove-item\b[^|;&]{0,80}-recurse/i, /\bremove-item\b[^|;&]{0,80}-force/i,
  /\bri\s+[^|;&]{0,80}-recurse/i,
  /\btaskkill\b[^|;&]{0,80}\/f/i,
  /\bkill\s+-9\b/,
  /\bshutdown\b/i, /\brestart-computer\b/i, /\bstop-computer\b/i, /\bwpeutil\b/i,
  /\bdiskpart\b/i, /\bformat\s+[a-z]:/i,
  /\bdd\s+if=/i, /\bmkfs(\.[a-z0-9]+)?\b/i, /\bcipher\s+\/w/i,
  /\breg\s+(add|delete)\b/i, /\bbcdedit\b/i, /\bvssadmin\b/i,
];

function looksDangerous(cmdText) {
  const collapsed = String(cmdText).replace(/\s+/g, ' ').trim();
  return DANGEROUS_PATTERNS.some((re) => re.test(collapsed));
}

/* ------------------------------------------------------------------ *
 * The hub core: config, workspace, file bridge, checkpoints, terminal
 * ------------------------------------------------------------------ */

export function createHub(options) {
  const { storageRoot, fs: fsService, shell: shellService, settings: settingsService, llm: llmService } = options;
  const checkpointsDir = path.join(storageRoot, 'checkpoints');
  const configPath = path.join(storageRoot, 'config.json');
  const auditPath = path.join(storageRoot, 'audit.jsonl');

  // DSH shared-service handles (present when running inside the harness;
  // absent in the standalone smoke test). When present, file and command
  // operations route through DSH's sandbox-aware providers.
  const hasFs = !!fsService;
  const hasShell = !!shellService;
  const hasSettings = !!settingsService;

  /**
   * Filesystem abstraction: routes through DSH's sandbox-aware fs service
   * when available, falls back to raw node:fs for the standalone smoke test.
   * All paths are still run through the hub's own resolveWithin/assertAllowed
   * containment (defense in depth with DSH's sandbox).
   */
  const fsx = {
    stat: async (absPath) => {
      if (hasFs) {
        try {
          const info = await fsService.stat({ path: absPath });
          return {
            isDirectory: () => info?.type === 'dir' || info?.isDirectory === true,
            isFile: () => info?.type === 'file' || info?.isFile === true,
            size: info?.size ?? 0,
            mtimeMs: info?.mtimeMs ?? info?.mtime ?? 0,
          };
        } catch { /* fall through */ }
      }
      return fsp.stat(absPath);
    },
    readText: async (absPath) => {
      if (hasFs) {
        try { return await fsService.readText({ path: absPath }); } catch { /* fall through */ }
      }
      return fsp.readFile(absPath, 'utf8');
    },
    readBytes: async (absPath) => {
      if (hasFs) {
        try { return await fsService.readBytes({ path: absPath }, undefined, 8 * 1024 * 1024); } catch { /* fall through */ }
      }
      return fsp.readFile(absPath);
    },
    writeText: async (absPath, content) => {
      if (hasFs) {
        try { await fsService.writeText({ path: absPath }, content); return; } catch { /* fall through */ }
      }
      await fsp.mkdir(path.dirname(absPath), { recursive: true });
      await fsp.writeFile(absPath, content, 'utf8');
    },
    listDir: async (absPath) => {
      if (hasFs) {
        try {
          const entries = await fsService.listDir({ path: absPath });
          return entries.map((e) => ({
            name: e?.name,
            isDirectory: () => e?.type === 'dir' || e?.isDirectory === true,
            isFile: () => e?.type === 'file' || e?.isFile === true,
            size: e?.size ?? 0,
          }));
        } catch { /* fall through */ }
      }
      return fsp.readdir(absPath, { withFileTypes: true });
    },
    mkdir: async (absPath) => {
      if (hasFs) {
        try { await fsService.writeText({ path: absPath + '/.dsh-hub-mkdir' }, ''); await fsService.readText({ path: absPath + '/.dsh-hub-mkdir' }); return; } catch { /* fall through */ }
      }
      await fsp.mkdir(absPath, { recursive: true });
    },
  };

  /** Synchronously primed config snapshot; the single source of truth. */
  let configCache = (() => {
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return mergeConfig(DEFAULT_CONFIG, raw && typeof raw === 'object' ? raw : {});
    } catch {
      return cloneJson(DEFAULT_CONFIG);
    }
  })();

  function getConfig() {
    return configCache;
  }

  async function updateConfig(patch) {
    const next = mergeConfig(configCache, patch && typeof patch === 'object' ? patch : {});
    next.version = 1;
    await writeJsonAtomic(configPath, next);
    configCache = next;
    return cloneJson(next);
  }

  /* ---------------- workspace resolution ---------------- */

  function dshHome() {
    const env = globalThis.process?.env ?? {};
    return env.DSH_HOME && String(env.DSH_HOME).trim() ? String(env.DSH_HOME).trim() : path.join(os.homedir(), '.dsh');
  }

  function currentWorkspace() {
    const override = String(configCache.workspaceOverride ?? '').trim();
    if (override) return path.resolve(override);
    try {
      const sp = typeof options.getService === 'function' ? options.getService('sandboxPolicy') : undefined;
      const root = sp && typeof sp.workspaceRoot === 'string' ? sp.workspaceRoot : '';
      if (root && root.trim()) return path.resolve(root.trim());
    } catch { /* optional service absent */ }
    if (options.fallbackCwd) return path.resolve(options.fallbackCwd);
    return process.cwd();
  }

  function resolveWithin(root, rel) {
    const cleanRel = String(rel ?? '.').trim() || '.';
    const abs = path.resolve(root, cleanRel);
    const lowAbs = abs.toLowerCase();
    const lowRoot = root.toLowerCase();
    const normRoot = lowRoot.endsWith('\\') || lowRoot.endsWith('/') ? lowRoot : lowRoot + path.sep;
    if (lowAbs !== lowRoot && !lowAbs.startsWith(normRoot)) {
      throw httpError(403, 'escape', '路径越界:目标必须位于工作区内');
    }
    return abs;
  }

  function assertAllowed(absPath, mode) {
    const base = path.basename(absPath).toLowerCase();
    if (DENY_ALL.has(base)) {
      throw httpError(403, 'protected', `受保护文件名,禁止${mode}: ${base}`);
    }
    if (mode !== 'read') {
      const parts = absPath.split(/[\\/]/).map((part) => part.toLowerCase());
      if (parts.some((part) => DENY_WRITE_DIRS.has(part))) {
        throw httpError(403, 'protected', `受保护目录,禁止${mode}`);
      }
    }
    return absPath;
  }

  function relFromRoot(root, absPath) {
    if (typeof absPath !== 'string') return '';
    const rel = path.relative(root, absPath);
    if (rel.startsWith('..')) return absPath;
    return rel.split(path.sep).join('/') || '.';
  }

  /* ---------------- audit ---------------- */

  const AUDIT_MAX_BYTES = 5 * 1024 * 1024;
  const AUDIT_KEEP = 3;

  async function audit(entry) {
    const line = JSON.stringify({ ts: nowIso(), ...entry }) + '\n';
    try {
      const stat = await fsp.stat(auditPath).catch(() => null);
      if (stat && stat.size > AUDIT_MAX_BYTES) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        await fsp.rename(auditPath, `${auditPath}.${stamp}`).catch(() => {});
        const rotated = (await fsp.readdir(path.dirname(auditPath)))
          .filter((fileName) => fileName.startsWith('audit.jsonl.'))
          .sort();
        while (rotated.length > AUDIT_KEEP) {
          const victim = rotated.shift();
          await fsp.unlink(path.join(path.dirname(auditPath), victim)).catch(() => {});
        }
      }
      await fsp.appendFile(auditPath, line, 'utf8');
    } catch { /* audit must never break the action itself */ }
  }

  async function auditTail(limit) {
    try {
      const raw = await fsp.readFile(auditPath, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      const count = Math.max(1, Math.min(200, limit ?? 10));
      return lines.slice(-count).map((line) => {
        try { return JSON.parse(line); } catch { return { ts: '', action: 'corrupt-line', detail: line.slice(0, 120) }; }
      });
    } catch {
      return [];
    }
  }

  /* ---------------- checkpoints ---------------- */

  function hashString(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    return hash;
  }

  async function checkpointFile(action, absPath) {
    let content;
    try {
      content = await fsp.readFile(absPath);
    } catch {
      return null; // nothing to checkpoint (target absent)
    }
    const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const dir = path.join(checkpointsDir, id);
    await fsp.mkdir(dir, { recursive: true });
    const safeName = Date.now().toString(36) + '-' + Math.abs(hashString(path.basename(absPath))).toString(36) + '.bak';
    await fsp.writeFile(path.join(dir, safeName), content);
    const meta = { id, ts: nowIso(), action, path: absPath, size: content.length, file: safeName };
    await writeJsonAtomic(path.join(dir, 'meta.json'), meta);
    await pruneCheckpoints();
    return meta;
  }

  async function pruneCheckpoints() {
    try {
      const entries = await fsp.readdir(checkpointsDir);
      if (entries.length <= 200) return;
      const stats = await Promise.all(entries.map(async (id) => {
        const metaStat = await fsp.stat(path.join(checkpointsDir, id, 'meta.json')).catch(() => null);
        return { id, ts: metaStat ? metaStat.mtimeMs : 0 };
      }));
      stats.sort((a, b) => a.ts - b.ts);
      const excess = stats.slice(0, entries.length - 200);
      for (const item of excess) {
        await fsp.rm(path.join(checkpointsDir, item.id), { recursive: true, force: true }).catch(() => {});
      }
    } catch { /* pruning is best-effort */ }
  }

  async function listCheckpoints(limit) {
    const root = currentWorkspace();
    const ids = (await fsp.readdir(checkpointsDir).catch(() => [])).sort().reverse();
    const out = [];
    for (const id of ids.slice(0, Math.max(1, Math.min(100, limit ?? 30)))) {
      try {
        const meta = JSON.parse(await fsp.readFile(path.join(checkpointsDir, id, 'meta.json'), 'utf8'));
        out.push({
          id: meta.id ?? id,
          ts: meta.ts ?? '',
          action: meta.action ?? 'unknown',
          path: relFromRoot(root, meta.path),
          absolute: meta.path,
          size: meta.size ?? 0,
        });
      } catch { /* skip broken entry */ }
    }
    return out;
  }

  async function restoreCheckpoint(id) {
    const wanted = String(id ?? '').trim();
    if (!/^[0-9]+-[0-9a-f]+$/.test(wanted)) throw httpError(400, 'bad-id', '非法检查点 id');
    const dir = path.join(checkpointsDir, wanted);
    if (!dir.toLowerCase().startsWith(checkpointsDir.toLowerCase() + path.sep)) {
      throw httpError(403, 'escape', '非法检查点 id');
    }
    const meta = await fsp.readFile(path.join(dir, 'meta.json'), 'utf8')
      .then((raw) => JSON.parse(raw))
      .catch(() => { throw httpError(404, 'not-found', `检查点不存在: ${wanted}`); });
    if (!meta || typeof meta.path !== 'string' || !meta.file) {
      throw httpError(404, 'not-found', `检查点数据损坏: ${wanted}`);
    }
    const root = currentWorkspace();
    const rel = relFromRoot(root, meta.path);
    const target = assertAllowed(resolveWithin(root, rel), '恢复');
    await checkpointFile('restore-shadow', target); // shadow current before restoring
    const backup = await fsp.readFile(path.join(dir, meta.file ?? 'data.bak'));
    await atomicWrite(target, backup);
    await audit({ actor: 'hub', action: 'restore', target: rel, ok: true, detail: `checkpoint ${meta.id}` });
    return { restored: rel, from: meta.id };
  }

  /* ---------------- file bridge ---------------- */

  async function atomicWrite(absPath, data) {
    const dir = path.dirname(absPath);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(absPath)}.${process.pid}.${randomUUID().slice(0, 6)}.tmp`);
    try {
      await fsp.writeFile(tmp, data);
      await fsp.rename(tmp, absPath);
    } catch (error) {
      try { await fsp.unlink(tmp); } catch { /* best effort */ }
      throw error;
    }
  }

  async function listDir(rel) {
    const root = currentWorkspace();
    const abs = resolveWithin(root, rel);
    const stat = await fsx.stat(abs).catch(() => null);
    if (!stat) throw httpError(404, 'not-found', `目录不存在: ${rel}`);
    if (!stat.isDirectory()) throw httpError(400, 'not-dir', `不是目录: ${rel}`);
    const dirents = await fsx.listDir(abs);
    const items = [];
    for (const dirent of dirents) {
      const childName = dirent.name;
      const deniedAll = DENY_ALL.has(childName.toLowerCase());
      const deniedWrite = DENY_WRITE_DIRS.has(childName.toLowerCase());
      let size = 0;
      let mtime = 0;
      if (!dirent.isDirectory()) {
        const childStat = await fsx.stat(path.join(abs, childName)).catch(() => null);
        size = childStat ? childStat.size : 0;
        mtime = childStat ? Math.round(childStat.mtimeMs) : 0;
      }
      items.push({
        name: childName,
        type: dirent.isDirectory() ? 'dir' : 'file',
        size,
        mtime,
        readable: !deniedAll,
        writable: !deniedAll && !deniedWrite,
      });
    }
    items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return { path: relFromRoot(root, abs), items };
  }

  const READ_MAX_DEFAULT = 2 * 1024 * 1024;

  async function readTreeFile(rel, maxBytes) {
    const root = currentWorkspace();
    const abs = assertAllowed(resolveWithin(root, rel), '读取');
    const stat = await fsx.stat(abs).catch(() => null);
    if (!stat) throw httpError(404, 'not-found', `文件不存在: ${rel}`);
    if (stat.isDirectory()) throw httpError(400, 'is-dir', `目标是目录: ${rel}`);
    const cap = Math.max(1024, Math.min(8 * 1024 * 1024, Number(maxBytes) || READ_MAX_DEFAULT));
    let content = '';
    let truncated = false;
    if (stat.size > 0) {
      if (hasFs && stat.size <= cap) {
        // DSH fs service can read the whole file at once.
        try {
          content = await fsx.readText(abs);
          if (content.length > cap) { content = content.slice(0, cap); truncated = true; }
        } catch { /* fall through to raw read */ }
      }
      if (!content && !truncated) {
        const handle = await fsp.open(abs, 'r');
        try {
          const length = Math.min(stat.size, cap);
          const buffer = Buffer.alloc(length);
          await handle.read(buffer, 0, length, 0);
          truncated = stat.size > cap;
          content = buffer.toString('utf8');
        } finally {
          await handle.close().catch(() => {});
        }
      }
    }
    return { path: relFromRoot(root, abs), size: stat.size, truncated, content };
  }

  async function requireWriteEnabled() {
    if (!configCache.files.allowWrite) throw httpError(403, 'write-disabled', '文件写入已在设置中关闭');
  }

  async function writeTreeFile(body) {
    await requireWriteEnabled();
    const rel = String(body?.path ?? '').trim();
    if (!rel || rel === '.') throw httpError(400, 'bad-path', '缺少目标文件路径');
    if (body?.content !== undefined && body?.content !== null && typeof body.content !== 'string') {
      throw httpError(400, 'bad-content', 'content 必须是字符串');
    }
    const root = currentWorkspace();
    const abs = assertAllowed(resolveWithin(root, rel), '写入');
    const existed = await fsx.stat(abs).catch(() => null);
    if (existed && existed.isDirectory()) throw httpError(400, 'is-dir', '目标已是目录');
    const cp = existed ? await checkpointFile('write', abs) : null;
    const data = body?.content ?? '';
    await fsx.writeText(abs, data);
    const bytes = Buffer.byteLength(data, 'utf8');
    await audit({ actor: 'hub', action: 'write', target: relFromRoot(root, abs), ok: true, detail: `${bytes}B${cp ? ' checkpoint=' + cp.id : ''}` });
    return { path: relFromRoot(root, abs), bytes, checkpoint: cp?.id ?? null };
  }

  async function makeDir(body) {
    await requireWriteEnabled();
    const rel = String(body?.path ?? '').trim();
    if (!rel || rel === '.') throw httpError(400, 'bad-path', '缺少目录路径');
    const root = currentWorkspace();
    const abs = assertAllowed(resolveWithin(root, rel), '创建目录');
    if (hasFs) {
      // DSH fs has no explicit mkdir; create a sentinel file then remove it.
      const sentinel = path.join(abs, '.dsh-hub-dir');
      try {
        await fsx.writeText(sentinel, '');
        // Try to remove the sentinel (best-effort; directory now exists).
        try { await fsService.deleteText?.({ path: sentinel }); } catch { /* ignore */ }
      } catch { await fsp.mkdir(abs, { recursive: true }); }
    } else {
      await fsp.mkdir(abs, { recursive: true });
    }
    await audit({ actor: 'hub', action: 'mkdir', target: relFromRoot(root, abs), ok: true });
    return { path: relFromRoot(root, abs) };
  }

  async function renameEntry(body) {
    await requireWriteEnabled();
    const from = String(body?.from ?? '').trim();
    const to = String(body?.to ?? '').trim();
    if (!from || !to) throw httpError(400, 'bad-path', 'from/to 均必填');
    const root = currentWorkspace();
    const src = assertAllowed(resolveWithin(root, from), '改名(源)');
    const dst = assertAllowed(resolveWithin(root, to), '改名(目标)');
    const srcStat = await fsx.stat(src).catch(() => null);
    if (!srcStat) throw httpError(404, 'not-found', `源不存在: ${from}`);
    const dstStat = await fsx.stat(dst).catch(() => null);
    if (dstStat) throw httpError(409, 'exists', '目标已存在');
    if (srcStat.isFile()) await checkpointFile('rename-shadow', src);
    if (hasFs) {
      // DSH fs has no rename; copy + delete.
      const content = await fsx.readText(src);
      await fsx.writeText(dst, content);
      try { await fsService.deleteText?.({ path: src }); } catch { await fsp.rm(src, { force: true }); }
    } else {
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      await fsp.rename(src, dst);
    }
    await audit({ actor: 'hub', action: 'rename', from: relFromRoot(root, src), to: relFromRoot(root, dst), ok: true });
    return { from: relFromRoot(root, src), to: relFromRoot(root, dst) };
  }

  async function deleteEntry(body) {
    if (!configCache.files.allowDelete) throw httpError(403, 'delete-disabled', '删除功能默认关闭;请在设置页显式开启');
    if (!strictBool(body?.confirm)) throw httpError(403, 'unconfirmed', '删除需要 confirm=true 显式确认');
    const rel = String(body?.path ?? '').trim();
    if (!rel || rel === '.' || rel === '/' || rel === '\\') throw httpError(403, 'root', '拒绝删除工作区根');
    const root = currentWorkspace();
    const abs = assertAllowed(resolveWithin(root, rel), '删除');
    if (abs.toLowerCase() === root.toLowerCase()) throw httpError(403, 'root', '拒绝删除工作区根');
    const stat = await fsx.stat(abs).catch(() => null);
    if (!stat) throw httpError(404, 'not-found', `不存在: ${rel}`);
    if (stat.isDirectory() && !strictBool(body?.recursive)) {
      const children = await fsx.listDir(abs);
      if (children.length > 0) throw httpError(409, 'not-empty', '目录非空,需要 recursive=true');
    }
    let cp = null;
    if (stat.isFile()) cp = await checkpointFile('delete', abs);
    if (hasFs) {
      try { await fsService.deleteText?.({ path: abs }); } catch { /* fall through */ }
      // For directories, DSH fs has no delete; fall back to raw rm.
      if (stat.isDirectory()) await fsp.rm(abs, { recursive: true, force: true });
    } else {
      await fsp.rm(abs, { recursive: true, force: true });
    }
    await audit({ actor: 'hub', action: 'delete', target: relFromRoot(root, abs), ok: true, detail: cp ? 'checkpoint=' + cp.id : 'directory' });
    return { deleted: relFromRoot(root, abs), checkpoint: cp?.id ?? null };
  }

  /* ---------------- terminal ---------------- */

  const running = new Map();

  function shellArgv(shellName, cmdText) {
    const which = String(shellName ?? 'powershell').toLowerCase();
    if (which === 'cmd') return ['cmd.exe', ['/d', '/s', '/c', cmdText], 'cmd'];
    if (which === 'pwsh') return ['pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', cmdText], 'powershell'];
    return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmdText], 'powershell'];
  }

  async function killTree(pid) {
    if (process.platform === 'win32') {
      await new Promise((resolve) => {
        const killer = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
        killer.on('close', () => resolve());
        killer.on('error', () => resolve());
      });
    } else {
      try { process.kill(-pid); } catch { try { process.kill(pid); } catch { /* already gone */ } }
    }
  }

  function stopTerminal(id) {
    const child = running.get(String(id ?? ''));
    if (!child) return { stopped: false };
    killTree(child.pid);
    return { stopped: true };
  }

  function stopAllTerminals() {
    const ids = [...running.keys()];
    for (const id of ids) {
      const child = running.get(id);
      running.delete(id);
      if (child && child.pid) killTree(child.pid);
    }
    return ids.length;
  }

  function terminalState() {
    return [...running.keys()];
  }

  /**
   * Run a command. When DSH's shell service is available, route through it
   * (sandbox-aware). Otherwise fall back to raw child_process (smoke test).
   */
  async function runTerminal(body) {
    if (!configCache.terminal.enabled) throw httpError(403, 'terminal-disabled', '终端已在设置中关闭');
    const cmdText = String(body?.cmd ?? '').trim();
    if (!cmdText) throw httpError(400, 'bad-cmd', '命令为空');
    if (running.size >= 5) throw httpError(429, 'busy', '并发终端任务已达上限(5)');
    const danger = looksDangerous(cmdText);
    if (danger && configCache.terminal.dangerConfirm && !strictBool(body?.dangerOk)) {
      throw httpError(403, 'danger-confirm-required', '检测到危险命令模式;需要严格布尔 dangerOk=true 确认后执行');
    }
    const timeoutMs = Math.max(1000, Math.min(600000, Number(body?.timeoutMs) || configCache.terminal.timeoutMs));
    const maxOut = Math.max(1024, Math.min(2 * 1024 * 1024, Number(body?.maxOutputBytes) || configCache.terminal.maxOutputBytes));
    const cwdRel = String(body?.cwd ?? '').trim();
    const root = currentWorkspace();
    const cwd = cwdRel ? resolveWithin(root, cwdRel) : root;

    // --- Path A: DSH shell service (sandbox-aware) ---
    if (hasShell && shellService) {
      try {
        const spec = await Promise.resolve(shellService.resolve({ command: cmdText, cwd, timeoutMs, maxOutputBytes: maxOut }));
        const result = await Promise.resolve(shellService.run(spec));
        const payload = {
          id: randomUUID().slice(0, 8),
          code: result?.exitCode ?? result?.code ?? null,
          signal: result?.signal ?? null,
          timedOut: !!result?.timedOut,
          durationMs: result?.durationMs ?? 0,
          truncated: !!result?.truncated,
          shell: result?.shell ?? configCache.terminal.shell,
          stdout: result?.stdout ?? '',
          stderr: result?.stderr ?? '',
          error: result?.error ?? null,
        };
        await audit({
          actor: 'hub', action: 'terminal', target: cmdText.slice(0, 200),
          ok: payload.code === 0,
          detail: `shell=${payload.shell} code=${payload.code} ${payload.durationMs}ms${payload.timedOut ? ' timeout' : ''}${danger ? ' danger-ok' : ''}`,
        });
        return payload;
      } catch { /* fall through to raw spawn */ }
    }

    // --- Path B: raw child_process (fallback for smoke test) ---
    const [file, argv, shellUsed] = shellArgv(configCache.terminal.shell, cmdText);

    const id = randomUUID().slice(0, 8);
    const startedAt = Date.now();
    const result = await new Promise((resolve) => {
      let child;
      try {
        child = spawn(file, argv, { cwd, windowsHide: true, env: { ...process.env, DEVERAI_HUB: '1' } });
      } catch (error) {
        resolve({ code: null, signal: null, errorMessage: error.message });
        return;
      }
      running.set(id, child);
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let truncated = false;
      let timedOut = false;
      let settledDone = false;

      const finish = (code, signal, errorMessage) => {
        if (settledDone) return;
        settledDone = true;
        clearTimeout(timer);
        running.delete(id);
        resolve({
          id,
          code,
          signal,
          timedOut,
          durationMs: Date.now() - startedAt,
          truncated,
          shell: shellUsed,
          stdout: stdout.toString('utf8'),
          stderr: stderr.toString('utf8'),
          error: errorMessage ?? null,
        });
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child.pid);
      }, timeoutMs);

      child.stdout.on('data', (chunk) => {
        if (stdout.length + chunk.length > maxOut) {
          const room = Math.max(0, maxOut - stdout.length);
          if (room > 0) stdout = Buffer.concat([stdout, chunk.subarray(0, room)]);
          truncated = true;
        } else {
          stdout = Buffer.concat([stdout, chunk]);
        }
      });
      child.stderr.on('data', (chunk) => {
        if (stderr.length + chunk.length > maxOut) {
          const room = Math.max(0, maxOut - stderr.length);
          if (room > 0) stderr = Buffer.concat([stderr, chunk.subarray(0, room)]);
          truncated = true;
        } else {
          stderr = Buffer.concat([stderr, chunk]);
        }
      });
      child.on('error', (error) => finish(null, null, error.message));
      child.on('close', (code, signal) => finish(code, signal, null));
    });

    const payload = {
      id,
      code: result.code ?? null,
      signal: result.signal ?? null,
      timedOut: result.timedOut ?? false,
      durationMs: result.durationMs ?? 0,
      truncated: result.truncated ?? false,
      shell: result.shell ?? shellUsed,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      error: result.error ?? null,
    };
    await audit({
      actor: 'hub',
      action: 'terminal',
      target: cmdText.slice(0, 200),
      ok: payload.code === 0,
      detail: `shell=${payload.shell} code=${payload.code} ${payload.durationMs}ms${payload.timedOut ? ' timeout' : ''}${danger ? ' danger-ok' : ''}`,
    });
    return payload;
  }

  /* ---------------- workspace snapshots ---------------- *
   * DeverAI「工作树安全备份审核」: two-level safety net.
   *   Level 1 — file checkpoints (see checkpointFile / listCheckpoints,
   *     restoreCheckpoint above): one .bak per write, per-file version history.
   *   Level 2 — workspace snapshots (below): full-workspace zip created on
   *     demand, restorable, auto-checkpointed before overwrite. Neither level
   *     involves git / GitHub — pure filesystem safety. */

  const snapshotsDir = path.join(storageRoot, 'snapshots');

  /** Directories excluded from a workspace snapshot (noise / huge / self). */
  const SNAPSHOT_EXCLUDE = new Set(['backups', 'data', 'sessions', '.git', 'node_modules', '__pycache__', '.worktrees', 'snapshots', 'Err.log']);

  function safeSnapshotName(name) {
    const s = String(name ?? '').trim();
    if (!s || s === '.' || s === '..' || /[\\/:*?"<>|]/.test(s)) throw httpError(400, 'bad-name', '非法快照名称');
    if (s.length > 120) throw httpError(400, 'bad-name', '名称过长');
    return s;
  }

  /** Cross-platform workspace → zip via system archiver (no npm deps). */
  async function zipWorkspace(root, zipPath) {
    await fsp.mkdir(path.dirname(zipPath), { recursive: true });
    if (process.platform === 'win32') {
      // PowerShell CompressedArchive — built into Windows, zero deps.
      // -Force replaces an existing archive; -Optimal for speed.
      const excludeList = [...SNAPSHOT_EXCLUDE].join(',');
      const ps = `Get-ChildItem -Path '${root}' -Force | Where-Object { $_.Name -notin @('${excludeList.replace(/'/g, "''")}') } | Compress-Archive -DestinationPath '${zipPath.replace(/'/g, "''")}' -CompressionLevel Optimal -Force`;
      await new Promise((resolve, reject) => {
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
        let err = '';
        child.stderr.on('data', (c) => { err += c.toString(); });
        child.on('error', (e) => reject(e));
        child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Compress-Archive exit ${code}: ${err.slice(0, 300)}`)));
      });
    } else {
      // POSIX: tar + gzip via the ubiquitous `tar` binary.
      // --exclude skips noise directories; -C chdirs into the workspace root
      // so the archive stores relative paths.
      await new Promise((resolve, reject) => {
        const child = spawn('tar', ['-czf', zipPath, '-C', root, '--exclude=backups', '--exclude=data', '--exclude=sessions', '--exclude=.git', '--exclude=node_modules', '--exclude=__pycache__', '--exclude=.worktrees', '--exclude=snapshots', '--exclude=Err.log', '.'], { windowsHide: true });
        let err = '';
        child.stderr.on('data', (c) => { err += c.toString(); });
        child.on('error', (e) => reject(e));
        child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`tar exit ${code}: ${err.slice(0, 300)}`)));
      });
    }
  }

  /** Cross-platform zip → workspace. */
  async function unzipToWorkspace(zipPath, root) {
    if (process.platform === 'win32') {
      const ps = `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${root.replace(/'/g, "''")}' -Force`;
      await new Promise((resolve, reject) => {
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
        let err = '';
        child.stderr.on('data', (c) => { err += c.toString(); });
        child.on('error', (e) => reject(e));
        child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Expand-Archive exit ${code}: ${err.slice(0, 300)}`)));
      });
    } else {
      await new Promise((resolve, reject) => {
        const child = spawn('tar', ['-xzf', zipPath, '-C', root], { windowsHide: true });
        let err = '';
        child.stderr.on('data', (c) => { err += c.toString(); });
        child.on('error', (e) => reject(e));
        child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`tar exit ${code}: ${err.slice(0, 300)}`)));
      });
    }
  }

  async function createSnapshot(name) {
    const root = currentWorkspace();
    const raw = String(name ?? '').trim();
    if (raw) safeSnapshotName(raw); // validate user-supplied name (throws on bad chars)
    const clean = raw || `快照 ${new Date().toLocaleString()}`;
    const id = `snap_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const zipPath = path.join(snapshotsDir, `${id}.zip`);
    await zipWorkspace(root, zipPath);
    const stat = await fsp.stat(zipPath);
    const meta = { id, name: clean, ts: nowIso(), size: stat.size, workspace: root };
    await writeJsonAtomic(path.join(snapshotsDir, `${id}.json`), meta);
    await audit({ actor: 'hub', action: 'snapshot-create', target: clean, ok: true, detail: `${Math.round(stat.size / 1024)}KB` });
    return meta;
  }

  async function listSnapshots() {
    const ids = (await fsp.readdir(snapshotsDir).catch(() => []));
    const out = [];
    for (const fn of ids) {
      if (!fn.endsWith('.json')) continue;
      try {
        const meta = JSON.parse(await fsp.readFile(path.join(snapshotsDir, fn), 'utf8'));
        if (typeof meta.id !== 'string') continue;
        const zipPath = path.join(snapshotsDir, `${meta.id}.zip`);
        const hasZip = fs.existsSync(zipPath);
        out.push({ id: meta.id, name: meta.name ?? '(未命名)', ts: meta.ts ?? '', size: meta.size ?? 0, workspace: meta.workspace ?? '', hasZip });
      } catch { /* skip broken */ }
    }
    out.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    return out;
  }

  async function restoreSnapshot(id) {
    const wanted = String(id ?? '').trim();
    if (!/^snap_\d+_[0-9a-f]+$/.test(wanted)) throw httpError(400, 'bad-id', '非法快照 id');
    const zipPath = path.join(snapshotsDir, `${wanted}.zip`);
    if (!fs.existsSync(zipPath)) throw httpError(404, 'not-found', `快照不存在: ${wanted}`);
    const meta = await fsp.readFile(path.join(snapshotsDir, `${wanted}.json`), 'utf8').then((r) => JSON.parse(r)).catch(() => ({}));
    const root = currentWorkspace();
    // Safety net: auto-checkpoint the workspace BEFORE overwriting, so a
    // restore is always itself undoable.
    try { await createSnapshot(`auto-before-restore-${wanted.slice(14, 22)}`); } catch { /* best-effort */ }
    await unzipToWorkspace(zipPath, root);
    await audit({ actor: 'hub', action: 'snapshot-restore', target: meta.name ?? wanted, ok: true, detail: `restore into ${root}` });
    return { restored: meta.name ?? wanted, into: root };
  }

  async function deleteSnapshot(id) {
    const wanted = String(id ?? '').trim();
    if (!/^snap_\d+_[0-9a-f]+$/.test(wanted)) throw httpError(400, 'bad-id', '非法快照 id');
    const zipPath = path.join(snapshotsDir, `${wanted}.zip`);
    const jsonPath = path.join(snapshotsDir, `${wanted}.json`);
    let name = wanted;
    try { name = (JSON.parse(await fsp.readFile(jsonPath, 'utf8')) || {}).name ?? wanted; } catch { /* ignore */ }
    await fsp.rm(zipPath, { force: true });
    await fsp.rm(jsonPath, { force: true });
    await audit({ actor: 'hub', action: 'snapshot-delete', target: name, ok: true });
    return { deleted: wanted };
  }

  /* ---------------- overview ---------------- */

  async function overview() {
    const root = currentWorkspace();
    let checkpointCount = 0;
    let snapshotCount = 0;
    try { checkpointCount = (await fsp.readdir(checkpointsDir)).length; } catch { /* none yet */ }
    try { snapshotCount = (await fsp.readdir(snapshotsDir).catch(() => [])).filter((f) => f.endsWith('.json')).length; } catch { /* none */ }
    const audits = await auditTail(10);
    return {
      version,
      plugin: name,
      workspace: {
        root,
        name: path.basename(root) || root,
        overrideActive: Boolean(String(configCache.workspaceOverride ?? '').trim()),
      },
      counts: { checkpoints: checkpointCount, snapshots: snapshotCount, runningTerminals: running.size },
      config: {
        files: cloneJson(configCache.files),
        terminal: {
          enabled: configCache.terminal.enabled,
          shell: configCache.terminal.shell,
          dangerConfirm: configCache.terminal.dangerConfirm,
          timeoutMs: configCache.terminal.timeoutMs,
          maxOutputBytes: configCache.terminal.maxOutputBytes,
        },
        dock: cloneJson(configCache.dock),
        workspaceOverride: configCache.workspaceOverride,
      },
      storage: { root: storageRoot, home: dshHome() },
      recentAudit: audits,
      serverTime: nowIso(),
    };
  }

  return {
    getConfig,
    updateConfig,
    currentWorkspace,
    listDir,
    readTreeFile,
    writeTreeFile,
    makeDir,
    renameEntry,
    deleteEntry,
    listCheckpoints,
    restoreCheckpoint,
    createSnapshot,
    listSnapshots,
    restoreSnapshot,
    deleteSnapshot,
    runTerminal,
    stopTerminal,
    stopAllTerminals,
    terminalState,
    overview,
    auditTail,
    looksDangerous,
    storageRoot,
    // Settings service sync: when DSH settings change, update the hub's
    // config cache so file/terminal/dock behavior reflects the new values.
    _syncFromSettings(next) {
      configCache = next;
      // Persist to config.json as a backup (settings is the source of truth).
      writeJsonAtomic(configPath, next).catch(() => {});
    },
  };
}

/* ------------------------------------------------------------------ *
 * HTTP plumbing
 * ------------------------------------------------------------------ */

function sendJson(res, status, payload) {
  if (res.headersSent) { try { res.end(); } catch { /* ignore */ } return; }
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      total += chunk.length;
      if (total > limitBytes) {
        failed = true;
        reject(httpError(413, 'too-large', '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      if (chunks.length === 0) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(httpError(400, 'bad-json', '请求体不是合法 JSON'));
      }
    });
    req.on('error', (error) => { if (!failed) reject(error); });
  });
}

/* ------------------------------------------------------------------ *
 * Route table (pure so the smoke test can drive it without webServer)
 * ------------------------------------------------------------------ */

export function buildRouteTable(hub) {
  const routes = [
    ['GET', '/info', async () => hub.overview()],
    ['POST', '/config', async (_ctx, body) => hub.updateConfig(body)],
    ['GET', '/workspace', async () => ({ root: hub.currentWorkspace(), overrideActive: Boolean(String(hub.getConfig().workspaceOverride ?? '').trim()) })],
    ['GET', '/fs/list', async (_ctx, _body, query) => hub.listDir(query.get('path') ?? '.')],
    ['GET', '/fs/read', async (_ctx, _body, query) => hub.readTreeFile(query.get('path') ?? '.', query.get('maxBytes'))],
    ['POST', '/fs/write', async (_ctx, body) => hub.writeTreeFile(body)],
    ['POST', '/fs/mkdir', async (_ctx, body) => hub.makeDir(body)],
    ['POST', '/fs/rename', async (_ctx, body) => hub.renameEntry(body)],
    ['POST', '/fs/delete', async (_ctx, body) => hub.deleteEntry(body)],
    ['GET', '/checkpoints', async (_ctx, _body, query) => ({ items: await hub.listCheckpoints(Number(query.get('limit') ?? 30)) })],
    ['POST', '/checkpoints/restore', async (_ctx, body) => hub.restoreCheckpoint(body?.id)],
    ['POST', '/term/run', async (_ctx, body) => hub.runTerminal(body)],
    ['POST', '/term/stop', async (_ctx, body) => hub.stopTerminal(body?.id)],
    ['GET', '/term/state', async () => ({ running: hub.terminalState() })],
    ['GET', '/state/overview', async () => hub.overview()],
    ['GET', '/danger/check', async (_ctx, _body, query) => ({ cmd: query.get('cmd') ?? '', dangerous: hub.looksDangerous(query.get('cmd') ?? '') })],
    ['GET', '/snapshots', async () => ({ items: await hub.listSnapshots() })],
    ['POST', '/snapshots/create', async (_ctx, body) => hub.createSnapshot(body?.name)],
    ['POST', '/snapshots/restore', async (_ctx, body) => hub.restoreSnapshot(body?.id)],
    ['POST', '/snapshots/delete', async (_ctx, body) => hub.deleteSnapshot(body?.id)],
    ['POST', '/client-error', async (_ctx, body) => {
      const message = String(body?.message ?? 'unknown').slice(0, 200);
      const stack = String(body?.stack ?? '').slice(0, 800);
      await hub.audit({ actor: 'browser', action: 'client-error', target: message, ok: false, detail: stack });
      return { logged: true };
    }],
  ];

  async function dispatch(method, pathname, body, query) {
    for (const [routeMethod, routePath, handler] of routes) {
      if (routeMethod === method && routePath === pathname) {
        return handler({}, body, query);
      }
    }
    throw httpError(404, 'no-route', `未知端点: ${method} ${pathname}`);
  }

  return { routes, dispatch };
}

/* ------------------------------------------------------------------ *
 * apply — mount onto the Cordis context
 * ------------------------------------------------------------------ */

export function apply(ctx) {
  const webServer = ctx.get('webServer');

  const home = (globalThis.process?.env?.DSH_HOME ?? '').trim() || path.join(os.homedir(), '.dsh');
  const storageRoot = path.join(home, 'storages', 'deverai-hub');
  try { fs.mkdirSync(path.join(storageRoot, 'checkpoints'), { recursive: true }); } catch { /* exists */ }
  try { fs.mkdirSync(path.join(storageRoot, 'snapshots'), { recursive: true }); } catch { /* exists */ }

  // DSH shared services (sandbox-aware fs/shell, shared settings, model
  // registry). Declared as hard deps in inject[], so these resolve through
  // DSH. When absent (standalone smoke test) the hub falls back to raw
  // node:fs + child_process.
  const hub = createHub({
    storageRoot,
    getService: (key) => ctx.get(key),
    fs: ctx.fs,
    shell: ctx.shell,
    settings: ctx.settings,
    llm: ctx.llm,
  });

  // Seed the config file once (wx: never clobber an existing configuration).
  try {
    fs.writeFileSync(path.join(storageRoot, 'config.json'), JSON.stringify(hub.getConfig(), null, 2), { flag: 'wx' });
  } catch { /* already present */ }

  const { dispatch } = buildRouteTable(hub);
  const BODY_LIMIT = 24 * 1024 * 1024;

  async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://loopback');
    let sub = url.pathname.startsWith('/hub') ? url.pathname.slice(4) : url.pathname;
    sub = (sub || '/').replace(/\/+$/, '') || '/';
    const method = (req.method ?? 'GET').toUpperCase();
    try {
      const body = method === 'GET' ? {} : await readBody(req, BODY_LIMIT);
      const data = await dispatch(method, sub, body, url.searchParams);
      sendJson(res, 200, { ok: true, data });
    } catch (error) {
      const status = Number(error?.status) || 500;
      const code = String(error?.code ?? 'internal');
      const message = String(error?.message ?? '内部错误');
      if (status >= 500) console.error(`[deverai-hub] ${method} ${sub} failed:`, message);
      sendJson(res, status, { ok: false, error: { code, message } });
    }
  }

  if (webServer) {
    ctx.effect(() => webServer.register({ kind: 'prefix', path: '/hub', handler }));
  }

  // RPC handlers (harness.handle / host.call) — Package-private JSON RPC.
  // More efficient than HTTP (no network stack) and the idiomatic DSH way for
  // host↔client communication. The HTTP endpoints above remain for backward
  // compatibility with external tools.
  const rpcHandlers = [];
  const rpc = (method, fn) => {
    const disposer = ctx.harness.handle(`deverai-hub.${method}`, (args) => fn(args ?? {}));
    rpcHandlers.push(disposer);
  };
  rpc('info', async () => hub.overview());
  rpc('config', async (args) => hub.updateConfig(args));
  rpc('workspace', async () => ({ root: hub.currentWorkspace(), overrideActive: Boolean(String(hub.getConfig().workspaceOverride ?? '').trim()) }));
  rpc('fs.list', async (args) => hub.listDir(args?.path ?? '.'));
  rpc('fs.read', async (args) => hub.readTreeFile(args?.path ?? '.', args?.maxBytes));
  rpc('fs.write', async (args) => hub.writeTreeFile(args));
  rpc('fs.mkdir', async (args) => hub.makeDir(args));
  rpc('fs.rename', async (args) => hub.renameEntry(args));
  rpc('fs.delete', async (args) => hub.deleteEntry(args));
  rpc('checkpoints', async (args) => ({ items: await hub.listCheckpoints(args?.limit ?? 30) }));
  rpc('checkpoints.restore', async (args) => hub.restoreCheckpoint(args?.id));
  rpc('term.run', async (args) => hub.runTerminal(args));
  rpc('term.stop', async (args) => hub.stopTerminal(args?.id));
  rpc('term.state', async () => ({ running: hub.terminalState() }));
  rpc('danger.check', async (args) => ({ cmd: args?.cmd ?? '', dangerous: hub.looksDangerous(args?.cmd ?? '') }));
  rpc('snapshots', async () => ({ items: await hub.listSnapshots() }));
  rpc('snapshots.create', async (args) => hub.createSnapshot(args?.name));
  rpc('snapshots.restore', async (args) => hub.restoreSnapshot(args?.id));
  rpc('snapshots.delete', async (args) => hub.deleteSnapshot(args?.id));

  // Settings service integration: register hub config as a DSH settings
  // namespace so it appears in DSH's settings UI and is stored in DSH's
  // shared settings document (not a separate config.json).
  if (hasSettings && zod) {
    try {
      const HubSchema = zod.object({
        workspaceOverride: zod.string().optional(),
        files: zod.object({
          allowWrite: zod.boolean().optional(),
          allowDelete: zod.boolean().optional(),
        }).optional(),
        terminal: zod.object({
          enabled: zod.boolean().optional(),
          shell: zod.string().optional(),
          timeoutMs: zod.number().optional(),
          maxOutputBytes: zod.number().optional(),
          dangerConfirm: zod.boolean().optional(),
        }).optional(),
        dock: zod.object({
          visible: zod.boolean().optional(),
          tab: zod.string().optional(),
          widthPx: zod.number().optional(),
        }).optional(),
      });
      const settingsScope = settingsService.register('deverai-hub', HubSchema, {
        base: () => cloneJson(DEFAULT_CONFIG),
      });
      // Sync initial config from storage into settings (if storage has config).
      const storedConfig = (() => { try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { return null; } })();
      if (storedConfig) { settingsService.replace('deverai-hub', storedConfig).catch(() => {}); }
      // Observe settings changes and sync back to hub's config cache.
      settingsScope.observe((value) => {
        const next = mergeConfig(DEFAULT_CONFIG, value);
        next.version = 1;
        hub._syncFromSettings(next);
      });
      ctx.effect(() => () => { try { settingsScope.dispose(); } catch { /* ignore */ } });
    } catch { /* settings registration failed — fall back to config.json */ }
  }

  // Kill orphaned terminal children when the plugin stops or updates.
  ctx.effect(() => () => {
    try { hub.stopAllTerminals(); } catch { /* stopping anyway */ }
    for (const disposer of rpcHandlers) { try { disposer(); } catch { /* ignore */ } }
  });
}

export default { name, inject, apply, version };
