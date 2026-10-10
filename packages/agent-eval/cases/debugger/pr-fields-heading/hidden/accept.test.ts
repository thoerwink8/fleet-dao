// 藏起来的验收（#66 合进去的修法补的两条，加几条别修坏了的）：判分时拷到快照根上，用 node --test 跑。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMd } from './packages/conventions/src/markdown.ts';
import { planPhases } from './packages/conventions/src/plan.ts';
import { checkPrFields, prColumns } from './packages/conventions/src/pr-fields.ts';

const PLAN = [
  '# 计划',
  '',
  '## 三、分阶段',
  '',
  '### P1 核心闭环（约 12 小时）',
  '',
  '- 工作流：需求、子任务。',
  '',
].join('\n');
const SPECS = new Set(['specs', 'specs/12-登录验证码', 'specs/12-登录验证码/需求.md']);
const repo = { phases: planPhases(parseMd('docs/plan.md', PLAN)), exists: (p: string) => SPECS.has(p) };
const check = (body: string) => checkPrFields({ labels: ['需求'], milestone: 'P1 核心闭环', body }, repo);

test('栏写在正文开头、后面分了小标题：小标题截断上一栏，各节里提到的 specs 路径不当成 specs 这一栏', () => {
  const text = [
    '对应计划：P1「工作流」',
    'specs：specs/12-登录验证码/',
    '',
    '## 改了什么',
    '- `specs/99-别的/需求.md`：顺带提一句',
  ].join('\n');
  assert.equal(prColumns(text).get('specs'), 'specs/12-登录验证码/');
  assert.deepEqual(check(text), []);
});

test('小标题之后的栏照样认得出', () => {
  const text = [
    '## 说明',
    '**对应计划**：P1「工作流」',
    '',
    '### 细节',
    '**specs**：specs/12-登录验证码/',
  ].join('\n');
  assert.equal(prColumns(text).get('specs'), 'specs/12-登录验证码/');
  assert.equal(prColumns(text).get('对应计划'), 'P1「工作流」');
  assert.deepEqual(check(text), []);
});

test('specs 路径后面紧跟全角冒号、句号：只取路径', () => {
  for (const specs of ['`specs/12-登录验证码/需求.md`：照 #12 抄。', 'specs/12-登录验证码/。']) {
    assert.deepEqual(check(`**对应计划**：P1「工作流」\n**specs**：${specs}`), [], specs);
  }
});

test('别修坏了：写错的 specs 目录照样报、不适用照样放过、一栏里多行照样收进来', () => {
  const missing = check('**对应计划**：P1「工作流」\n**specs**：specs/99-没有这个/');
  assert.equal(missing.length, 1);
  assert.match(missing[0] ?? '', /specs\/99-没有这个/);
  assert.deepEqual(check('**对应计划**：P1「工作流」\n**specs**：不适用'), []);
  const multi = prColumns('**做了什么**：\n- 加了验证码\n- 改了登录页\n**specs**：不适用');
  assert.equal(multi.get('做了什么'), '- 加了验证码\n- 改了登录页');
});
