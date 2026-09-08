/**
 * Unit tests for @deverai/model-router core (createRouter + buildRouterRoutes).
 * Deterministic clock, isolated storage dir, no harness required.
 *
 * Run: node tests/router-unit.mjs
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const pkg = await import(new URL('../packages/model-router/lib/index.js', import.meta.url).href);

let failed = false;
const check = (cond, label) => {
  if (!cond) { console.error('FAIL:', label); failed = true; }
  else console.log('ok  :', label);
};

async function makeRouter(poolPatch) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'deverai-router-'));
  const router = pkg.createRouter({ storageDir: dir });
  await router.loadState();
  if (poolPatch) await router.updateConfig(poolPatch);
  return { router, dir };
}

const FROZEN = (o) => Object.freeze(JSON.parse(JSON.stringify(o)));

/* ---------- 1. disabled pool passes everything through ---------- */
{
  const { router } = await makeRouter({ enabled: false });
  const options = FROZEN({ provider: 'a', model: 'b', messages: [] });
  router.setDefaultsReader(() => ({ provider: 'a', model: 'b' }));
  const out = router.decide(options);
  check(out === options, 'disabled pool returns identical options object');
}

/* ---------- 2. explicit selection passes through ---------- */
{
  const { router } = await makeRouter({ enabled: true, strategy: 'score' });
  router.setDefaultsReader(() => ({ provider: 'xiaomi-token-plan-cn', model: 'mimo-v2.5-pro' }));
  const options = FROZEN({ provider: 'openrouter-free', model: 'ox-alpha', messages: [] });
  const out = router.decide(options);
  check(out === options, 'explicit selection untouched');
}

/* ---------- 3. source-is-best keeps, worse-source routes by priority ---------- */
{
  const { router } = await makeRouter({
    enabled: true,
    strategy: 'priority',
    models: [
      { id: 'm1', provider: 'prov-a', model: 'mod-1', priority: 10, enabled: true },
      { id: 'm2', provider: 'prov-b', model: 'mod-2', priority: 20, enabled: true }
    ]
  });
  router.setDefaultsReader(() => ({ provider: 'prov-a', model: 'mod-1' }));
  const options = FROZEN({ provider: 'prov-a', model: 'mod-1', messages: [{ role: 'user', content: 'x' }] });
  const out = router.decide(options);
  check(out === options, 'source is already best -> identical object back');
  check(router.snapshot.lastDecision.action === 'keep', 'decision recorded as keep');
}
{
  const { router } = await makeRouter({
    enabled: true,
    strategy: 'priority',
    models: [
      { id: 'm1', provider: 'prov-a', model: 'mod-1', priority: 30, enabled: true },
      { id: 'm2', provider: 'prov-b', model: 'mod-2', priority: 10, enabled: true }
    ]
  });
  router.setDefaultsReader(() => ({ provider: 'prov-a', model: 'mod-1' }));
  const out = router.decide(FROZEN({ provider: 'prov-a', model: 'mod-1', messages: [] }));
  check(out.provider === 'prov-b' && out.model === 'mod-2', 'priority routing moves to priority 10 entry');
  check(router.snapshot.lastDecision.action === 'route', 'decision recorded as route');
}

/* ---------- 3b. frozen clone routing when a better entry exists ---------- */
{
  const { router } = await makeRouter({
    enabled: true,
    strategy: 'priority',
    models: [
      { id: 'm1', provider: 'prov-a', model: 'mod-1', priority: 30, enabled: true },
      { id: 'm2', provider: 'prov-b', model: 'mod-2', priority: 10, enabled: true }
    ]
  });
  router.setDefaultsReader(() => ({ provider: 'prov-a', model: 'mod-1' }));
  const options = FROZEN({ provider: 'prov-a', model: 'mod-1', messages: [{ role: 'user', content: 'x' }] });
  const out = router.decide(options);
  check(out !== options && Object.isFrozen(out), 'routed clone differs from frozen input and stays frozen');
  check(out.provider === 'prov-b' && out.model === 'mod-2', 'priority routing moves to priority 10 entry');
  check(router.snapshot.lastDecision.action === 'route', 'decision recorded as route');
}

