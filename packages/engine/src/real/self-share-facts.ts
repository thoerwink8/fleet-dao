// 名额档位（jobs/self-share.ts）要的三项现值的真读法：主线 CI 红了多少分钟（GitHub Actions）、机器开的自身缺陷单（GitHub 单）、
// 非掏钱非删数据原因的拍板卡（库）。每项各自读、各自带原因：一项读不到只是那一项 value 为 null（按没过算），不拖累另外两项。
import { type Db, offReasonDecisionCount, repoByName } from '@fleet-dao/db';
import type { GitHubClient } from '@fleet-dao/github';
import { errMessage } from '@fleet-dao/shared/util';
import type { SelfShareReading, SelfShareReadings } from '../jobs/self-share.ts';
import { SELF_REPO_NAME } from '../jobs/self-share.ts';

const WINDOW_MS = 7 * 86_400_000;
/** e2e 偶发汇总单的固定标题（conventions 的 FLAKY_SUMMARY_TITLE）：同一时间只一张，不算「机器开的缺陷单」。 */
const FLAKY_SUMMARY_TITLE = 'e2e 偶发：多条用例达阈值（汇总）';
/** 缺陷单的类别标签（conventions 的 ISSUE_KIND）。 */
const DEFECT_LABEL = '缺陷';

function notRead(why: string): never {
  throw new Error(why);
}

/** 主线一次已结束的 push 运行：结论和结束时刻。 */
export interface CiRunEnd {
  conclusion: string;
  endedAt: Date;
}

/**
 * 主线红的分钟数：从一次 failure 结束起，到下一次 success 结束止（和诊断的口径一致：failure 完成到下一个 success 完成），截到 [from, to)。
 * 到 to 还没等到 success 的，红到 to。窗口开头已经红着的（上一次 failure 在窗口之前）读不到，按绿算；
 * failure、success 以外的结论（取消、跳过）不改变红绿。
 */
export function ciRedMinutes(runs: readonly CiRunEnd[], from: Date, to: Date): number {
  const sorted = runs
    .filter((r) => r.conclusion === 'failure' || r.conclusion === 'success')
    .sort((a, b) => a.endedAt.getTime() - b.endedAt.getTime());
  let redSince: number | null = null;
  let ms = 0;
  const add = (start: number, end: number) => {
    const s = Math.max(start, from.getTime());
    const e = Math.min(end, to.getTime());
    if (e > s) ms += e - s;
  };
  for (const r of sorted) {
    const t = r.endedAt.getTime();
    if (t >= to.getTime()) break;
    if (r.conclusion === 'failure') {
      if (redSince === null) redSince = t;
    } else if (redSince !== null) {
      add(redSince, t);
      redSince = null;
    }
  }
  if (redSince !== null) add(redSince, to.getTime());
  return Math.round((ms / 60_000) * 10) / 10;
}

function parseRunEnd(item: unknown): CiRunEnd {
  const row = item as { id?: unknown; conclusion?: unknown; updated_at?: unknown } | null;
  if (!row || typeof row !== 'object') return notRead('ci.yml 运行列表里有一条认不出');
  const endedAt = typeof row.updated_at === 'string' ? new Date(row.updated_at) : null;
  if (endedAt === null || Number.isNaN(endedAt.getTime())) {
    return notRead(`ci.yml 运行 ${String(row.id)} 的结束时刻认不出`);
  }
  return { conclusion: typeof row.conclusion === 'string' ? row.conclusion : '', endedAt };
}

/** 窗口里「机器开的」缺陷单：贴「缺陷」、不是 PR、开单人是机器人账号、不是 e2e 汇总单、开单时刻在 [from, to)。 */
export function countMachineDefects(items: readonly unknown[], from: Date, to: Date): number {
  let n = 0;
  for (const item of items) {
    const row = item as {
      number?: unknown;
      title?: unknown;
      created_at?: unknown;
      pull_request?: unknown;
      user?: { type?: unknown } | null;
    } | null;
    if (!row || typeof row !== 'object') return notRead('缺陷单列表里有一条认不出');
    const created = typeof row.created_at === 'string' ? new Date(row.created_at) : null;
    if (created === null || Number.isNaN(created.getTime())) {
      return notRead(`缺陷单 #${String(row.number)} 的开单时刻认不出`);
    }
    if (row.pull_request !== undefined) continue;
    if (created < from || created >= to) continue;
    if (row.user?.type !== 'Bot') continue;
    if (row.title === FLAKY_SUMMARY_TITLE) continue;
    n += 1;
  }
  return n;
}

async function guard(f: () => Promise<number>, what: string): Promise<SelfShareReading> {
  try {
    return { value: await f() };
  } catch (err) {
    return { value: null, unread: `${what}：${errMessage(err)}` };
  }
}

export function selfShareFacts(w: {
  db: Db;
  client: Pick<GitHubClient, 'all'>;
}): (to: Date) => Promise<Pick<SelfShareReadings, 'ciRedMinutes' | 'selfDefects' | 'offReasonDecisions'>> {
  const selfRepo = async () => {
    const repo = await repoByName(w.db, SELF_REPO_NAME);
    if (!repo) return notRead(`受管的仓里没有 ${SELF_REPO_NAME}`);
    return { owner: repo.owner, name: repo.name };
  };
  return async (to) => {
    const from = new Date(to.getTime() - WINDOW_MS);
    const base = (repo: { owner: string; name: string }) =>
      `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
    return {
      ciRedMinutes: await guard(async () => {
        const repo = await selfRepo();
        const items = await w.client.all(
          {
            method: 'GET',
            path: `${base(repo)}/actions/workflows/ci.yml/runs`,
            auth: { as: 'engine', repo },
            query: {
              branch: 'main',
              event: 'push',
              status: 'completed',
              created: `>=${from.toISOString()}`,
              per_page: 100,
            },
          },
          (data) => {
            const runs = (data as { workflow_runs?: unknown } | null)?.workflow_runs;
            if (!Array.isArray(runs)) return notRead('ci.yml 运行列表认不出（没有 workflow_runs）');
            return runs;
          },
        );
        return ciRedMinutes(items.map(parseRunEnd), from, to);
      }, '读主线 CI 红了多久'),
      selfDefects: await guard(async () => {
        const repo = await selfRepo();
        const items = await w.client.all({
          method: 'GET',
          path: `${base(repo)}/issues`,
          auth: { as: 'engine', repo },
          query: { state: 'all', labels: DEFECT_LABEL, since: from.toISOString(), per_page: 100 },
        });
        return countMachineDefects(items, from, to);
      }, '读机器开的自身缺陷单'),
      offReasonDecisions: await guard(() => offReasonDecisionCount(w.db, to), '读拍板卡的原因'),
    };
  };
}
