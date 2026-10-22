// 每日简报（jobs/daily-brief.ts）的真装配：发布历史读发布目录的 .history，提交比较走引擎机器人的 GitHub（releaseFacts.compare），
// 库里读 PR、提醒、停下的单和 pnpm line:stats 同一条查询；简报写成一行提醒（驾驶舱后端推飞书），#1055 的评论走引擎机器人的 commentIssue。
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  commanderStalledSummary,
  type Db,
  executorLineStats,
  finishScheduleRun,
  flowModeHealth,
  mainRedMinutes,
  offReasonDecisions,
  openBriefNotes,
  pipelineHealth,
  pullsByMergeSha,
  readSelfShare,
  releaseKilledSessions,
  repoByName,
  startScheduleRun,
  stoppedTasksBetween,
  upsertAlert,
  writeSelfShare,
} from '@fleet-dao/db';
import type { GitHub } from '@fleet-dao/github';
import type { DailyBriefDeps } from '../jobs/daily-brief.ts';
import { SELF_REPO_NAME } from '../jobs/self-share.ts';
import { RELEASES_DIR } from './release-evidence.ts';

export { SELF_REPO_NAME };

/** 写 engine.selfShare 时记的操作人。 */
const SELF_SHARE_ACTOR = 'engine:daily-brief';

export function dailyBriefJob(w: {
  db: Db;
  gh: Pick<GitHub, 'releaseFacts' | 'commentIssue' | 'readIssue' | 'readGroomFacts'>;
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
    stopped: (from, to) => stoppedTasksBetween(w.db, from, to),
    commanderSummary: () => commanderStalledSummary(w.db),
    lineStats: (at) => executorLineStats(w.db, at),
    pipelineHealth: (to) => pipelineHealth(w.db, to),
    releaseKills: (to) => releaseKilledSessions(w.db, to),
    flowModeHealth: (to) => flowModeHealth(w.db, to),
    selfShare: {
      mainRedMinutes: (to) => mainRedMinutes(w.db, to),
      // 只能数还开着的单（readGroomFacts 不读关了的）：开了又很快关掉的缺陷单这里数不到，数偏小
      async selfDefectIssues(from, to) {
        const repo = await repoByName(w.db, SELF_REPO_NAME);
        if (!repo) throw new Error(`受管的仓里没有 ${SELF_REPO_NAME}`);
        const facts = await w.gh.readGroomFacts({ repo: { owner: repo.owner, name: repo.name } });
        return facts.issues.filter((i) => {
          const created = Date.parse(i.createdAt);
          return (
            i.authorIsBot &&
            i.labels.includes('缺陷') &&
            !/e2e/i.test(i.title) &&
            created >= from.getTime() &&
            created < to.getTime()
          );
        }).length;
      },
      offReasonDecisions: () => offReasonDecisions(w.db),
      read: () => readSelfShare(w.db),
      write: (rec) => writeSelfShare(w.db, rec, SELF_SHARE_ACTOR),
    },
    async publish(x) {
      await upsertAlert(w.db, { ...x, level: 'daily', taskId: null });
    },
    async comment(x) {
      const r = await w.gh.commentIssue(x);
      return { url: r.url };
    },
    runs: {
      start: (job, at) => startScheduleRun(w.db, job, at),
      finish: (id, result, at) => finishScheduleRun(w.db, id, result, at),
    },
    now,
    log,
  });
}
