// 藏起来的验收（#669 合进去的样子）：判分时拷到快照根上，用 node --test 跑。
// 第 3 条就是当时 CI（web、test rest）红的那条 demo-renames.test.ts，换成 node:test 照抄判法。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { HARD_BANS } from './packages/shared/src/bans.ts';
import { demoRenamed } from './packages/web/src/build/demo-renames.ts';
import { BUILTIN_TERMS } from './packages/web/src/build/scan.ts';

const OLD = '出比 5.1 更高的版本';
const fable = HARD_BANS.find((b) => b.id === 'no-fable');
const gpt = HARD_BANS.find((b) => b.id === 'gpt-no-ui');

test('Fable 禁令改成永久：理由里不再挂版本号；GPT 那条不动', () => {
  assert.ok(fable, 'no-fable 这条禁令不见了');
  assert.doesNotMatch(fable.reason, /5\.1|版本/);
  assert.match(fable.reason, /Fable/);
  assert.equal(gpt?.reason, 'GPT 不做 UI 类活');
});

test('每条全局禁令的理由都换成了样例说法：改了 shared/bans.ts 的原话、demo-renames 这张表没跟上就红', () => {
  const flagged = (text: string) => BUILTIN_TERMS.filter((t) => text.toLowerCase().includes(t.toLowerCase()));
  for (const ban of HARD_BANS) {
    const renamed = demoRenamed(ban.reason);
    assert.notEqual(renamed, ban.reason, ban.id);
    assert.deepEqual(flagged(renamed), [], ban.id);
  }
});

test('钉住禁令文案的测试跟上新理由（fable51、fable52 两行）', () => {
  const src = readFileSync('packages/db/test/candidates.test.ts', 'utf8');
  assert.ok(!src.includes(OLD), 'candidates.test.ts 里还写着旧理由');
  for (const route of ['fable51', 'fable52']) {
    const line = src.split('\n').find((l) => l.includes(`['${route}', ['banned']`));
    assert.ok(line?.includes(`'${fable?.reason}'`), `${route} 那行没跟上新理由：${line}`);
  }
});

test('通用段那句不再挂版本号', () => {
  const md = readFileSync('AGENTS.md', 'utf8');
  assert.ok(!md.includes(OLD), 'AGENTS.md 里还写着「出比 5.1 更高的版本」');
  assert.match(md, /Fable/, 'AGENTS.md 里 Fable 那句整个没了');
});
