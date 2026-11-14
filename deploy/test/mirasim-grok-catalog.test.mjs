// 本机 grok 清单：探测失败要明说，`grok models` 列出来的模型走 route local。
// 跑法：node --test deploy/test/mirasim-grok-catalog.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const catalog = require('../lib/mirasim-grok-catalog.cjs');

const SAMPLE = `You are logged in with grok.com.

Default model: grok-4.7

Available models:
  * grok-4.7 (default)
  - grok-4.7-build-fast
  - grok-4.6
  - grok-4.5
`;

const SERVER_FIXTURE = [
  "if(_0x234cc1==='grok'){let _0xf41fcf=P_t();if(_0xf41fcf?.['length'])return _0xf41fcf;}return d1[_0x234cc1]?.['models']??[];",
  "if(_0x43fb30['agent']==='grok'){let _0x42ffff=jzn(!!_0x43fb30['refresh']);(_0x43fb30['refresh']||!P_t())&&await _0x42ffff;}let _0xbd6faf=await this['host']['getCatalog'](_0x43fb30['agent']);_0xb4d682['client']['send']({'type':'catalog','agent':_0x43fb30['agent'],..._0xbd6faf});",
  "function ED(_0x1ccb74,_0x4299e1){if(!_0x1ccb74)return!(1);let _0x3b8862=_0x1ccb74['trim']();return Xmr['some'](_0x5e1dc3=>_0x5e1dc3['id']===_0x3b8862)?!_0x4299e1||!_Jn(_0x4299e1,_0x3b8862):!(1);}",
  "async['compute'](_0x10973c,_0x1e2737,_0x1edeef,_0x7c5684){let _0x3ee691=fu(_0x10973c),_0x544f52=ED(_0x1edeef,_0x10973c),",
].join('\n');

test('grok models 的 Available models 收成模型串，默认型号留着', () => {
  const parsed = catalog.parseGrokModels(SAMPLE);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.models, ['grok-4.7', 'grok-4.7-build-fast', 'grok-4.6', 'grok-4.5']);
  assert.equal(parsed.defaultModel, 'grok-4.7');
});

test('没有 Available models、空输出，都是没读成', () => {
  assert.equal(catalog.parseGrokModels('').ok, false);
  assert.match(catalog.parseGrokModels('You are logged in.\n').message, /Available models/);
  assert.match(catalog.parseGrokModels('not logged in\n').message, /没登录/);
});

test('退出码不是 0 时，输出里有模型也不收成清单', () => {
  const got = catalog.interpretGrokModelsRun({ status: 1, stdout: SAMPLE, stderr: '' });
  assert.equal(got.ok, false);
  assert.match(got.message, /退出 1/);
});

test('探测失败清掉上一份成功，不把旧名单继续当本机清单', async () => {
  let mode = 'ok';
  let calls = 0;
  const box = catalog.createGrokCatalog({
    ttlMs: 60_000,
    now: () => 1_000,
    run: async () => {
      calls += 1;
      if (mode === 'ok') {
        return { ok: true, models: ['grok-4.7', 'grok-4.5'], defaultModel: 'grok-4.7' };
      }
      return { ok: false, message: 'grok models 超时' };
    },
  });
  await box.refresh(true);
  assert.equal(box.isLocal('grok', 'grok-4.7'), true);
  mode = 'fail';
  const failed = await box.refresh(true);
  assert.equal(failed.ok, false);
  assert.deepEqual(box.nativeModels(), []);
  assert.equal(box.isLocal('grok', 'grok-4.7'), false);
  assert.equal(box.isLocal('grok', 'grok-4.5'), false);
  const frame = box.present('grok', {
    models: [{ id: 'grok-4.7', tier: 'builtin' }, { id: 'grok-4.5' }],
    routeByModel: { 'grok-4.7': 'relay' },
    ownOnlyModels: ['grok-4.5'],
    defaultModel: 'grok-4.7',
  });
  assert.deepEqual(frame.models, []);
  assert.deepEqual(frame.routeByModel, {});
  assert.deepEqual(frame.ownOnlyModels, []);
  assert.equal(frame.defaultModel, null);
  assert.match(frame.probeError, /超时/);
  assert.match(frame.probeError, /不拿平台清单当本机清单/);
  assert.equal(calls, 2);
});

test('refresh 为假时复用还没过期的成功；过期或强制才再跑。失败不会并进上一次还在飞的成功', async () => {
  let now = 0;
  let calls = 0;
  const box = catalog.createGrokCatalog({
    ttlMs: 100,
    now: () => now,
    run: async () => {
      calls += 1;
      return { ok: true, models: ['grok-4.7-build-fast'], defaultModel: 'grok-4.7-build-fast' };
    },
  });
  await box.refresh(true);
  await box.refresh(false);
  assert.equal(calls, 1);
  now = 101;
  await box.refresh(false);
  assert.equal(calls, 2);
  const pending = box.refresh(true);
  const joined = box.refresh(true);
  await Promise.all([pending, joined]);
  assert.equal(calls, 3);
});

