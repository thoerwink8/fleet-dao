// 钉住合并闸能看的现状只有那几样（创始人 2026-09-27 晚拍，#299；2026-09-28 下午拍 #444 收窄成四样；design 第五节
// 「发现问题当场修」第 5 条、AGENTS 本仓段）：CI 里跑的检查必须确定、只看检出来的文件；合并闸 merge-gate 汇总 PR
// 此刻的状态——PR 本身（分支名、改了哪些文件；#654 起不看草稿、冲突、正文）和当前头上的提交状态（第二意见；#555-2 起
// 再加一条冷调用的结论）。#555-2 加 cold-verify 时**没有**给合并闸加新的读口子：冷调用的结论和第二意见在同一次
// statuses 调用里读回来，只是另一个 context——闸里起模型调用会破坏「CI 检查必须确定」这条，所以冷调用在装配侧跑、
// 结论贴成状态，闸只读。往合并闸里多加别的现状（单子开没开、时间、别的仓……）这里会红：要加得先改上面那两处的规矩，
// 再改这里的清单。
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const src = (name: string) => readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), 'utf8');
const gate = src('merge-gate.ts');
const gates = src('merge-gates.ts');

/** 合并闸从 GitHub 读、往 GitHub 写的口子（merge-gate.ts 的 GitHubReads），一样一行写清看的是什么。 */
const ALLOWED_READS: Record<string, string> = {
  pr: 'PR 本身：当前头、分支名、改了几个文件、开着还是关了（草稿、冲突 GitHub 自己拦，必填栏没有了，#654）',
  files: 'PR 改了哪些文件：判改没改到先审后合的路径',
  statuses:
    '当前头上的提交状态（逐条的）：第二意见、合前一次冷调用的结论（#555-2，同一份读回来、各认各的 context）',
  openPrs: '第二意见、冷调用写上来时逐个重算开着的 PR：挑要算哪几个，不参与判',
  fileAt:
    '改了已有的 ci.yml：读改动前（共同祖先）和改动后（当前头）两份全文做结构比对，判这次改动碰没碰信任（创始人 2026-10-03「1+2+3」）',
  mergeBase: '改动前那份取哪个提交：PR 的改动是对共同祖先算的，比对要用同一个起点',
  writeStatus: '写 merge-gate 这一个状态',
};

/** 合并闸认得的提交状态名：自己写的 merge-gate、第二意见（#444 起「认领对得上」不算这里头，合并闸不再等它）、
 * 合前一次冷调用的结论（#555-2：验收那一遍的 verdict，装配侧贴、闸只读，不许闸里起模型调用）。 */
const ALLOWED_CONTEXTS: Record<string, string> = {
  GATE_CONTEXT: 'merge-gate',
  SECOND_OPINION_CONTEXT: 'second-opinion',
  COLD_VERIFY_CONTEXT: 'cold-verify',
};

const workflow = readFileSync(
  fileURLToPath(new URL('../../../.github/workflows/merge-gate.yml', import.meta.url)),
  'utf8',
);

/** merge-gate.yml 的 job 条件没放行 status 事件的那几个状态名（合并闸自己写的 merge-gate 不用放行：写了会自己转圈）。 */
function missingTriggers(yml: string): string[] {
  const cond = /^\s*if: (github\.event_name != 'status'.*)$/m.exec(yml)?.[1];
  if (!cond) throw new Error('merge-gate.yml 里找不到按 status 事件放行的 if：写法换了，这条测试跟着改');
  return Object.entries(ALLOWED_CONTEXTS)
    .filter(([name]) => name !== 'GATE_CONTEXT')
    .map(([, ctx]) => ctx)
    .filter((ctx) => !cond.includes(`github.event.context == '${ctx}'`));
}

/** 把某个 context 从 if 里摘掉（模拟「放了新状态名、忘了放行它」）。摘不到说明写法变了，测试当场炸。 */
function withoutTrigger(yml: string, ctx: string): string {
  const from = ` || github.event.context == '${ctx}'`;
  const narrowed = yml.replace(from, '');
  if (narrowed === yml)
    throw new Error(`merge-gate.yml 的 if 里找不到 ${ctx} 的放行：写法换了，这条测试跟着改`);
  return narrowed;
}

