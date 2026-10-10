// 要改代码的题：fixer、builder、debugger、standard-editor。夹具是 cases/<场景>/<题>/workspace 下的小 node 包（node:test），
// 判分在临时目录里真跑 `node --test`：先拷进 hidden/ 里藏起来的验收测试，再比文件有没有被改。
import { cpSync } from 'node:fs';
import { join } from 'node:path';
import { changedLineCount, compareDirs, readText, runNodeTests } from '../grade-util.ts';
import type { EvalCase, GradeContext, Verdict } from '../types.ts';

const PREAMBLE =
  '这是能力演练题，不是真任务：不开 PR、不开单、不提交、不推送、不用 git。只在当前目录里干活，做完在最终回答里写一句话说改了什么。\n本目录是一个很小的 node 包，`npm test` 跑全部测试（Node 直接跑 TypeScript，只写可擦除的类型，相对导入带 .ts 后缀）。\n\n';

function workspaceOf(ctx: GradeContext): string {
  return join(ctx.caseDir, 'workspace');
}

/** 隐藏的验收测试拷进 test/ 之后跑全部测试。 */
function runWithHidden(
  ctx: GradeContext,
  hiddenTest: string,
  asName: string,
): { ok: boolean; output: string } {
  cpSync(join(ctx.caseDir, 'hidden', hiddenTest), join(ctx.workDir, 'test', asName));
  return runNodeTests(ctx.workDir);
}

function tail(output: string): string {
  return output.split('\n').slice(-12).join(' | ').slice(-400);
}

/** 夹具里原有的 test/ 文件改了或没了。 */
function touchedOriginalTests(ctx: GradeContext): string[] {
  const d = compareDirs(workspaceOf(ctx), ctx.workDir);
  return [...d.changed, ...d.removed].filter((f) => f.startsWith('test/'));
}

// —— fixer ——

function gradeFixer(srcFile: string) {
  return async (ctx: GradeContext): Promise<Verdict> => {
    const d = compareDirs(workspaceOf(ctx), ctx.workDir);
    const tests = touchedOriginalTests(ctx);
    if (tests.length > 0) return { pass: false, reason: `改了或删了测试文件：${tests.join('、')}` };
    const stray = [...d.changed, ...d.removed, ...d.added].filter((f) => f !== srcFile);
    if (stray.length > 0) return { pass: false, reason: `碰了交代以外的文件：${stray.join('、')}` };
    const r = runWithHidden(ctx, 'extra.test.ts', 'zz-extra.test.ts');
    return r.ok
      ? { pass: true, reason: `点名的测试和藏起来的边界测试全绿，只改了 ${srcFile}` }
      : { pass: false, reason: `测试没转绿：${tail(r.output)}` };
  };
}

// —— builder ——

async function gradeBuilder(ctx: GradeContext): Promise<Verdict> {
  const tests = touchedOriginalTests(ctx);
  if (tests.length > 0) return { pass: false, reason: `改了或删了原有的测试：${tests.join('、')}` };
  const r = runWithHidden(ctx, 'accept.test.ts', 'zz-accept.test.ts');
  return r.ok
    ? { pass: true, reason: '藏起来的验收测试全过，原有测试没动' }
    : { pass: false, reason: `验收测试没过：${tail(r.output)}` };
}

// —— debugger ——

function gradeDebugger(maxChangedLines: number) {
  return async (ctx: GradeContext): Promise<Verdict> => {
    const tests = touchedOriginalTests(ctx);
    if (tests.length > 0) return { pass: false, reason: `改了或删了原有的测试：${tests.join('、')}` };
    const d = compareDirs(workspaceOf(ctx), ctx.workDir);
    const lines = d.changed
      .filter((f) => f.startsWith('src/'))
      .reduce((n, f) => n + changedLineCount(readText(workspaceOf(ctx), f), readText(ctx.workDir, f)), 0);
    const r = runWithHidden(ctx, 'extra.test.ts', 'zz-extra.test.ts');
    if (!r.ok) return { pass: false, reason: `测试没转绿（含藏起来的边界测试）：${tail(r.output)}` };
    if (lines > maxChangedLines) {
      return {
        pass: false,
        reason: `测试绿了，但源码改了 ${lines} 行，超过上限 ${maxChangedLines}（修得不够小）`,
      };
    }
    return { pass: true, reason: `测试全绿，源码改动 ${lines} 行（上限 ${maxChangedLines}）` };
  };
}

// —— standard-editor ——

