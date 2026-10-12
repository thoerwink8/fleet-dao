// 钉住通用段「底线」里「读不到先追数据源；要放宽判据，PR 里贴上游真的不给的证据」那条（改标准：改这个文件要创始人同意，
// agents/test/rules/ 在 packages/conventions/standard-paths.json 里）。
// 来由（决定 0082）：#1936 巡检「记账」读不到 token，把判据放宽成「四样 token 读到任意一样」让演练通过；根子是引擎读用量的
// 地方和时机不对，#1946 才修。创始人 2026-10-12 认为那是逃避，选定补这一句。规矩落在动作必经的地方：通用段底线（每台机器
// 各家 AI 的全局说明）和 chain-first 技能「硬规矩」（检查红了、读回的结果和预期不符时读的那一页）。
// 判不了「这次放宽有没有贴证据」，不拿关键词去拦 PR（`judge-or-code`）；这里钉住文字：通用段改写时不能悄悄丢、不能挪出同步的那一块。
// agents 是单独的 TypeScript 项目，引不进 packages/agents-sync 的源码：标记和目标清单都按文字读。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

const RULES = read('../../shared-rules.md');
const AGENTS_MD = read('../../../AGENTS.md');
const CHAIN_FIRST = read('../../skills/chain-first/SKILL.md');
const BLOCK_TS = read('../../../packages/agents-sync/src/block.ts');
const TARGETS_TS = read('../../../packages/agents-sync/src/targets.ts');

/** 同步脚本认的那对标记（packages/agents-sync/src/block.ts 的 BEGIN、END），按文字取，认不出就抛。 */
function syncMarkers(blockTs: string): { begin: string; end: string } {
  const begin = /export const BEGIN =\s*'([^']+)'/.exec(blockTs)?.[1];
  const end = /export const END =\s*'([^']+)'/.exec(blockTs)?.[1];
  if (begin === undefined || end === undefined)
    throw new Error('packages/agents-sync/src/block.ts 里认不出 BEGIN、END 两个标记');
  return { begin, end };
}

/** 同步脚本整块写进各家全局说明的那一块（两行标记之间）；标记不成对就抛，不当成空。 */
function syncedBlock(text: string): string {
  const { begin, end } = syncMarkers(BLOCK_TS);
  const lines = text.split('\n');
  const b = lines.findIndex((l) => l.trim() === begin);
  const e = lines.findIndex((l) => l.trim() === end);
  if (b === -1 || e === -1 || e < b) throw new Error('agents/shared-rules.md 里找不到成对的通用段标记');
  return lines.slice(b + 1, e).join('\n');
}

/** 一段 Markdown 里某个二级标题下面的内容（到下一个二级标题为止）；认不出标题就抛。 */
function section(text: string, title: string): string {
  const at = text.indexOf(`\n## ${title}\n`);
  if (at === -1) throw new Error(`认不出「## ${title}」标题`);
  const rest = text.slice(at + title.length + 5);
  const next = rest.indexOf('\n## ');
  return next === -1 ? rest : rest.slice(0, next);
}

/** 通用段里必须写着的两半，缺了哪半就列出哪半。 */
const SOURCE_FIRST: Record<string, RegExp> = {
  读不到先追数据源: /- 读不到先追数据源；/,
  放宽判据要贴上游不给的证据: /要放宽判据，PR 里贴上游真的不给的证据。/,
};

function missing(rules: Record<string, RegExp>, text: string): string[] {
  return Object.entries(rules)
    .filter(([, re]) => !re.test(text))
    .map(([name]) => name);
}

/** 目标清单里，有哪几家 AI 没有任何一份全局说明会写通用段（AGENTS 里登记的每一家都该是某个 RULES_TARGETS 的 reader）。 */
function uncovered(targetsTs: string): string[] {
  const agentsAt = targetsTs.indexOf('export const AGENTS = {');
  const agentsEnd = targetsTs.indexOf('} as const', agentsAt);
  const rulesAt = targetsTs.indexOf('export const RULES_TARGETS');
  const rulesEnd = targetsTs.indexOf('\n];', rulesAt);
  if (agentsAt === -1 || agentsEnd === -1 || rulesAt === -1 || rulesEnd === -1)
    throw new Error('packages/agents-sync/src/targets.ts 里认不出 AGENTS 或 RULES_TARGETS');
  const agents = [...targetsTs.slice(agentsAt, agentsEnd).matchAll(/^\s+(\w+): \{ name:/gm)].map(
    (m) => m[1] ?? '',
  );
  if (agents.length === 0) throw new Error('targets.ts 的 AGENTS 里一家都认不出');
  const readers = new Set(
    [...targetsTs.slice(rulesAt, rulesEnd).matchAll(/readers: \[([^\]]*)\]/g)].flatMap((m) =>
      [...(m[1] ?? '').matchAll(/'(\w+)'/g)].map((r) => r[1]),
    ),
  );
  return agents.filter((a) => !readers.has(a));
}

