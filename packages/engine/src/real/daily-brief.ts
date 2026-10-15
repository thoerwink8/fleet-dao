// 每日简报（jobs/daily-brief.ts）的真装配：发布历史读发布目录的 .history，提交比较走引擎机器人的 GitHub（releaseFacts.compare），
// 库里读 PR、提醒、停下的单和 pnpm line:stats 同一条查询；简报写成一行提醒（驾驶舱后端推飞书），#1055 的评论走引擎机器人的 commentIssue。
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type Db,
  executorLineStats,
  finishScheduleRun,
  openBriefNotes,
  pullsByMergeSha,
  repoByName,
  resolveAlertWithReason,
  startScheduleRun,
  stoppedTasksBetween,
  upsertAlert,
} from '@fleet-dao/db';
import type { GitHub } from '@fleet-dao/github';
import type { DailyBriefDeps } from '../jobs/daily-brief.ts';
import { RELEASES_DIR } from './release-evidence.ts';

/** fleet-dao 自己这个仓：在受管的仓里按名字认（和驾驶舱 self-repo.ts 同一个认法），owner 不写死。 */
export const SELF_REPO_NAME = 'fleet-dao';

export function dailyBriefJob(w: {
  db: Db;
  gh: Pick<GitHub, 'releaseFacts' | 'commentIssue' | 'readIssue'>;
  releasesDir?: string;
  now?: () => Date;
  log?: DailyBriefDeps['log'];
}): () => DailyBriefDeps {
  const now = w.now ?? (() => new Date());
  const log: DailyBriefDeps['log'] =
    w.log ?? ((level, text, fields) => console[level === 'info' ? 'info' : level](text, fields ?? {}));
  const dir = w.releasesDir ?? RELEASES_DIR;
  return () => ({
    async history() {
      try {
        return await readFile(join(dir, '.history'), 'utf8');
      } catch (e) {
        if ((e as { code?: unknown }).code === 'ENOENT') return null;
        throw e;
      }
    },
    async selfRepo() {
      const repo = await repoByName(w.db, SELF_REPO_NAME);
      if (!repo) throw new Error(`受管的仓里没有 ${SELF_REPO_NAME}`);
      return repo;
    },
    compare: (repo, base, head) => w.gh.releaseFacts.compare(repo, base, head),
    pulls: (repoId, shas) => pullsByMergeSha(w.db, repoId, shas),
    issueTitle: async (repo, issueNumber) => (await w.gh.readIssue({ repo, issueNumber })).title,
    decisions: () => openBriefNotes(w.db, 'decision'),
    alerts: () => openBriefNotes(w.db, 'alert'),
    dailies: () => openBriefNotes(w.db, 'daily'),
    stopped: (from, to) => stoppedTasksBetween(w.db, from, to),
    lineStats: (at) => executorLineStats(w.db, at),
    async publish(x) {
      await upsertAlert(w.db, { ...x, level: 'daily', taskId: null });
    },
    async comment(x) {
      const r = await w.gh.commentIssue(x);
      return { url: r.url };
    },
    resolveDaily: (input) => resolveAlertWithReason(w.db, input),
    runs: {
      start: (job, at) => startScheduleRun(w.db, job, at),
      finish: (id, result, at) => finishScheduleRun(w.db, id, result, at),
    },
    now,
    log,
  });
}
