/**
 * Contract checks for the @deverai/hub client half.
 * Static analysis only (the real render test is the live page):
 *  - compiles as plain JavaScript (no TS/JSX)
 *  - module loader protocol shape
 *  - exports/inject contract
 *  - no emoji anywhere (Fact.md hard rule)
 *  - require surface limited to react
 *
 * Run: node tests/client-contract.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('../plugin/lib/client.js', import.meta.url));
const src = readFileSync(file, 'utf8');

let failed = false;
const check = (cond, label) => {
  if (!cond) { console.error('FAIL:', label); failed = true; }
  else console.log('ok  :', label);
};

// 1. Compiles as plain script (catches syntax errors and TS/JSX leftovers).
try {
  new Function(src);
  check(true, 'client source compiles as plain JavaScript');
} catch (error) {
  check(false, 'client source compiles: ' + error.message);
}

// 2. Module loader protocol (ignore leading comments).
const stripped = src.replace(/^\/\*[\s\S]*?\*\//, '').trimStart();
check(stripped.startsWith('window.__ModuleLoader__.load({'), 'starts with window.__ModuleLoader__.load(');
check(/id:\s*"@deverai\/hub"/.test(src), 'module id is "@deverai/hub"');
check(/return\s+module\.exports;\s*\n?\s*\}/.test(src), 'factory returns module.exports');

// 3. Export contract.
check(/exports\.name\s*=\s*PLUGIN_ID;/.test(src), 'exports.name set');
check(/exports\.inject\s*=\s*inject;/.test(src), 'exports.inject set');
check(/exports\.apply\s*=\s*apply;/.test(src), 'exports.apply set');
check(/const inject = \["slots", "timer"\];/.test(src), 'inject declares slots+timer');
check(/ctx\.get\("slots"\)/.test(src), 'slots accessed through ctx.get');
check(/slots\.inject\(\s*"sidebar\.footer\.action"/.test(src), 'registers sidebar.footer.action');
check(/slots\.inject\(\s*"shell\.overlay"/.test(src), 'registers shell.overlay');
check(/slots\.inject\(\s*"settings\.section"/.test(src), 'registers settings.section');
for (const slot of ['sidebar.brand', 'conversation.session', 'sidebar', 'root']) {
  check(!src.includes(`"${slot}"`) && !src.includes(`'${slot}'`), `does not touch shipped slot ${slot}`);
}

// 4. React usage without JSX.
check(/const h = React\.createElement;/.test(src), 'uses React.createElement alias');
check(!/<\/[a-zA-Z]/.test(src), 'no closing-JSX fragments');
check(!/<(div|span|button|aside|nav|header|pre|input|select|label|h3|code|section)[\s>/]/.test(src), 'no raw JSX open tags');

// 5. TypeScript artifacts.
check(!/:\s*(string|number|boolean|void|any)(\[\])?\s*[=,)]/.test(src.replace(/https?:\/\/[^\s"']*/g, '')), 'no obvious TS annotations');
check(!/\bas\s+(const|any|string|number)\b/.test(src), 'no `as` casts');
check(!/\b(interface|implements)\s+[A-Z]/.test(src), 'no interface/implements declarations');

// 6. Emoji ban (Fact.md): scan the whole file for emoji-range code points.
const emojiRanges = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/u;
check(!emojiRanges.test(src), 'no emoji anywhere');

// 7. require surface.
const requires = [...src.matchAll(/require\(([^)]+)\)/g)].map((match) => match[1].trim());
check(requires.every((arg) => arg === '"react"'), `require limited to react (found: ${requires.join(', ') || 'none'})`);

// 8. Fetch goes through the single api() wrapper against /hub.
check(/async function api\(method, endpoint, body\)/.test(src), 'single api() transport wrapper');
check(!/fetch\((?!"|`\/hub)/.test(src.replace(/await fetch\(API_BASE \+ endpoint/g, '')), 'no stray fetch calls bypassing api()');

// 9. Components must be used as ELEMENTS, never called directly.
//    Direct calls inline their hooks into the parent's hook list; when the
//    parent mounts/unmounts that branch the hook count changes and React
//    throws #310 ("rendered more hooks than during the previous render"),
//    taking the whole dock down. Regression for the dead-terminal bug.
const components = [
  'SummaryTab', 'TerminalTab', 'FilesTab', 'WorktreeTab', 'RouterTab',
  'FilePreviewModal', 'ConfirmDialog', 'ErrorBanner', 'SectionCard',
  'HubSettingsPage', 'WorkbenchDock', 'HubToggleEntry',
];
for (const name of components) {
  const direct = new RegExp(`(?<!function )\\b${name}\\s*\\(`);
  check(!direct.test(src), `component ${name} is never called directly (use h(${name}, ...))`);
}
// routerApi must exist for the Router tab transport.
check(/async function routerApi\(method, endpoint, body\)/.test(src), 'routerApi transport present');

console.log(failed ? '\ncontract FAILED' : '\ncontract passed');
if (failed) process.exitCode = 1;
