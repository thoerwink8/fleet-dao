import type { GhRequest, GitHubClient, RepoRef } from '@fleet-dao/github';
import { describe, expect, it } from 'vitest';
import { ensurePullQueryLabels } from '../../src/real/pull-query-labels.ts';

const repo: RepoRef = { owner: 'o', name: 'r' };
function fake(initial: string[] = [], opts: { stale?: boolean; malformed?: boolean; fail?: boolean } = {}) {
  let labels = initial;
  const writes: unknown[] = [];
  const client: Pick<GitHubClient, 'request'> = {
    request: async <T>(req: GhRequest) => {
      if (req.method === 'POST') {
        if (opts.fail) throw new Error('403');
        writes.push(req);
        if (!opts.stale) labels = [...labels, ...(req.body as { labels: string[] }).labels];
      }
      return {
        status: 200,
        data: (opts.malformed ? {} : labels.map((name) => ({ name }))) as T,
        headers: new Headers(),
      };
    },
  };
  return { client, writes, labels: () => labels };
}
describe('两个固定用途的直开 PR 也补两轴', () => {
  it.each(['bug', 'process'] as const)('性质 %s 只补缺轴、保留其它标签、重复执行不写', async (nature) => {
    const f = fake(['冻结']);
    await ensurePullQueryLabels(f.client, repo, 5, 'engine', nature);
    expect(f.labels()).toEqual(['冻结', '域:engine', `性质:${nature}`]);
    await ensurePullQueryLabels(f.client, repo, 5, 'engine', nature);
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]).toMatchObject({
      path: '/repos/o/r/issues/5/labels',
      body: { labels: ['域:engine', `性质:${nature}`] },
    });
  });
  it('冲突、读不全、写失败和假成功均不放过', async () => {
    const conflict = fake(['域:api', '域:engine']);
    await expect(ensurePullQueryLabels(conflict.client, repo, 5, 'engine', 'bug')).rejects.toThrow('查询轴');
    expect(conflict.writes).toEqual([]);
    for (const opts of [{ stale: true }, { malformed: true }, { fail: true }]) {
      const f = fake([], opts);
      await expect(ensurePullQueryLabels(f.client, repo, 5, 'engine', 'bug')).rejects.toThrow();
    }
  });
});