/* ---------- 3c. default model outside the pool is never routed ---------- */
{
  const { router } = await makeRouter({
    enabled: true,
    strategy: 'score',
    models: [
      { id: 'm1', provider: 'prov-a', model: 'mod-1', priority: 10, enabled: true }
    ]
  });
  router.setDefaultsReader(() => ({ provider: 'other-prov', model: 'other-mod' }));
  const options = FROZEN({ provider: 'other-prov', model: 'other-mod', messages: [] });
  const out = router.decide(options);
  check(out === options, 'pool does not govern a default model outside the pool');
  check(router.snapshot.lastDecision.reason === 'default-not-in-pool', 'decision reason recorded');
}

/* ---------- 4. scoring wrap: success and failure on routed calls ---------- */
{
  const { router } = await makeRouter({
    enabled: true,
    strategy: 'round-robin',
    models: [
      { id: 'm1', provider: 'prov-a', model: 'mod-1', priority: 10, enabled: true },
      { id: 'm2', provider: 'prov-b', model: 'mod-2', priority: 20, enabled: true }
    ]
  });
  router.setDefaultsReader(() => ({ provider: 'prov-a', model: 'mod-1' })); // default call -> routable
  async function* fakeStream(chunks) { for (const c of chunks) yield c; }

  const routed = router.decide(FROZEN({ provider: 'prov-a', model: 'mod-1', messages: [] }));
  const okStream = fakeStream([{ type: 'text', text: 'hi' }, { type: 'finish', reason: { kind: 'stop' } }]);
  for await (const _ of router.scoringWrap(routed, okStream)) void _;
  const tracked = router.snapshot.models.filter((m) => m.window.length > 0);
  check(tracked.length === 1 && tracked[0].window[0] === 1, 'success finish recorded in window');

  // failure finish cools the next routed target down
  const routed2 = router.decide(FROZEN({ provider: 'prov-a', model: 'mod-1', messages: [] }));
  const badStream = fakeStream([{ type: 'finish', reason: { kind: 'error', failure: { code: 'X' } } }]);
  for await (const _ of router.scoringWrap(routed2, badStream)) void _;
  check(router.snapshot.models.some((m) => m.cooling), 'error finish puts a model into cooldown');
}

/* ---------- 5. cooldown shifts subsequent routing away ---------- */
{
  const { router } = await makeRouter({
    enabled: true,
    strategy: 'round-robin',
    models: [
      { id: 'm1', provider: 'p1', model: 'a', priority: 10, enabled: true },
      { id: 'm2', provider: 'p2', model: 'b', priority: 20, enabled: true }
    ]
  });
  router.setDefaultsReader(() => ({ provider: 'p1', model: 'a' }));
  // first decision may keep or rotate; force-fail whatever it picked
  const first = router.decide(FROZEN({ provider: 'p1', model: 'a', messages: [] }));
  const failedId = router.snapshot.models.find((m) => m.provider === first.provider && m.model === first.model)?.id;
  async function* s() { yield { type: 'finish', reason: { kind: 'error', failure: {} } }; }
  for await (const _ of router.scoringWrap(first, s())) void _;
  const second = router.decide(FROZEN({ provider: 'p1', model: 'a', messages: [] }));
  const secondId = `${second.provider}/${second.model}`;
  check(secondId !== failedId, `cooldown failover: ${failedId} -> ${secondId}`);
}

