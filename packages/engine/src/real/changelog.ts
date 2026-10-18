// #3110：GitHub 用引擎机器人，发布历史只读 release.sh 的原账；不经过 Actions、不另存发布快照。
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CHANGELOG_FILE, toMilestoneDetail, toPlanIssue } from '@fleet-dao/conventions';
import { type Db, finishScheduleRun, startScheduleRun } from '@fleet-dao/db';
import { type GitHub, HYGIENE_REPO, type RepoRef } from '@fleet-dao/github';
import type { ChangelogGitHub, ChangelogJobDeps } from '../jobs/changelog.ts';
import { type CiTimingsApi, openManagedFilePr } from './ci-timings.ts';
import { RELEASES_DIR } from './release-evidence.ts';

export function changelogGitHub(api: CiTimingsApi): ChangelogGitHub {
  const repo = api.repo ?? HYGIENE_REPO;
  const base = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
  const auth = { as: 'engine' as const, repo };
  return {
    async readHead() {
      const read = await api.readRepoFile({ repo, path: CHANGELOG_FILE });
      if (read.file.kind !== 'text') throw new Error('主线 CHANGELOG.md 没读成');
      return { commit: read.commit, text: read.file.text };
    },
    async milestones() {
      // GitHub milestones 的 state=closed 也必须分页；不靠搜索索引判没有。
      const rows = await api.client.all({
        method: 'GET',
        path: `${base}/milestones`,
        auth,
        query: { state: 'closed', per_page: 100 },
      });
      return rows.map(toMilestoneDetail);
    },
    async milestoneIssues(number) {
      const rows = await api.client.all({
        method: 'GET',
        path: `${base}/issues`,
        auth,
        query: { milestone: number, state: 'all', per_page: 100 },
      });
      return rows.map((row) => toPlanIssue(row, `里程碑 #${number} 的单`)).filter((row) => !row.isPr);
    },
    openPr(input) {
      return openManagedFilePr(api, repo, {
        ...input,
        path: CHANGELOG_FILE,
        branch: `changelog/v${input.version}`,
        commitMessage: input.title,
        verifyOnlyFile: true,
      });
    },
  };
}

export function changelogJob(w: {
  db: Db;
  github: Pick<GitHub, 'client' | 'readRepoFile' | 'claims'>;
  repo?: RepoRef;
  releasesDir?: string;
  history?: () => Promise<string>;
  now?: () => Date;
  log?: ChangelogJobDeps['log'];
}): () => ChangelogJobDeps {
  const github = changelogGitHub({
    client: w.github.client,
    readRepoFile: w.github.readRepoFile,
    enableAutoMerge: (repo, pr) => w.github.claims.enableAutoMerge(repo, pr),
    ...(w.repo === undefined ? {} : { repo: w.repo }),
  });
  return () => ({
    github,
    history: w.history ?? (() => readFile(join(w.releasesDir ?? RELEASES_DIR, '.history'), 'utf8')),
    runs: {
      start: (job, at) => startScheduleRun(w.db, job, at),
      finish: (id, result, at) => finishScheduleRun(w.db, id, result, at),
    },
    now: w.now ?? (() => new Date()),
    log: w.log ?? ((level, message, fields) => console[level](message, fields ?? {})),
  });
}