test('列成功的模型帧标 local，不带 builtin，ownOnly 不再只剩残的那一个', async () => {
  const box = catalog.createGrokCatalog({
    run: async () => ({
      ok: true,
      models: ['grok-4.7', 'grok-4.7-build-fast', 'grok-4.6', 'grok-4.5'],
      defaultModel: 'grok-4.7',
    }),
  });
  await box.refresh(true);
  const frame = box.present('grok', {
    models: [{ id: 'grok-4.7', tier: 'builtin' }],
    routeByModel: { 'grok-4.7': 'relay' },
    ownOnlyModels: ['grok-4.5'],
  });
  assert.deepEqual(
    frame.models.map((row) => row.id),
    ['grok-4.7', 'grok-4.7-build-fast', 'grok-4.6', 'grok-4.5'],
  );
  assert.equal(
    frame.models.some((row) => row.tier === 'builtin'),
    false,
  );
  assert.equal(frame.routeByModel['grok-4.7'], 'local');
  assert.equal(frame.routeByModel['grok-4.7-build-fast'], 'local');
  assert.equal(frame.ownOnlyModels, undefined);
  assert.equal(frame.probeError, undefined);
  assert.equal(frame.defaultModel, 'grok-4.7');
  assert.equal(box.isLocal('grok', 'grok-4.7-build-fast'), true);
  assert.equal(box.isLocal('claude', 'grok-4.7'), false);
});

test('别的执行体的清单原样返回', async () => {
  const box = catalog.createGrokCatalog({
    run: async () => ({ ok: true, models: ['grok-4.7'] }),
  });
  await box.refresh(true);
  const body = { models: [{ id: 'claude-opus' }] };
  assert.deepEqual(box.present('claude', body).models, body.models);
});

test('补丁把探测、清单帧、只走平台、开会话四处置换成等 grok models', () => {
  const rewritten = catalog.rewriteServerSource(SERVER_FIXTURE);
  assert.deepEqual(rewritten.missed, []);
  assert.match(rewritten.code, /__mirasimGrokNativeModels\(\)/);
  assert.match(rewritten.code, /await global\.__mirasimRefreshGrokModels\(!!_0x43fb30\['refresh'\]\)/);
  assert.match(rewritten.code, /__mirasimPresentCatalog\(_0x43fb30\['agent'\]/);
  assert.match(rewritten.code, /__mirasimGrokIsLocal\(_0x4299e1,_0x3b8862\)\)return !\(1\)/);
  assert.match(rewritten.code, /if\(_0x10973c==='grok'\)\{await global\.__mirasimRefreshGrokModels\(false\);\}/);
  assert.doesNotMatch(rewritten.code, /P_t\(\)/);

  const Xmr = [
    { id: 'grok-4.7', tier: 'builtin' },
    { id: 'grok-4.7-build-fast', tier: 'builtin' },
    { id: 'grok-platform-only', tier: 'builtin' },
  ];
  const _Jn = () => false;
  global.__mirasimGrokIsLocal = (agent, id) =>
    agent === 'grok' && (id === 'grok-4.7' || id === 'grok-4.7-build-fast');
  const line = rewritten.code.split('\n').find((row) => row.startsWith('function ED('));
  const ED = new Function('Xmr', '_Jn', `${line}\nreturn ED;`)(Xmr, _Jn);
  assert.equal(ED('grok-4.7', 'grok'), false);
  assert.equal(ED('grok-4.7-build-fast', 'grok'), false);
  assert.equal(ED('grok-platform-only', 'grok'), true);
});

test('守卫 --require 之后清单函数在，服务端补丁钩子不影响别的异常退出', () => {
  const guard = join(import.meta.dirname, '../lib/mirasim-stream-guard.cjs');
  const ok = spawnSync(
    process.execPath,
    ['--require', guard, '-e', 'if (typeof global.__mirasimPresentCatalog!=="function") process.exit(2)'],
    { encoding: 'utf8' },
  );
  assert.equal(ok.status, 0, ok.stderr);
  const boom = spawnSync(process.execPath, ['--require', guard, '-e', 'throw new Error("boom-not-stream")'], {
    encoding: 'utf8',
  });
  assert.equal(boom.status, 1);
  assert.match(boom.stderr, /boom-not-stream/);
});

test('本机装着的 server.cjs 四处都能对上（没有这份文件就跳过）', () => {
  const file = join(process.env.HOME || homedir(), '.mirasim-remote/current/server.cjs');
  if (!existsSync(file)) return;
  const rewritten = catalog.rewriteServerSource(readFileSync(file, 'utf8'));
  assert.deepEqual(rewritten.missed, [], rewritten.missed.join('、'));
});
