// 任务书草稿的准入检查（agents/skills/commander/scripts/check-brief.mjs，决定 0035）：补单交给 Sonnet 或 Haiku 写草稿后、开单前跑。
// 实测（2026-10-09）Haiku 5.5 写任务书时把函数名、事件名也用反引号括进「已知的模块」，会被引擎当路径判成跨模块；规矩写全加这道脚本兜住。
// 下面先钉合格的过，再一条条造出不合格的（缺标题、非路径行、跨包、提 workflows、验收写 grep），最后一条是读不到文件也明确失败。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { runChild } from './child.ts';

const SCRIPT = fileURLToPath(new URL('../skills/commander/scripts/check-brief.mjs', import.meta.url));

interface BriefCheck {
  problems: string[];
  paths: string[];
  missing: string[];
}
interface CheckBriefLib {
  checkBrief(text: string, opts?: { quote?: string; exists?: (p: string) => boolean }): BriefCheck;
  render(r: BriefCheck): string[];
}

const lib = (await import(pathToFileURL(SCRIPT).href)) as CheckBriefLib;

const QUOTE = '飞书卡片上的按钮点了没反应';
const GOOD = [
  '# 飞书卡片按钮点了没反应',
  '',
  '## 场景',
  '创始人在飞书群里点卡片上的「打开驾驶舱」，没有跳转。',
  '',
  '## 原话',
  '```',
  `2026-10-09 09:00 ${QUOTE}`,
  '```',
  '',
  '## 已知的模块',
  '- `packages/feishu/src/gateway.ts`',
  '- `packages/feishu/src/cards.ts`',
  '',
  '## 怎么算做完',
  '- diff 里 `packages/feishu/src/cards.ts` 的按钮带上 `url` 字段',
  '- 新加一条测试点名卡片按钮的地址',
  '',
].join('\n');

const problems = (text: string, quote?: string) =>
  lib.checkBrief(text, quote === undefined ? {} : { quote }).problems;

/** 把合格样本里的一段换掉；找不到原文就报错，不让造失败的那条悄悄变成没造 */
function broken(from: string, to: string): string {
  const out = GOOD.replace(from, to);
  if (out === GOOD) throw new Error(`合格样本里找不到「${from}」，这条失败造不出来`);
  return out;
}

const dir = mkdtempSync(join(tmpdir(), 'check-brief-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function cli(args: string[]) {
  const r = runChild(process.execPath, [SCRIPT, ...args]);
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('任务书准入检查（决定 0035）', () => {
  it('合格的任务书：过，路径数对', () => {
    const r = lib.checkBrief(GOOD, { quote: QUOTE });
    expect(r.problems).toEqual([]);
    expect(r.paths).toEqual(['packages/feishu/src/gateway.ts', 'packages/feishu/src/cards.ts']);
    expect(lib.render(r).at(-1)).toBe('PASS（路径 2 个）');
  });

  it('命令行：合格的退出码 0、最后一行 PASS；仓里没有的路径只提示不判', () => {
    const f = join(dir, 'good.md');
    writeFileSync(f, GOOD);
    const r = cli([f, '--quote', QUOTE, '--root', dir]);
    expect(r.out).toContain('提示：这些路径仓里不存在');
    expect(r.out.trim().split('\n').at(-1)).toBe('PASS（路径 2 个）');
    expect(r.code).toBe(0);
  });

  it('【故意造出的失败】缺「## 场景」标题：不过', () => {
    expect(problems(broken('## 场景\n', '### 场景\n'))).toEqual(['缺「## 场景」']);
  });

  it('【故意造出的失败】已知的模块里有不是路径的行（没反引号）：不过', () => {
    const text = broken(
      '- `packages/feishu/src/cards.ts`\n',
      '- `packages/feishu/src/cards.ts`\n- 卡片渲染那一块\n',
    );
    expect(problems(text)).toEqual(['已知的模块里有认不出路径的行：- 卡片渲染那一块']);
  });

  it('【故意造出的失败】跨包（两个 packages/<包>）、把函数名也括进反引号：不过', () => {
    const twoPkgs = broken('`packages/feishu/src/cards.ts`\n', '`packages/api/src/cli.ts`\n');
    expect(problems(twoPkgs)).toEqual(['跨模块：packages/feishu, packages/api']);
    const fnName = broken(
      '- `packages/feishu/src/cards.ts`\n',
      '- `packages/feishu/src/cards.ts` 里的 `renderCard`\n',
    );
    expect(problems(fnName)).toEqual(['跨模块：packages/feishu, renderCard']);
  });

  it('【故意造出的失败】正文提到 .github/workflows/：不过', () => {
    const text = broken('## 场景\n', '## 场景\n顺手改 `.github/workflows/ci.yml` 的超时。\n');
    expect(problems(text)).toEqual(['正文提到 .github/workflows/']);
  });

  it('【故意造出的失败】验收条写「grep」：不过', () => {
    const text = broken('- 新加一条测试点名卡片按钮的地址', '- 跑 grep url 看结果');
    expect(problems(text)).toEqual(['验收条里有「grep」']);
  });

  it('【故意造出的失败】碰 agents/、原话被改写：各自不过', () => {
    const agents = broken('`packages/feishu/src/gateway.ts`', '`agents/hooks/stop.mjs`');
    expect(problems(agents)).toContain('碰了 agents/（标准路径）');
    expect(problems(broken(QUOTE, '卡片按钮坏了'), QUOTE)).toEqual(['原话没原样保留']);
  });

  it('【故意造出的失败】命令行：不合格退出码 1、最后列出问题；读不到文件、没给文件退出码 2，不当 PASS', () => {
    const bad = join(dir, 'bad.md');
    writeFileSync(bad, broken('- 新加一条测试点名卡片按钮的地址', '- 跑 grep url 看结果'));
    const r = cli([bad]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAIL 1\n- 验收条里有「grep」');
    const gone = cli([join(dir, 'no-such.md')]);
    expect(gone.code).toBe(2);
    expect(gone.out).toContain('读不到任务书');
    expect(gone.out).not.toContain('PASS');
    expect(cli([]).code).toBe(2);
  });
});