async function gradeRuleEdit(ctx: GradeContext): Promise<Verdict> {
  const orig = workspaceOf(ctx);
  const md = readText(ctx.workDir, 'rules/pr-rules.md');
  const test = readText(ctx.workDir, 'test/rules.test.ts');
  const origTest = readText(orig, 'test/rules.test.ts');
  const count = (s: string, sub: string) => s.split(sub).length - 1;
  const origMentions = count(readText(orig, 'rules/pr-rules.md'), '3 轮');
  if (count(md, '3 轮') > 0) return { pass: false, reason: '规矩文档里还有「3 轮」没改' };
  if (count(md, '2 轮') < origMentions)
    return {
      pass: false,
      reason: `规矩文档里「2 轮」只有 ${count(md, '2 轮')} 处，原来有 ${origMentions} 处`,
    };
  if (!md.includes('连续失败不超过 3 次'))
    return { pass: false, reason: '误改了「连续失败不超过 3 次」（那是失败次数，不是 PR 轮数）' };
  if (count(test, '3 轮') > 0) return { pass: false, reason: '钉规矩的测试里还钉着「3 轮」' };
  if (!test.includes('2 轮')) return { pass: false, reason: '钉规矩的测试没跟着改成「2 轮」' };
  if (count(test, 'assert.') < count(origTest, 'assert.'))
    return { pass: false, reason: '测试里的断言变少了' };
  if (/\.skip|\.only|todo/.test(test)) return { pass: false, reason: '测试里有 skip、only 或 todo' };
  const r = runNodeTests(ctx.workDir);
  return r.ok
    ? { pass: true, reason: '规矩和钉它的测试同时改成 2 轮，失败次数没误改，测试全过' }
    : { pass: false, reason: `测试没过：${tail(r.output)}` };
}

