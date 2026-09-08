/**
 * @deverai/model-router — score-based multi-model auto router (host half).
 *
 * Activation contract:
 *  - The FORK's dsh-llm consults globalThis.__deveraiRouteHook inside
 *    streamWithRegistration (a no-op unless the global is a function).
 *  - This package installs that hook ONLY when process.env.DEVERAI_ROUTER ===
 *    "1"; the official launcher keeps stock behavior even with this row
 *    composed and its /router/state endpoint answering {active:false}.
 *  - storages/deverai-router/pool.json holds the model pool plus the master
 *    `enabled` switch; rolling scores persist to scores.json.
 *
 * Routing policy:
 *  - Explicit user selections pass through untouched: when the incoming
 *    {provider, model} differs from agentDefaultModel.currentSelection(),
 *    the request was deliberately chosen by a human or a preset.
 *  - Default-routed calls are rewritten to the best eligible pool entry:
 *    "score" (rolling success x latency), "priority", or "round-robin".
 *    A failed model enters a cooldown and later requests fail over.
 */
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PLUGIN_NAME = "deverai-model-router";
const ROUTE_PREFIX = "/router";
const COOLDOWN_MS = 60_000;
const WINDOW_SIZE = 20;
const PERSIST_DEBOUNCE_MS = 2_000;
const BODY_LIMIT = 1024 * 1024;

/** Correlates routed option objects (WeakMap key) with their outcome records. */
const records = new WeakMap();

function httpError(status, code, message) {
	const error = new Error(message);
	error.status = status;
	error.code = code;
	return error;
}

function deepFreeze(value) {
	if (value !== null && typeof value === "object") {
		for (const key of Object.keys(value)) deepFreeze(value[key]);
		Object.freeze(value);
	}
	return value;
}

async function atomicWriteText(file, text) {
	const dir = path.dirname(file);
	await fsp.mkdir(dir, { recursive: true });
	const tmp = path.join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await fsp.writeFile(tmp, text, "utf8");
	await fsp.rename(tmp, file);
}

function storageDir() {
	const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
	return path.join(home, "storages", "deverai-router");
}

function sendJson(res, status, payload) {
	if (res.writableEnded) return;
	const body = JSON.stringify(payload);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
	res.end(body);
}

function readBody(req, limit) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let total = 0;
		req.on("data", (chunk) => {
			total += chunk.length;
			if (total > limit) {
				reject(httpError(413, "payload-too-large", `请求体超过 ${limit} 字节上限`));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (!chunks.length) return resolve({});
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch {
				reject(httpError(400, "bad-json", "请求体不是合法 JSON"));
			}
		});
		req.on("error", reject);
	});
}

const DEFAULT_POOL = {
	enabled: false,
	strategy: "score",
	models: [
		// Mirrors the current settings.yaml provider registry. The default
		// (zai/glm-5.3-flash) leads so first-run default calls resolve to
		// "keep" and only fail over when it actually errors.
		{ id: "zai/glm-5.3-flash", provider: "zai", model: "glm-5.3-flash", priority: 10, enabled: true },
		{ id: "xiaomi-token-plan-cn/mimo-v2.5-pro", provider: "xiaomi-token-plan-cn", model: "mimo-v2.5-pro", priority: 20, enabled: true }
	]
};

function clonePool(pool) {
	return JSON.parse(JSON.stringify(pool));
}

const STRATEGIES = ["score", "priority", "round-robin"];

function mergePool(base, patch) {
	const out = clonePool(base);
	if (patch && typeof patch === "object") {
		if (typeof patch.enabled === "boolean") out.enabled = patch.enabled;
		if (STRATEGIES.includes(patch.strategy)) out.strategy = patch.strategy;
		if (Array.isArray(patch.models)) {
			out.models = patch.models
				.filter((entry) => entry && typeof entry.provider === "string" && typeof entry.model === "string")
				.map((entry, index) => ({
					id: typeof entry.id === "string" && entry.id ? entry.id : `${entry.provider}/${entry.model}`,
					provider: entry.provider,
					model: entry.model,
					priority: Number.isFinite(entry.priority) ? entry.priority : (index + 1) * 10,
					enabled: entry.enabled !== false
				}));
		}
	}
	return out;
}

