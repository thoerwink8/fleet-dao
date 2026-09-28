// 钉住合并闸能看的现状只有那几样（创始人 2026-09-27 晚拍，#299；2026-09-28 下午拍 #444 收窄成四样；design 第五节
// 「发现问题当场修」第 5 条、AGENTS 本仓段）：CI 里跑的检查必须确定、只看检出来的文件；合并闸 merge-gate 汇总 PR
// 此刻的状态——PR 本身（草稿、冲突、改了哪些文件，正文里的必填栏只提醒）和当前头上的提交状态（第二意见）。
// 「认领对得上」「写了关单却没带结果.md」#444 起不再是合并闸的输入（缺的由每天的关单对账另外提醒，不再挡合并）。
// 往合并闸里多加别的现状（单子开没开、时间、别的仓……）这里会红：要加得先改上面那两处的规矩，再改这里的清单。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = (name: string) => readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), 'utf8');
const gate = src('merge-gate.ts');
const gates = src('merge-gates.ts');

/** 合并闸从 GitHub 读、往 GitHub 写的口子（merge-gate.ts 的 GitHubReads），一样一行写清看的是什么。 */
const ALLOWED_READS: Record<string, string> = {
  pr: 'PR 本身：草稿、冲突、当前头、改了几个文件、正文和标签（必填栏只提醒）',
  files: 'PR 改了哪些文件：判改没改到先审后合的路径',
  statuses: '当前头上的提交状态（逐条的）：第二意见',
  fileAt: '这个 PR 里的 plan.md：必填栏「对应计划」只提醒',
  exists: '这个 PR 里的 specs 目录在不在：必填栏「specs」只提醒',
  openPrs: '主线一动、第二意见写上来时逐个重算开着的 PR：挑要算哪几个，不参与判',
  mainHead: '写结论前核主线在这一轮里没动：动了不写，不参与判',
  writeStatus: '写 merge-gate 这一个状态',
};

/** 合并闸认得的提交状态名：自己写的 merge-gate、第二意见（#444 起「认领对得上」不算这里头，合并闸不再等它）。 */
const ALLOWED_CONTEXTS: Record<string, string> = {
  GATE_CONTEXT: 'merge-gate',
  SECOND_OPINION_CONTEXT: 'second-opinion',
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

function interfaceMethods(code: string, name: string): string[] {
  const start = code.indexOf(`export interface ${name} {`);
  if (start < 0)
    throw new Error(`merge-gate.ts 里找不到 interface ${name}：合并闸的读写口子换了名字，这条测试跟着改`);
  const end = code.indexOf('\n}', start);
  const body = code.slice(start, end);
  return [...body.matchAll(/^ {2}(\w+)\(/gm)].map((m) => m[1] ?? '');
}

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
  });

  it('【故意造出的失败】merge-gate.yml 不放行 second-opinion：状态贴上来不重算，查得出来', () => {
    const narrowed = workflow.replace(` || github.event.context == 'second-opinion'`, '');
    expect(narrowed).not.toBe(workflow);
    expect(missingTriggers(narrowed)).toEqual(['second-opinion']);
  });

  it('【故意造出的失败】往读写口子里多加一个（比如读单子开没开）：上面那条就红', () => {
    const extended = gate.replace(
      'export interface GitHubReads {',
      'export interface GitHubReads {\n  issueOpen(number: number): Promise<boolean>;',
    );
    expect(interfaceMethods(extended, 'GitHubReads').sort()).not.toEqual(Object.keys(ALLOWED_READS).sort());
  });
});