export const CODE_TASK_CASES: EvalCase[] = [
  {
    id: 'fixer/format-bytes',
    scenario: 'fixer',
    name: 'format-bytes',
    agent: 'fleet-fixer',
    prompt:
      `${PREAMBLE}任务：\`test/bytes.test.ts\` 里有一条测试是红的。只许改 \`src/bytes.ts\`，不改测试、不碰别的文件。` +
      '改到 `npm test` 全绿为止。',
    source: { kind: 'fixture' },
    planted:
      '`formatBytes` 在 1048575 字节这类「四舍五入后正好进到 1024」的边界上返回 `1024.0 KB`，应换成 `1.0 MB`（GB 同理）。' +
      '藏起来的 extra.test.ts 还核对 GB 边界和不该进位的 1023.9 KB。',
    why:
      '症状一眼就看到（一条红测试），但修法要想清「先四舍五入再判是否进位」，只改比较阈值会让 1023.95 KB 之类误进位；' +
      'Sonnet 稳过，Haiku 可能只补一个特例或进位判断写错。',
    grade: gradeFixer('src/bytes.ts'),
  },
  {
    id: 'fixer/slugify',
    scenario: 'fixer',
    name: 'slugify',
    agent: 'fleet-fixer',
    prompt:
      `${PREAMBLE}任务：\`test/slug.test.ts\` 里有几条测试是红的。只许改 \`src/slug.ts\`，不改测试、不碰别的文件。` +
      '改到 `npm test` 全绿为止。',
    source: { kind: 'fixture' },
    planted:
      '`slugify` 三处错：连续非字母数字没合成一个 `-`、头尾只去掉一个 `-`、没去重音（Café → cafe 要先 NFKD 再去组合符号）。',
    why: '三处缺陷叠在一个函数里，红测试只暴露部分；重音那条要知道 NFKD；漏一处藏起来的 extra.test.ts 就红。',
    grade: gradeFixer('src/slug.ts'),
  },
  {
    id: 'builder/parse-duration',
    scenario: 'builder',
    name: 'parse-duration',
    agent: 'fleet-builder',
    prompt:
      `${PREAMBLE}任务：在 \`src/duration.ts\` 里加 \`parseDuration(text: string): number\`，和已有的 \`formatDuration\` 反过来：\n` +
      '- 单位：`d`、`h`、`m`、`s`、`ms`，写法是整数加单位，可以多个连着写，如 `1h30m`、`90s`、`500ms`；顺序随意；单位之间可以有空白，首尾空白忽略。\n' +
      '- 返回毫秒（整数）。`ms` 是毫秒，不是 `m` 加 `s`。\n' +
      '- 空串、全是空白、没有单位、认不出的单位、负数、小数、同一个单位出现两次，都抛 `RangeError`，消息是 `bad duration: <原文>`。\n' +
      '- `parseDuration(formatDuration(n)) === n` 对所有非负整数成立。\n' +
      '先在 `test/` 下自己写好测试（新文件），再实现；`npm test` 全绿。不改已有的测试文件。',
    source: { kind: 'fixture' },
    planted:
      '规格里藏了几处易错点：`ms` 与 `m`+`s` 的歧义、同单位重复、小数和负数、单位间空白、与 formatDuration 互逆。' +
      '藏起来的 accept.test.ts 逐条核对。',
    why:
      '规格全写在题面里，Sonnet 按条实现稳过；Haiku 容易把 `ms` 吃成 `m`、漏掉重复单位或小数的拒绝。' +
      '这道是 Sonnet 档场景，Opus 不该比 Sonnet 更好。',
    grade: gradeBuilder,
  },
  {
    id: 'builder/ttl-cache',
    scenario: 'builder',
    name: 'ttl-cache',
    agent: 'fleet-builder',
    prompt:
      `${PREAMBLE}任务：新建 \`src/ttl-cache.ts\`，导出 \`class TtlCache<K, V>\`（不要用参数属性这类不可擦除的写法）：\n` +
      '- `new TtlCache({ max, ttlMs, now? })`：`now` 是返回毫秒的函数，默认 `Date.now`，测试里用它注入假时钟。`max`、`ttlMs` 不是正整数抛 `RangeError`。\n' +
      '- `set(key, value)`：写入并记下过期时刻 = 当前 + ttlMs；已有的 key 被覆盖，并重新计时。超过 `max` 条时淘汰最久没被用过的那条。\n' +
      '- `get(key)`：没有或已过期返回 `undefined`；命中算「用过」（变成最近用过的），但不续期。\n' +
      '- 「已过期」指当前时刻 ≥ 过期时刻。过期的条目不算在 `size` 里，也不该挤掉没过期的条目。\n' +
      '- `has(key)`、`delete(key)`（返回有没有删到）、只读属性 `size`。\n' +
      '先在 `test/` 下自己写好测试（新文件），再实现；`npm test` 全绿。不改已有的测试文件。',
    source: { kind: 'fixture' },
    planted:
      'LRU 加 TTL 的交界：get 刷新最近用过但不续期、覆盖 set 续期、过期点是「≥」、过期条目不占位置也不算 size。藏起来的 accept.test.ts 逐条核对。',
    why: '多条规则互相咬合，Sonnet 一般能全对；Haiku 常漏「过期条目不占位置」或「get 不续期」。',
    grade: gradeBuilder,
  },
  {
    id: 'debugger/week-start-tz',
    scenario: 'debugger',
    name: 'week-start-tz',
    agent: 'fleet-debugger',
    prompt:
      `${PREAMBLE}任务：\`test/week.test.ts\` 里「东京」那条红了，别的绿。找到根因，修在必经的那一步。\n` +
      '前两次有人试过：给东京的用例特判一下时区（会让洛杉矶之类别的时区继续错），没成。不要再打补丁式地修。\n' +
      '修完 `npm test` 全绿；改动尽量小；不改已有的测试文件。最终回答里写清根因。',
    source: { kind: 'fixture' },
    planted:
      '`weekdayOf` 用 `at.getUTCDay()`：日期按目标时区算，周几却按 UTC 算，两个坐标系混用。注释「周几和时区无关」是错的。正确做法是从时区里的日历日期算周几。',
    why:
      '症状只在时区日期和 UTC 日期不是同一天时出现，东京一条红测试容易引向「特判东京」；' +
      '根因要看出两套坐标混用。藏起来的洛杉矶、檀香山、跨年用例专门拦打补丁的修法。Sonnet 可能栽，Opus 该稳过。',
    grade: gradeDebugger(14),
  },
  {
    id: 'debugger/merge-config',
    scenario: 'debugger',
    name: 'merge-config',
    agent: 'fleet-debugger',
    prompt:
      `${PREAMBLE}任务：\`test/load.test.ts\` 里「上一次的覆盖不会留到下一次」红了。找到根因，修在必经的那一步。\n` +
      '前两次有人试过：每次 `loadConfig` 前把 `DEFAULTS` 重置一份（症状消了，但 `mergeConfig` 本身还在改它收到的对象，别处一调用又会中招），没成。不要再给同一个方案打补丁。\n' +
      '修完 `npm test` 全绿；改动尽量小；不改已有的测试文件。最终回答里写清根因。',
    source: { kind: 'fixture' },
    planted:
      '`mergeConfig` 对嵌套对象用 `Object.assign(current, …)`，`current` 就是 base 里的那个嵌套对象：合并时改了 base（即 DEFAULTS），且结果和 base 共用嵌套对象。' +
      '正确修法是递归返回新对象。',
    why:
      '症状在 `loadConfig`，根因在另一个文件的 `mergeConfig`；顺着症状改 `loadConfig`（克隆 DEFAULTS）能让可见测试转绿，' +
      '但藏起来的 extra.test.ts 直接测 `mergeConfig` 不改 base、不共用嵌套对象，打补丁的修法会红。Sonnet 可能栽，Opus 该稳过。',
    grade: gradeDebugger(10),
  },
  {
    id: 'standard-editor/pr-rounds',
    scenario: 'standard-editor',
    name: 'pr-rounds',
    agent: 'fleet-standard-editor',
    prompt:
      `${PREAMBLE}（这里没有 agents/ 和 decisions，规矩文档是 \`rules/pr-rules.md\`，钉它的测试是 \`test/rules.test.ts\`。）\n` +
      '任务：把「一个 PR 最多 3 轮」改成「最多 2 轮」。规矩文档里所有讲 PR 轮数的地方、和钉它的测试要在同一次里改齐，' +
      '新旧说法打架的地方一起改掉；不相干的数字不要动；测试不能删断言、不能 skip。改完 `npm test` 全绿。',
    source: { kind: 'fixture' },
    planted:
      '「3 轮」在文档里出现两处（一处在「谁负责」，一处在「交接」），测试里钉了两处；另有一处「连续失败不超过 3 次」是失败次数，不能改。',
    why: '要查全（两处文档加两处测试），还要认出 3 次不是 3 轮；Sonnet 常漏掉「交接」里那处，Opus 档该稳过。',
    grade: gradeRuleEdit,
  },
];