/**
 * Create the router runtime. Exported for tests: pass explicit paths and a
 * clock for deterministic suites.
 * @param {object} options
 * @param {object} [options.llm] — DSH llm service (ctx.llm). When provided,
 *   discoverModels() seeds the pool from DSH's registered providers/models.
 */
export function createRouter(options = {}) {
	const dir = options.storageDir || storageDir();
	const poolFile = path.join(dir, "pool.json");
	const scoresFile = path.join(dir, "scores.json");
	const now = options.now || (() => Date.now());

	let pool = clonePool(DEFAULT_POOL);
	let scores = { byModel: {} };
	let persistTimer = null;
	let lastDecision = { at: now(), action: "pass", reason: "idle" };
	let currentDefaults = null;
	let llmService = options.llm || null;
	/** Cache of DSH-discovered models (provider -> [{id, model, contextWindow}]). */
	let discoveredModels = null;

	/**
	 * Query DSH's llm service for every registered provider and its advertised
	 * models. Returns {provider: [{id, model, contextWindow, isDefault}]}.
	 * Cached after the first successful call. Never throws — discovery is
	 * best-effort and falls back to the static pool on any failure.
	 */
	async function discoverModels() {
		if (discoveredModels) return discoveredModels;
		discoveredModels = {};
		if (!llmService) return discoveredModels;
		try {
			const providers = await Promise.resolve(llmService.listProviders());
			if (!Array.isArray(providers)) return discoveredModels;
			for (const p of providers) {
				const providerKey = p?.key || p?.provider || p?.id;
				if (!providerKey) continue;
				discoveredModels[providerKey] = [];
				try {
					const models = await Promise.resolve(llmService.listModels(providerKey));
					if (!Array.isArray(models)) continue;
					for (const m of models) {
						discoveredModels[providerKey].push({
							id: m?.id || m?.model || m?.key,
							model: m?.model || m?.id || m?.key,
							contextWindow: m?.contextWindow || m?.contextSize || m?.maxTokens || 0,
							isDefault: !!m?.isDefault,
						});
					}
				} catch { /* skip this provider */ }
			}
		} catch { /* discovery best-effort */ }
		return discoveredModels;
	}

	/**
	 * Merge DSH-discovered models into the pool. Existing user-configured
	 * entries are preserved; discovered models are added only if not already
	 * present (matched by provider+model). Returns the merged pool.
	 */
	async function mergeDiscovered() {
		const discovered = await discoverModels();
		const providers = Object.keys(discovered);
		if (providers.length === 0) return pool;
		const next = clonePool(pool);
		let added = 0;
		for (const provider of providers) {
			for (const m of discovered[provider]) {
				if (!m || !m.model) continue;
				const exists = next.models.some((e) => e.provider === provider && e.model === m.model);
				if (exists) continue;
				const id = m.id || `${provider}/${m.model}`;
				next.models.push({
					id,
					provider,
					model: m.model,
					priority: 50 + added,
					enabled: false, // discovered models start disabled; opt-in
				});
				added++;
			}
		}
		if (added > 0) { pool = next; schedulePersist(); }
		return pool;
	}

	async function loadState() {
		try {
			pool = mergePool(DEFAULT_POOL, JSON.parse(await fsp.readFile(poolFile, "utf8")));
		} catch { /* first run or damaged file -> defaults */ }
		try {
			const parsed = JSON.parse(await fsp.readFile(scoresFile, "utf8"));
			if (parsed && typeof parsed.byModel === "object") scores = parsed;
		} catch { /* no history yet */ }
		// Seed the pool from DSH's registered providers/models (best-effort).
		if (llmService) { try { await mergeDiscovered(); } catch { /* ignore */ } }
	}

	function schedulePersist() {
		if (persistTimer) return;
		persistTimer = setTimeout(() => {
			persistTimer = null;
			atomicWriteText(scoresFile, JSON.stringify(scores, null, 2)).catch(() => {});
		}, PERSIST_DEBOUNCE_MS);
		if (typeof persistTimer.unref === "function") persistTimer.unref();
	}

	function flushScores() {
		if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
		return atomicWriteText(scoresFile, JSON.stringify(scores, null, 2)).catch(() => {});
	}

	function entryFor(provider, model) {
		return pool.models.find((m) => m.provider === provider && m.model === model) ?? null;
	}

	function statsFor(id) {
		let stats = scores.byModel[id];
		if (!stats || !Array.isArray(stats.window)) {
			stats = { window: [], coolUntil: 0 };
			scores.byModel[id] = stats;
		}
		return stats;
	}

	function recordOutcome(id, ok, latencyMs) {
		const stats = statsFor(id);
		stats.window.push(ok ? 1 : 0);
		if (stats.window.length > WINDOW_SIZE) stats.window.shift();
		if (ok) {
			stats.lastOkAt = now();
			stats.lastMs = Math.round(latencyMs);
		} else {
			stats.lastFailAt = now();
			stats.coolUntil = now() + COOLDOWN_MS;
		}
		schedulePersist();
	}

	function eligibleModels() {
		const t = now();
		return pool.models.filter((m) => m.enabled !== false && (statsFor(m.id).coolUntil ?? 0) <= t);
	}

	function scoreOf(id) {
		const window = statsFor(id).window;
		if (!window.length) return 0.5; // unknown -> neutral
		const okRate = window.reduce((sum, flag) => sum + flag, 0) / window.length;
		const lastMs = statsFor(id).lastMs;
		const latencyFactor = lastMs && lastMs > 0 ? Math.min(1, 30_000 / lastMs) : 0.75;
		return okRate * (0.6 + 0.4 * latencyFactor);
	}

	function pickCandidate() {
		const eligible = eligibleModels();
		if (!eligible.length) return null;
		if (pool.strategy === "priority") return [...eligible].sort((a, b) => a.priority - b.priority)[0];
		if (pool.strategy === "round-robin") {
			state.rrIndex = ((state.rrIndex ?? -1) + 1) % eligible.length;
			return eligible[state.rrIndex];
		}
		return [...eligible].sort((a, b) => scoreOf(b.id) - scoreOf(a.id))[0];
	}

	const state = {
		rrIndex: -1,
		gateActive: false,

		/** The __deveraiRouteHook decision function. Never mutates the input. */
		decide(options) {
			lastDecision = { at: now(), action: "pass", reason: "disabled-or-empty" };
			if (!pool.enabled || !pool.models.length) return options;
			if (options?.__deveraiNoRoute === true) {
				lastDecision = { at: now(), action: "pass", reason: "inner-retry" };
				return options;
			}
			const selection = typeof currentDefaults === "function" ? currentDefaults() : null;
			if (selection && (options.provider !== selection.provider || options.model !== selection.model)) {
				lastDecision = { at: now(), action: "pass", reason: "explicit-selection" };
				return options;
			}
			const source = entryFor(options.provider, options.model);
			if (!source) {
				// The default model is not a pool member: the pool does not govern
				// it (predictable scope — only models added to the pool get routed).
				lastDecision = { at: now(), action: "pass", reason: "default-not-in-pool" };
				return options;
			}
			const candidate = pickCandidate();
			if (!candidate) {
				lastDecision = { at: now(), action: "pass", reason: "no-eligible-candidate" };
				return options;
			}
			if (source && source.id === candidate.id) {
				lastDecision = { at: now(), action: "keep", reason: "already-best", model: candidate.id };
				return options;
			}
			const routed = Object.isFrozen(options)
				? deepFreeze({ ...options, provider: candidate.provider, model: candidate.model })
				: { ...options, provider: candidate.provider, model: candidate.model };
			records.set(routed, { id: candidate.id, start: now(), routed: true });
			lastDecision = {
				at: now(),
				action: "route",
				reason: pool.strategy,
				from: source ? source.id : `${options.provider}/${options.model}`,
				to: candidate.id
			};
			return routed;
		},

		/** Wrap one downstream stream for outcome scanning; untracked streams pass through. */
		scoringWrap(options, stream) {
			if (options?.__deveraiNoRoute === true) return stream; // probe records its own outcome
			const record = records.get(options);
			const entry = entryFor(options?.provider, options?.model);
			if (!record && !entry) return stream;
			const id = record ? record.id : entry.id;
			const started = record ? record.start : now();
			let settled = false;
			const settle = (ok) => {
				if (settled) return;
				settled = true;
				recordOutcome(id, ok, now() - started);
			};
			const scan = async function* () {
				try {
					for await (const chunk of stream) {
						if (chunk && chunk.type === "finish") {
							const kind = chunk.reason?.kind;
							settle(kind !== "error" && kind !== "aborted");
						}
						yield chunk;
					}
					settle(true); // ended without a terminal chunk: treat as success
				} finally {
					settle(false); // consumer abort / early close counts against stability
					// Propagate cancellation so the adapter stream is not left running.
					if (typeof stream.return === "function") {
						try { await stream.return(undefined); } catch { /* already closed */ }
					}
				}
			};
			return scan();
		},

		get snapshot() {
			return {
				active: state.gateActive && pool.enabled,
				gateActive: state.gateActive,
				enabled: pool.enabled,
				strategy: pool.strategy,
				lastDecision,
				models: pool.models.map((m) => {
					const stats = statsFor(m.id);
					return {
						id: m.id,
						provider: m.provider,
						model: m.model,
						priority: m.priority,
						enabled: m.enabled !== false,
						score: Number(scoreOf(m.id).toFixed(3)),
						window: stats.window.slice(-WINDOW_SIZE),
						lastMs: stats.lastMs ?? null,
						lastOkAt: stats.lastOkAt ?? null,
						lastFailAt: stats.lastFailAt ?? null,
						cooling: (stats.coolUntil ?? 0) > now()
					};
				})
			};
		},

		async updateConfig(patch) {
			pool = mergePool(pool, patch);
			await atomicWriteText(poolFile, JSON.stringify(pool, null, 2));
			return clonePool(pool);
		},

		async probe(llm, id) {
			const entry = pool.models.find((m) => m.id === id);
			if (!entry) throw httpError(404, "not-found", `未知模型: ${id}`);
			const started = now();
			let kind = "none";
			try {
				const stream = llm.stream({
					provider: entry.provider,
					model: entry.model,
					messages: [{ role: "user", content: "ping" }],
					signal: AbortSignal.timeout(15_000),
					__deveraiNoRoute: true
				});
				for await (const chunk of stream) {
					if (chunk && chunk.type === "finish") {
						kind = chunk.reason?.kind ?? "none";
						break;
					}
				}
				// Drain/close hygiene when we broke out early.
				if (typeof stream.return === "function") {
					try { await stream.return(undefined); } catch { /* already closed */ }
				}
			} catch (error) {
				kind = `throw:${error?.code ?? "error"}`;
			}
			const ok = kind === "stop";
			recordOutcome(entry.id, ok, now() - started);
			await flushScores();
			return { id: entry.id, kind, ms: now() - started };
		},

		loadState,
		flushScores,
		dispose() {
			if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
		},
		/** Test seam: override the default-selection reader. */
		setDefaultsReader(reader) { currentDefaults = reader; },
		get poolRef() { return pool; },
		// DSH model registry integration: discover providers/models and merge
		// them into the routing pool.
		discoverModels,
		mergeDiscovered,
		get discoveredModelsRef() { return discoveredModels; },
	};
	return state;
}

