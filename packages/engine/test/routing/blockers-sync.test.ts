// 候选查询的被挡原因两边各写一份（engine 不依赖 db）：db 那边加了取值、这边没跟上，端口一接上就全是「被挡原因认不出」
// （PR #17 加 switched-off 时就漏过一次）。这里读 db 的源码现比；读不到、认不出就红，不当成「对上了」。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CANDIDATE_BLOCKERS } from '../../src/routing/index.ts';

const DB_CANDIDATES = new URL('../../../db/src/queries/candidates.ts', import.meta.url);

/** 源码里 `export type Blocker = | 'a' | 'b' …;` 的取值；写法认不出（引了别的类型、没有取值）为空。 */
function blockerUnion(code: string): string[] | null {
  const body = /export type Blocker\s*=\s*([^;]+);/.exec(code)?.[1];
  if (body === undefined) return null;
  const values = [...body.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
  const rest = body.replace(/'[^']+'/g, '').replace(/[\s|]/g, '');
  return values.length > 0 && rest === '' ? values : null;
}

describe('被挡原因和候选查询对得上', () => {
  it('db 的 Blocker 和 CANDIDATE_BLOCKERS 取值一样', () => {
    const union = blockerUnion(readFileSync(DB_CANDIDATES, 'utf8'));
    expect(union, '读不出 db 候选查询里 Blocker 的取值').not.toBeNull();
    expect([...(union ?? [])].sort()).toEqual([...CANDIDATE_BLOCKERS].sort());
  });

  it('故意造的漂移、认不出的写法都拦得住', () => {
    const drifted = blockerUnion("export type Blocker =\n  | 'offline'\n  | 'paused';");
    expect(drifted).toEqual(['offline', 'paused']);
    expect([...(drifted ?? [])].sort()).not.toEqual([...CANDIDATE_BLOCKERS].sort());
    expect(blockerUnion("export type Blocker = 'offline' | OtherBlocker;")).toBeNull();
    expect(blockerUnion('export type Blockers = string;')).toBeNull();
  });
});
