// 「认领对得上」那一侧的假 GitHub（@fleet-dao/github 的 ClaimsGitHub）：内存里的 PR、提交状态、评论，记下每次写。
// 真的 HTTP 那层（权限、翻页、GraphQL）在 packages/github 的 claims.test.ts 里对着假服务器测。
import { ENGINE_BOT_LOGIN } from '@fleet-dao/conventions';
import type { ClaimsGitHub, CommitStatusInput, LatestStatus, PullFacts } from '@fleet-dao/github';

/** 「干活的」机器人（引擎开 PR 用的那个）。 */
export const AGENT_BOT = { login: 'fleet-dao-agent[bot]', id: 7, type: 'Bot' } as const;
export const HUMAN = { login: 'someone', id: 8, type: 'User' } as const;

export interface FakeStatus extends CommitStatusInput {
  sha: string;
  byEngine: boolean;
}

export interface FakeClaimsGitHub extends ClaimsGitHub {
  pulls: Map<string, PullFacts>;
  statuses: FakeStatus[];
  comments: { repo: string; number: number; key: string; body: string }[];
  writes: string[];
  addPull(repo: string, pull: Partial<PullFacts> & { number: number }): PullFacts;
  /** 下一次这几样调用抛错（造「GitHub 出错」）。 */
  failNext: Partial<
    Record<'openPulls' | 'setStatus' | 'disableAutoMerge' | 'closePull' | 'readPull', string>
  >;
  /** 引擎登录名（改了造「身份对不上」）。 */
  login: string;
  /** 最新一条这个 PR 头上的「认领对得上」。 */
  latest(repo: string, number: number): FakeStatus | undefined;
}

const slug = (r: { owner: string; name: string }) => `${r.owner}/${r.name}`;

export function fakeClaimsGitHub(): FakeClaimsGitHub {
  const pulls = new Map<string, PullFacts>();
  const statuses: FakeStatus[] = [];
  const comments: FakeClaimsGitHub['comments'] = [];
  const writes: string[] = [];
  const failNext: FakeClaimsGitHub['failNext'] = {};
  const trip = (what: keyof FakeClaimsGitHub['failNext']) => {
    const why = failNext[what];
    if (why !== undefined) {
      delete failNext[what];
      throw new Error(why);
    }
  };
  const gh: FakeClaimsGitHub = {
    pulls,
    statuses,
    comments,
    writes,
    failNext,
    login: ENGINE_BOT_LOGIN,
    addPull(repo, p) {
      const pull: PullFacts = {
        nodeId: `PR_${p.number}`,
        state: 'open',
        merged: false,
        draft: false,
        title: `PR ${p.number}`,
        body: '',
        headSha: `sha${p.number}`,
        headRef: `branch-${p.number}`,
        fromFork: false,
        author: HUMAN,
        autoMerge: false,
        ...p,
      };
      pulls.set(`${repo}#${p.number}`, pull);
      return pull;
    },
    latest(repo, number) {
      const pull = pulls.get(`${repo}#${number}`);
      return pull && statuses.findLast((s) => s.sha === pull.headSha);
    },
    engineLogin: () => gh.login,
    isAgentBot: (u) => u?.login === AGENT_BOT.login,
    async readPull(repo, number) {
      trip('readPull');
      const p = pulls.get(`${slug(repo)}#${number}`);
      if (!p) throw new Error(`没有 PR #${number}`);
      return { ...p };
    },
    async openPulls(repo) {
      trip('openPulls');
      return [...pulls.entries()]
        .filter(([k, p]) => k.startsWith(`${slug(repo)}#`) && p.state === 'open')
        .map(([, p]) => ({ ...p }));
    },
    async latestStatus(_repo, sha, context): Promise<LatestStatus | null> {
      const s = statuses.findLast((x) => x.sha === sha && x.context === context);
      return s ? { state: s.state, description: s.description, byEngine: s.byEngine } : null;
    },
    async setStatus(repo, sha, status) {
      trip('setStatus');
      statuses.push({ ...status, sha, byEngine: true });
      writes.push(`status ${slug(repo)}@${sha} ${status.state}`);
    },
    async disableAutoMerge(repo, pull) {
      trip('disableAutoMerge');
      const p = pulls.get(`${slug(repo)}#${pull.number}`);
      if (p) p.autoMerge = false;
      writes.push(`disable ${slug(repo)}#${pull.number}`);
    },
    async closePull(repo, number) {
      trip('closePull');
      const p = pulls.get(`${slug(repo)}#${number}`);
      if (p) p.state = 'closed';
      writes.push(`close ${slug(repo)}#${number}`);
    },
    async commentPull(repo, number, key, body) {
      const url = `https://github.com/${slug(repo)}/pull/${number}`;
      const at = comments.findIndex((c) => c.key === key && c.number === number && c.repo === slug(repo));
      if (at >= 0) return { created: false, commentId: at + 1, url };
      comments.push({ repo: slug(repo), number, key, body });
      writes.push(`comment ${slug(repo)}#${number}`);
      return { created: true, commentId: comments.length, url };
    },
  };
  return gh;
}