/**
 * Build the HTTP route table for the /router prefix. Mirrors the hub's
 * dispatch shape so both endpoints feel identical to clients.
 */
export function buildRouterRoutes(router, getService) {
	const routes = [
		{ method: "GET", pattern: /^\/$/, handler: async () => router.snapshot },
		{ method: "GET", pattern: /^\/state$/, handler: async () => router.snapshot },
		{ method: "POST", pattern: /^\/config$/, handler: async (body) => router.updateConfig(body ?? {}) },
		{ method: "POST", pattern: /^\/probe$/, handler: async (body) => {
			if (typeof body?.id !== "string" || !body.id) throw httpError(400, "bad-id", "缺少模型 id");
			const llm = getService("llm");
			if (llm === undefined) throw httpError(503, "no-llm", "llm 服务不可用");
			return router.probe(llm, body.id);
		} }
	];
	async function dispatch(method, pathname, body) {
		// pathname arrives PREFIX-STRIPPED from the webServer handler (same
		// convention as the hub route table): "/state", "/config", "/probe".
		const suffix = pathname || "/";
		for (const route of routes) {
			if (route.method !== method) continue;
			if (route.pattern.test(suffix)) return await route.handler(body);
		}
		throw httpError(404, "not-found", `未知路由: ${method} ${pathname}`);
	}
	return { routes, dispatch };
}