const SHARED = syncedBlock(RULES);

describe('规矩：读不到先追数据源；放宽判据要贴上游真的不给的证据（决定 0082，2026-10-12）', () => {
  it('写在通用段的「底线」里，两半都在', () => {
    expect(missing(SOURCE_FIRST, section(`\n${SHARED}`, '底线'))).toEqual([]);
  });

  it('和旧的那条「不拿空、0 或 ok 冒充没事」挨着、旧的没被挤掉或改窄', () => {
    expect(SHARED).toMatch(
      /- 代码里读不到、没跑成、格式认不出，返回明确的失败，不拿空、0 或 ok 冒充没事；[^\n]*\n- 读不到先追数据源；/,
    );
  });

  it('在同步脚本认的那对标记之间（会推到每台机器），不是本仓段', () => {
    const at = AGENTS_MD.indexOf('## 本仓（fleet-dao）');
    expect(at, '仓根 AGENTS.md 里认不出「## 本仓」标题').toBeGreaterThanOrEqual(0);
    expect(missing(SOURCE_FIRST, AGENTS_MD.slice(at))).toHaveLength(Object.keys(SOURCE_FIRST).length);
  });

  it('同步的目标清单盖住登记的每一家 AI：通用段写到它们各自的全局说明', () => {
    expect(uncovered(TARGETS_TS)).toEqual([]);
  });

  it('chain-first 技能的硬规矩跟着写：检查红了、读不到时读的就是那一页', () => {
    expect(section(CHAIN_FIRST, '硬规矩')).toMatch(
      /- \*\*读不到先追数据源\*\*[^\n]*不放宽读方的判据[^\n]*PR 里贴上游真的不给的证据/,
    );
  });

  it('【故意造出的失败】整条删掉：两半都查得出缺', () => {
    const cut = SHARED.replace(/- 读不到先追数据源；[^\n]*\n/, '');
    expect(cut).not.toBe(SHARED);
    expect(missing(SOURCE_FIRST, cut)).toEqual(Object.keys(SOURCE_FIRST));
  });

  it('【故意造出的失败】只留前半句、不说放宽要贴证据：查得出来', () => {
    const cut = SHARED.replace('要放宽判据，PR 里贴上游真的不给的证据。', '');
    expect(cut).not.toBe(SHARED);
    expect(missing(SOURCE_FIRST, cut)).toEqual(['放宽判据要贴上游不给的证据']);
  });

  it('【故意造出的失败】挪到结束标记后面（不再同步）：查得出来；标记不成对时明确报错、不当成空', () => {
    const { end } = syncMarkers(BLOCK_TS);
    const line = /- 读不到先追数据源；[^\n]*\n/.exec(RULES)?.[0];
    expect(line, '通用段原件里认不出这一行').toBeDefined();
    const moved = RULES.replace(line ?? '', '').replace(end, `${end}\n${line ?? ''}`);
    expect(moved).not.toBe(RULES);
    expect(missing(SOURCE_FIRST, syncedBlock(moved))).toEqual(Object.keys(SOURCE_FIRST));
    expect(() => syncedBlock(RULES.replace(end, ''))).toThrow(/找不到成对的通用段标记/);
  });

  it('【故意造出的失败】目标清单里有一家不再是任何全局说明的 reader：查得出是哪一家', () => {
    const dropped = TARGETS_TS.replace("readers: ['kimi']", 'readers: []');
    expect(dropped).not.toBe(TARGETS_TS);
    expect(uncovered(dropped)).toEqual(['kimi']);
    expect(() => uncovered('// 空文件')).toThrow(/认不出 AGENTS 或 RULES_TARGETS/);
  });

  it('【故意造出的失败】chain-first 删掉「不放宽读方的判据」：查得出来', () => {
    const cut = CHAIN_FIRST.replace('不放宽读方的判据', '');
    expect(cut).not.toBe(CHAIN_FIRST);
    expect(section(cut, '硬规矩')).not.toMatch(/不放宽读方的判据/);
  });
});
