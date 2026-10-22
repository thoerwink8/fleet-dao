import { describe, expect, it } from 'vitest';
import { collectGuardInventory } from '../src/guard-inventory.ts';
import { weeklyGuardProgress } from '../src/guard-inventory-progress.ts';
import { memRepo } from './helpers.ts';

const monday = new Date('2026-10-26T01:41:00Z');
const report = collectGuardInventory(memRepo({}), monday);

describe('库存进入现有每周进度', () => {
  it('非周一不读不写；周一一行含未知，重跑同一天不重复', async () => {
    const comments: string[] = [];
    const reads: string[] = [];
    const progress = {
      async readSince(since: string) {
        reads.push(since);
        return comments;
      },
      async note(text: string) {
        comments.push(text);
      },
    };
    expect(await weeklyGuardProgress(report, new Date('2026-10-23T01:41:00Z'), progress)).toBe('skipped');
    expect(reads).toEqual([]);
    expect(await weeklyGuardProgress(report, monday, progress)).toBe('posted');
    expect(reads).toEqual(['2026-10-26T00:00:00Z']);
    expect(comments[0]).toContain('hook unknown');
    expect(comments[0]).toContain('没查成');
    expect(await weeklyGuardProgress(report, monday, progress)).toBe('exists');
    expect(comments).toHaveLength(1);
    expect(await weeklyGuardProgress(report, new Date('2026-11-02T01:41:00Z'), progress)).toBe('posted');
    expect(comments).toHaveLength(2);
  });

  it('读不到不冒没有周报，写失败不冒成功', async () => {
    let writes = 0;
    await expect(
      weeklyGuardProgress(report, monday, {
        async readSince() {
          throw new Error('read failed');
        },
        async note() {
          writes++;
        },
      }),
    ).rejects.toThrow('read failed');
    expect(writes).toBe(0);
    await expect(
      weeklyGuardProgress(report, monday, {
        async readSince() {
          return [];
        },
        async note() {
          throw new Error('write failed');
        },
      }),
    ).rejects.toThrow('write failed');
  });
});