export const name = PLUGIN_NAME;
// Service-scoped access must be DECLARED: "llm/stream" listeners attach via
// the LlmRuntime service, and webServer/agentDefaultModel are likewise
// invisible to ctx.get without declaration (hub does the same for webServer).
export const inject = ["llm", "webServer", "agentDefaultModel"];

export function apply(ctx) {
	const gateActive = process.env.DEVERAI_ROUTER === "1";
	// Pass DSH's llm service so the router can discover models from the
	// harness's registered providers (not just the current default).
	const router = createRouter({ llm: ctx.llm });
	router.gateActive = gateActive;

	// Listener registration must happen synchronously inside apply() — the
	// shipped packages (session-title, session-checkpoint-policy) do exactly
	// this. Registering after the plugin settles poisons the fiber.
	if (gateActive) {
		const defaultsService = ctx.agentDefaultModel;
		router.setDefaultsReader(
			typeof defaultsService?.currentSelection === "function"
				? () => defaultsService.currentSelection()
				: null
		);
		globalThis.__deveraiRouteHook = (options) => router.decide(options);
		ctx.on("llm/stream", (options, next) => router.scoringWrap(options, next()), { global: true });
	} else {
		// Even when routing is gated off, seed the pool from DSH's registry so
		// the Router tab can show all available models.
		ctx.effect(() => { void router.loadState(); return () => {}; });
	}

	ctx.effect(() => {
		void router.loadState();
		return () => {
			if (globalThis.__deveraiRouteHook) delete globalThis.__deveraiRouteHook;
			router.dispose();
		};
	});

	const webServer = ctx.webServer;
	if (webServer !== undefined && typeof webServer.register === "function") {
		const { dispatch } = buildRouterRoutes(router, (key) => ctx.get(key));
		async function handler(req, res) {
			const url = new URL(req.url ?? "/", "http://loopback");
			let sub = url.pathname.startsWith(ROUTE_PREFIX) ? url.pathname.slice(ROUTE_PREFIX.length) : url.pathname;
			sub = (sub || "/").replace(/\/+$/, "") || "/";
			const method = (req.method ?? "GET").toUpperCase();
			try {
				const body = method === "GET" ? {} : await readBody(req, BODY_LIMIT);
				const data = await dispatch(method, sub, body);
				sendJson(res, 200, { ok: true, data });
			} catch (error) {
				const status = Number(error?.status) || 500;
				const code = String(error?.code ?? "internal");
				const message = String(error?.message ?? "内部错误");
				if (status >= 500) console.error(`[${PLUGIN_NAME}] ${method} ${sub} failed:`, message);
				sendJson(res, status, { ok: false, error: { code, message } });
			}
		}
		ctx.effect(() => webServer.register({ kind: "prefix", path: ROUTE_PREFIX, handler }));
	}

	// RPC handlers (harness.handle / host.call) — idiomatic DSH host↔client RPC.
	const rpcHandlers = [];
	const rpc = (method, fn) => {
		const disposer = ctx.harness.handle(`deverai-router.${method}`, (args) => fn(args ?? {}));
		rpcHandlers.push(disposer);
	};
	rpc("state", async () => router.snapshot);
	rpc("config", async (args) => router.updateConfig(args));
	rpc("probe", async (args) => router.probeModel(args?.id));
	rpc("discover", async () => router.discoverModels());
	ctx.effect(() => () => { for (const d of rpcHandlers) { try { d(); } catch { /* ignore */ } } });
}

export default { name, inject, apply };
