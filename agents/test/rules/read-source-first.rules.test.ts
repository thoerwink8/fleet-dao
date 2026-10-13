// 钉住同步的目标清单盖住登记的每一家 AI：通用段（含底线「读不到先追数据源」，决定 0082）要写进每一家各自的全局说明
// （改标准：改这个文件要创始人同意，agents/test/rules/ 在 packages/conventions/standard-paths.json 里）。
// 通用段、技能的文字不再钉（决定 0089）。
// agents 是单独的 TypeScript 项目，引不进 packages/agents-sync 的源码：目标清单按文字读。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

const TARGETS_TS = read('../../../packages/agents-sync/src/targets.ts');

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

describe('规矩：通用段写到登记的每一家 AI（决定 0082）', () => {
  it('同步的目标清单盖住登记的每一家 AI：通用段写到它们各自的全局说明', () => {
    expect(uncovered(TARGETS_TS)).toEqual([]);
  });

  it('【故意造出的失败】目标清单里有一家不再是任何全局说明的 reader：查得出是哪一家', () => {
    const dropped = TARGETS_TS.replace("readers: ['kimi']", 'readers: []');
    expect(dropped).not.toBe(TARGETS_TS);
    expect(uncovered(dropped)).toEqual(['kimi']);
    expect(() => uncovered('// 空文件')).toThrow(/认不出 AGENTS 或 RULES_TARGETS/);
  });
});