function interfaceMethods(code: string, name: string): string[] {
  const start = code.indexOf(`export interface ${name} {`);
  if (start < 0)
    throw new Error(`merge-gate.ts 里找不到 interface ${name}：合并闸的读写口子换了名字，这条测试跟着改`);
  const end = code.indexOf('\n}', start);
  const body = code.slice(start, end);
  return [...body.matchAll(/^ {2}(\w+)\(/gm)].map((m) => m[1] ?? '');
}

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const posix = (p: string) => p.split('\\').join('/');

/** 入口只借 pr-fields.ts 的 annotation 给 Actions 报错加格式：它改不了结论，不算闸的输入（和 merge-gates.test.ts 里走同一遍导入时的排除一样）。 */
const FORMAT_ONLY = new Set(['packages/conventions/src/pr-fields.ts']);

/** 闸的入口文件，顺着相对 import 能走到的每个 .ts（仓内路径）：闸的判法就是这些文件；少列一个，它变了开着的 PR 不重算。 */
function importClosure(entry: string): string[] {
  const seen = new Set<string>();
  const walk = (file: string): void => {
    if (seen.has(file) || FORMAT_ONLY.has(file)) return;
    seen.add(file);
    const text = readFileSync(join(REPO, file), 'utf8');
    for (const m of text.matchAll(/from '(\.[^']+\.ts)'/g)) {
      walk(posix(relative(REPO, join(dirname(join(REPO, file)), m[1] ?? ''))));
    }
  };
  walk(entry);
  return [...seen].sort();
}

/** merge-gate.yml 里 on.push.paths 列的路径；写法换了（没有 push、没有 paths）直接抛，不当成「没列」。 */
function pushPaths(yml: string): string[] {
  const doc = parse(yml) as { on?: { push?: { paths?: unknown } } } | null;
  const paths = doc?.on?.push?.paths;
  if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string')) {
    throw new Error('merge-gate.yml 里找不到 on.push.paths（一串路径）：写法换了，这条测试跟着改');
  }
  return paths as string[];
}

/** 闸的判定输入：入口文件和它 import 到的所有文件、高风险清单、这份工作流自己；在 push.paths 里漏列的。 */
function unwatchedInputs(yml: string): string[] {
  const watched = new Set(pushPaths(yml));
  const inputs = [
    ...importClosure('packages/conventions/src/bin/merge-gate.ts'),
    'packages/conventions/high-risk-paths.json',
    '.github/workflows/merge-gate.yml',
  ];
  return inputs.filter((f) => !watched.has(f));
}

describe('合并闸的判定输入变了，开着的 PR 要重算（#654 第二意见）', () => {
  it('闸 import 到的每个文件、高风险清单、工作流自己都在 push.paths 里：它们在主线上一变就重算所有开着的 PR', () => {
    const inputs = importClosure('packages/conventions/src/bin/merge-gate.ts');
    expect(inputs.length, '一个文件都没走到：解析错了，不是没有').toBeGreaterThanOrEqual(4);
    expect(inputs, '格式化报错的 pr-fields 不算闸的输入').not.toContain(
      'packages/conventions/src/pr-fields.ts',
    );
    expect(unwatchedInputs(workflow)).toEqual([]);
  });

  it('push.paths 里没有多余的：列的每个文件都真是闸的输入', () => {
    const inputs = new Set([
      ...importClosure('packages/conventions/src/bin/merge-gate.ts'),
      'packages/conventions/high-risk-paths.json',
      '.github/workflows/merge-gate.yml',
    ]);
    expect(pushPaths(workflow).filter((p) => !inputs.has(p))).toEqual([]);
  });

  it('【故意造出的失败】从 push.paths 里摘掉高风险清单：查得出来', () => {
    const narrowed = workflow.replace('      - packages/conventions/high-risk-paths.json\n', '');
    expect(narrowed).not.toBe(workflow);
    expect(unwatchedInputs(narrowed)).toEqual(['packages/conventions/high-risk-paths.json']);
  });

  it('【故意造出的失败】闸多 import 了一个文件却没列进 push.paths：查得出来', () => {
    const narrowed = workflow.replace('      - packages/conventions/src/flow-branch.ts\n', '');
    expect(narrowed).not.toBe(workflow);
    expect(unwatchedInputs(narrowed)).toEqual(['packages/conventions/src/flow-branch.ts']);
  });

  it('【故意造出的失败】工作流里没有 push 触发：抛错，不当成「没列」', () => {
    const noPush = workflow.replace(/^ {2}push:[\s\S]*?(?=^ {2}workflow_dispatch:)/m, '');
    expect(noPush).not.toBe(workflow);
    expect(() => pushPaths(noPush)).toThrow('找不到 on.push.paths');
  });
});

