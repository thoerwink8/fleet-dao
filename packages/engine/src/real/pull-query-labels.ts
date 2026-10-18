import { type DomainValue, type NatureValue, resolveQueryAxes } from '@fleet-dao/conventions';
import type { GitHubClient, RepoRef } from '@fleet-dao/github';

/** 固定用途的直开 PR 路径也要贴两轴；保留其它标签，冲突和写后未生效照实失败。 */
export async function ensurePullQueryLabels(
  client: Pick<GitHubClient, 'request'>,
  repo: RepoRef,
  number: number,
  domain: DomainValue,
  nature: NatureValue,
): Promise<void> {
  const path = `/repos/${repo.owner}/${repo.name}/issues/${number}/labels`;
  const auth = { as: 'engine' as const, repo };
  const read = async () => {
    const response = await client.request({ method: 'GET', path, auth });
    if (
      !Array.isArray(response.data) ||
      response.data.some((label) => !label || typeof label.name !== 'string')
    )
      throw new Error(`PR #${number} 查询标签读不全，没查成`);
    return response.data.map((label: { name: string }) => label.name);
  };
  const labels = await read();
  const axis = resolveQueryAxes(labels, '', [`域:${domain}`, `性质:${nature}`]);
  if (axis.problems.length) throw new Error(`PR #${number}：${axis.problems.join('；')}`);
  const missing = axis.labels.filter((label) => !labels.includes(label));
  if (!missing.length) return;
  await client.request({ method: 'POST', path, auth, body: { labels: missing } });
  const back = await read();
  if (resolveQueryAxes(back).problems.length || axis.labels.some((label) => !back.includes(label)))
    throw new Error(`PR #${number} 查询标签写后回读不一致`);
}