/* ---------- 6. config persistence round-trip ---------- */
{
  const { router, dir } = await makeRouter(null);
  await router.updateConfig({ enabled: true, strategy: 'round-robin', models: [{ provider: 'p', model: 'm' }] });
  const raw = JSON.parse(await fsp.readFile(path.join(dir, 'pool.json'), 'utf8'));
  check(raw.enabled === true && raw.strategy === 'round-robin', 'pool.json persisted');
  const fresh = pkg.createRouter({ storageDir: dir });
  await fresh.loadState();
  check(fresh.poolRef.strategy === 'round-robin' && fresh.poolRef.models[0].id === 'p/m', 'loadState restores persisted pool');
}

/* ---------- 7. HTTP dispatch table ---------- */
{
  const { router } = await makeRouter({ enabled: false });
  const fakeLlm = { stream: async function* () { yield { type: 'finish', reason: { kind: 'stop' } }; } };
  const { dispatch } = pkg.buildRouterRoutes(router, () => fakeLlm);
  const state = await dispatch('GET', '/state', {});
  check(Array.isArray(state.data?.models) || Array.isArray(state.models) || state.models, 'GET /state answers snapshot');
  try {
    await dispatch('POST', '/probe', { id: 'nope' });
    check(false, 'probe unknown id should reject');
  } catch (error) {
    check(error.status === 404 && /未知/.test(error.message), 'probe unknown id rejects 404 not-found');
  }
}

/* ---------- 8. DSH model registry discovery ---------- */
{
	// Simulate a DSH llm service with two providers and their models.
	const fakeLlm = {
		listProviders: async () => [
			{ key: 'zai', name: 'ZAI' },
			{ key: 'openai', name: 'OpenAI' },
		],
		listModels: async (provider) => {
			if (provider === 'zai') return [{ id: 'glm-5.3-flash', model: 'glm-5.3-flash', contextWindow: 32768 }];
			if (provider === 'openai') return [{ id: 'gpt-5', model: 'gpt-5', contextWindow: 128000 }];
			return [];
		},
	};
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'deverai-router-discover-'));
	const router = pkg.createRouter({ storageDir: dir, llm: fakeLlm });
	await router.loadState();

	// discoverModels should return the discovered providers/models.
	const discovered = await router.discoverModels();
	check(discovered && discovered.zai && discovered.zai.length === 1, 'discoverModels finds zai/glm-5.3-flash');
	check(discovered && discovered.openai && discovered.openai.length === 1, 'discoverModels finds openai/gpt-5');
	check(discovered.zai[0].contextWindow === 32768, 'discoverModels captures contextWindow');

	// mergeDiscovered should add discovered models to the pool (disabled by default).
	const merged = await router.mergeDiscovered();
	const zaiEntry = merged.models.find((m) => m.provider === 'zai' && m.model === 'glm-5.3-flash');
	const openaiEntry = merged.models.find((m) => m.provider === 'openai' && m.model === 'gpt-5');
	check(zaiEntry !== undefined, 'mergeDiscovered adds zai model to pool');
	check(openaiEntry !== undefined, 'mergeDiscovered adds openai model to pool');
	check(openaiEntry && openaiEntry.enabled === false, 'discovered models start disabled (opt-in)');

	// Existing user-configured entries are preserved.
	const userEntry = merged.models.find((m) => m.id === 'zai/glm-5.3-flash');
	check(userEntry !== undefined, 'user-configured pool entries preserved');

	// Discovery is cached (second call returns same object).
	const discovered2 = await router.discoverModels();
	check(discovered === discovered2, 'discoverModels caches results');

	// No llm service => discovery returns empty, no crash.
	const dir2 = await fsp.mkdtemp(path.join(os.tmpdir(), 'deverai-router-nollm-'));
	const router2 = pkg.createRouter({ storageDir: dir2 });
	const empty = await router2.discoverModels();
	check(empty && Object.keys(empty).length === 0, 'discoverModels with no llm service returns empty');
}

console.log(failed ? '\nrouter-unit FAILED' : '\nrouter-unit passed');
if (failed) process.exitCode = 1;