describe('合并闸只汇总 PR 此刻的状态（#299 创始人拍板）', () => {
  it('从 GitHub 读、往 GitHub 写的口子就这几个；多加一个会红（先改 design 第五节第 5 条）', () => {
    const methods = interfaceMethods(gate, 'GitHubReads');
    expect(methods.length, '一个方法都没认出来：解析错了，不是没有').toBeGreaterThan(0);
    expect(methods.sort()).toEqual(Object.keys(ALLOWED_READS).sort());
  });

  it('认得的提交状态名就这几个；多认一个会红', () => {
    const contexts = Object.fromEntries(
      [...gates.matchAll(/^export const (\w+_CONTEXT) = '([^']*)';$/gm)].map((m) => [m[1], m[2]]),
    );
    expect(contexts).toEqual(ALLOWED_CONTEXTS);
    expect([...gate.matchAll(/^export const (\w+_CONTEXT) = /gm)]).toEqual([]);
  });

  it('不看时间：判法里没有读钟的（Date.now、new Date()）', () => {
    for (const [file, code] of [
      ['merge-gate.ts', gate],
      ['merge-gates.ts', gates],
    ] as const) {
      expect(code, file).not.toMatch(/\bDate\.now\s*\(/);
      expect(code, file).not.toMatch(/\bnew Date\s*\(\s*\)/);
      expect(code, file).not.toMatch(/\bperformance\.now\s*\(/);
    }
  });

  it('合并闸读的每个状态（自己写的 merge-gate 除外）写上来时都会重算：merge-gate.yml 的 if 放行它的 status 事件', () => {
    expect(missingTriggers(workflow)).toEqual([]);
    // 覆盖得全不全由 ALLOWED_CONTEXTS 和 if 现算，不写死几个名字：以后再加一条状态忘了放行，这里照样红。
    expect(Object.keys(ALLOWED_CONTEXTS).length).toBeGreaterThan(2);
  });

  it('【故意造出的失败】merge-gate.yml 不放行 second-opinion：状态贴上来不重算，查得出来', () => {
    const narrowed = withoutTrigger(workflow, 'second-opinion');
    expect(narrowed).not.toBe(workflow);
    expect(missingTriggers(narrowed)).toEqual(['second-opinion']);
  });

  it('【故意造出的失败】merge-gate.yml 不放行 cold-verify（#555-2 新加的那条）：状态贴上来不重算，查得出来', () => {
    expect(ALLOWED_CONTEXTS.COLD_VERIFY_CONTEXT).toBe('cold-verify');
    const narrowed = withoutTrigger(workflow, 'cold-verify');
    expect(missingTriggers(narrowed)).toEqual(['cold-verify']);
  });

  it('【故意造出的失败】两条状态都忘了放行：两个名字都报出来（不是只报最后一个）', () => {
    const narrowed = withoutTrigger(withoutTrigger(workflow, 'cold-verify'), 'second-opinion');
    expect(missingTriggers(narrowed).sort()).toEqual(['cold-verify', 'second-opinion']);
  });

  it('【故意造出的失败】往读写口子里多加一个（比如读单子开没开）：上面那条就红', () => {
    const extended = gate.replace(
      'export interface GitHubReads {',
      'export interface GitHubReads {\n  issueOpen(number: number): Promise<boolean>;',
    );
    expect(interfaceMethods(extended, 'GitHubReads').sort()).not.toEqual(Object.keys(ALLOWED_READS).sort());
  });

  it('#555-2 的冷调用没给合并闸加新的读口子：读状态还是那一个 statuses，闸里不起模型调用', () => {
    const methods = interfaceMethods(gate, 'GitHubReads');
    // 读状态的口子只有一个（statuses）；writeStatus 是闸自己写 merge-gate 那一个，不是读别处的结论。
    expect(methods).toContain('statuses');
    expect(
      methods.filter((m) => /^(get|read|list|fetch)?.*[Ss]tatus/.test(m) && m !== 'writeStatus'),
    ).toEqual(['statuses']);
    // 闸里不许出现起模型调用的痕迹（起了就不确定：同一份代码两次跑结果可能不一样）。
    expect(gate).not.toMatch(/invokeVerifier|chooseModelForFamily|one-shot|runOneShot/);
  });
});
