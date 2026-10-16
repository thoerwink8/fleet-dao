// 这一版要不要重启引擎、后端（#2797）：deploy/lib/runtime-closure.mjs 按文件级的引用闭包判。在临时 git 仓里造一个小号的
// monorepo（引擎经工作区包引 conventions 的一个文件、经 new URL 起 workflows 和会话钩子），逐种改动核对。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { decide, judge, NON_CODE, packageOf, SERVICES } from '../lib/runtime-closure.mjs';
import { runChild } from './child.mjs';

const repo = mkdtempSync(join(tmpdir(), 'runtime-closure-'));
test.after(() => rmSync(repo, { recursive: true, force: true }));

const git = (...args) => {
  const r = runChild('git', ['-C', repo, ...args]);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}：${r.stderr}`);
  return r.stdout.trim();
};
const put = (files) => {
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, p)), { recursive: true });
    writeFileSync(join(repo, p), body);
  }
};
const commit = (msg) => {
  git('add', '-A');
  git('commit', '-q', '-m', msg);
  return git('rev-parse', 'HEAD');
};
const pkg = (name, exportsMap) =>
  JSON.stringify({ name, type: 'module', ...(exportsMap ? { exports: exportsMap } : {}) });

git('init', '-q', '-b', 'main');
git('config', 'user.email', 't@example.com');
git('config', 'user.name', 't');
git('config', 'commit.gpgsign', 'false');
put({
  'package.json': JSON.stringify({ name: 'mono', private: true }),
  'pnpm-lock.yaml': 'lockfileVersion: 9\n',
  'packages/engine/package.json': pkg('@fleet-dao/engine', { '.': './src/main.ts' }),
  'packages/engine/src/main.ts':
    "import { used } from '@fleet-dao/conventions';\nimport { WORKFLOWS, HOOK } from './worker.ts';\nimport './gone.ts';\nconsole.log(used, WORKFLOWS, HOOK);\n",
  'packages/engine/src/worker.ts':
    "import { fileURLToPath } from 'node:url';\n// new URL('./not-this.ts', import.meta.url) 在注释里，不算\nexport const WORKFLOWS = fileURLToPath(new URL('./workflows/index.ts', import.meta.url));\nexport const HOOK = new URL('../../../agents/hooks/pretool.mjs', import.meta.url);\n",
  'packages/engine/src/workflows/index.ts': "export * from './task.ts';\n",
  'packages/engine/src/workflows/task.ts': 'export const task = 1;\n',
  'packages/engine/src/gone.ts': 'export const gone = 1;\n',
  'packages/engine/src/not-this.ts': 'export const no = 1;\n',
  'packages/engine/test/main.test.ts': 'export {};\n',
  'packages/conventions/package.json': pkg('@fleet-dao/conventions', { '.': './src/index.ts' }),
  'packages/conventions/src/index.ts': "export { used } from './used.ts';\n",
  'packages/conventions/src/used.ts': 'export const used = 1;\n',
  'packages/conventions/src/bin/local-cmd.ts': "import { used } from '../used.ts';\nconsole.log(used);\n",
  'packages/api/package.json': pkg('@fleet-dao/api', { '.': './src/main.ts' }),
  'packages/api/src/main.ts': "import { used } from '@fleet-dao/conventions';\nconsole.log(used);\n",
  'packages/db/migrations/0000_init.sql': 'create table a (id int);\n',
  'agents/hooks/pretool.mjs': "import { cap } from './capacity.mjs';\nconsole.log(cap);\n",
  'agents/hooks/capacity.mjs': 'export const cap = 1;\n',
  'agents/hooks/session-start.mjs': 'console.log(1);\n',
  '.github/workflows/ci.yml': 'on: push\n',
  'docs/ops.md': '# ops\n',
});
const BASE = commit('base');

/** 在 base 上改这些文件（null 删掉），回新提交号。 */
function change(files, from = BASE) {
  git('checkout', '-q', '--detach', from);
  for (const [p, body] of Object.entries(files)) {
    if (body === null) git('rm', '-q', p);
    else put({ [p]: body });
  }
  return commit('t');
}

const run = (newSha, service = 'engine', oldSha = BASE) => decide({ repo, oldSha, newSha, service });

test('改 agents/ 里引擎不用的钩子：不重启引擎', async () => {
  const r = await run(change({ 'agents/hooks/session-start.mjs': 'console.log(2);\n' }));
  assert.equal(r.restart, false, r.why);
});

test('改 conventions 里引擎不引用的本机命令：不重启', async () => {
  const r = await run(change({ 'packages/conventions/src/bin/local-cmd.ts': 'console.log(3);\n' }));
  assert.equal(r.restart, false, r.why);
});

test('改引擎经工作区包引用的 conventions 文件：要重启，原因写出是哪个文件', async () => {
  const r = await run(change({ 'packages/conventions/src/used.ts': 'export const used = 2;\n' }));
  assert.equal(r.restart, true);
  assert.match(r.why, /packages\/conventions\/src\/used\.ts/);
});

test('改锁文件、加迁移：要重启（非代码的运行输入）', async () => {
  const lock = await run(change({ 'pnpm-lock.yaml': 'lockfileVersion: 9\n# x\n' }));
  assert.equal(lock.restart, true);
  assert.match(lock.why, /非代码的运行输入：pnpm-lock\.yaml/);
  const mig = await run(change({ 'packages/db/migrations/0001_b.sql': 'create table b (id int);\n' }));
  assert.equal(mig.restart, true);
  assert.match(mig.why, /migrations/);
});

test('改 .github/、文档、测试：不重启', async () => {
  const r = await run(
    change({
      '.github/workflows/ci.yml': 'on: [push]\n',
      'docs/ops.md': '# ops 2\n',
      'packages/engine/test/main.test.ts': 'export const t = 1;\n',
    }),
  );
  assert.equal(r.restart, false, r.why);
});

test('按路径读的也算：new URL 起的 workflows、会话钩子和钩子 import 的文件改了要重启；注释里的 new URL 不算', async () => {
  for (const p of [
    'packages/engine/src/workflows/task.ts',
    'agents/hooks/pretool.mjs',
    'agents/hooks/capacity.mjs',
  ]) {
    const r = await run(change({ [p]: 'export const x = 9;\n' }));
    assert.equal(r.restart, true, p);
  }
  const comment = await run(change({ 'packages/engine/src/not-this.ts': 'export const no = 2;\n' }));
  assert.equal(comment.restart, false, comment.why);
});

test('删掉一个被引用的文件（新版不引它了）：旧版的闭包里有，照样要重启', async () => {
  const r = await run(
    change({
      'packages/engine/src/gone.ts': null,
      'packages/engine/src/main.ts':
        "import { used } from '@fleet-dao/conventions';\nimport { WORKFLOWS, HOOK } from './worker.ts';\nconsole.log(used, WORKFLOWS, HOOK);\n",
    }),
  );
  assert.equal(r.restart, true);
});

test('【故意造出的】认不出的动态 import：那个包整个算进去，改它里面引擎原本不引的文件也要重启', async () => {
  const dyn = change({
    'packages/conventions/src/used.ts':
      'export const used = 1;\nexport const load = (name) => import(name);\n',
  });
  const r = await run(
    change({ 'packages/conventions/src/bin/local-cmd.ts': 'console.log(4);\n' }, dyn),
    'engine',
    dyn,
  );
  assert.equal(r.restart, true);
  assert.match(r.why, /local-cmd\.ts/);
  // 字面量的 import('…') 认得出，不算
  const lit = change({
    'packages/conventions/src/used.ts':
      "export const used = 1;\nexport const load = () => import('./other.ts');\n",
    'packages/conventions/src/other.ts': 'export const o = 1;\n',
  });
  const r2 = await run(
    change({ 'packages/conventions/src/bin/local-cmd.ts': 'console.log(5);\n' }, lit),
    'engine',
    lit,
  );
  assert.equal(r2.restart, false, r2.why);
});

test('后端只看自己的闭包：改引擎独有的文件不重启后端；改它的单元要重启', async () => {
  const eng = await run(
    change({ 'packages/engine/src/workflows/task.ts': 'export const task = 2;\n' }),
    'api',
  );
  assert.equal(eng.restart, false, eng.why);
  const unit = await run(change({ 'deploy/france/fleet-api.service': '[Service]\n' }), 'api');
  assert.equal(unit.restart, true);
});

test('同一个提交、没有在用版本：当要重启（不拿判不了当没变）', async () => {
  assert.equal((await run(BASE)).restart, true);
  assert.equal((await decide({ repo, oldSha: '', newSha: BASE, service: 'engine' })).restart, true);
  await assert.rejects(decide({ repo, oldSha: BASE, newSha: 'f'.repeat(40), service: 'engine' }));
});

test('judge、packageOf、非代码清单', () => {
  assert.equal(packageOf('packages/conventions/src/a.ts'), 'packages/conventions/');
  assert.equal(packageOf('agents/hooks/a.mjs'), 'agents/');
  for (const p of [
    'package.json',
    'packages/db/package.json',
    'pnpm-lock.yaml',
    'packages/db/migrations/0001.sql',
    'deploy/catalog.json',
  ]) {
    assert.ok(
      NON_CODE.some((re) => re.test(p)),
      p,
    );
  }
  assert.ok(SERVICES.engine.units.includes('deploy/france/fleet-engine.service'));
  const c = { files: new Set(['a/b.ts']), prefixes: new Set(['agents/subagents/']) };
  assert.equal(judge(['agents/subagents/x.md'], c, 'engine').restart, true);
  assert.equal(judge(['deploy/france/fleet-engine.service'], c, 'engine').restart, true);
  assert.equal(judge(['deploy/france/fleet-engine.service'], c, 'api').restart, false);
  assert.equal(judge(['x/y.ts'], c, 'engine').restart, false);
});
