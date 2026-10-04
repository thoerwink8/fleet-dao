// 欠账检查、GitHub 对账、pnpm plan 要读 GitHub 上 issue、里程碑、母子单现在的样子，欠账检查和对账还往单上留言；
// 发起发布（publish-pr 读当前版本里程碑）、发布收尾（release.yml 查发布 PR 的合并时间、关里程碑）也走这里：都是 REST 接口。
// 必过检查（pnpm check）不许用这里（#87：同一份代码什么时候跑结果都一样）。
// 令牌按 GITHUB_TOKEN → GH_TOKEN → 本机 `gh auth token` 的顺序找，都没有就不带（公开仓不带令牌也读得到，
// 只是每小时 60 次）。令牌只放进请求头，报错里不带。读不到、认不出一律抛，由调用方判「没查成」，不当成没问题。
import { execFileSync } from 'node:child_process';

export interface IssueInfo {
  number: number;
  title: string;
  state: 'open' | 'closed';
  /** 这个号其实是 PR（issue 和 PR 共用一套号）。 */
  isPr: boolean;
  /** ISO 时间。 */
  createdAt: string;
  labels: string[];
  milestone: string | null;
  /** 正文（接口带着就有；没带的是 undefined，不拿空串顶）。 */
  body?: string;
}

export interface MilestoneInfo {
  number: number;
  title: string;
  state: 'open' | 'closed';
}

/** 一张单：比 IssueInfo 多关单原因和母子单关系（GitHub 自带的子议题）。 */
export interface PlanIssue extends IssueInfo {
  /** 关单原因（completed、not_planned、duplicate…）；开着的、没写原因的是 null。 */
  stateReason: string | null;
  /** GitHub 记着的子单数（sub_issues_summary.total）；接口没给是 undefined。 */
  subIssues: number | undefined;
  /** 其中已经关了的（sub_issues_summary.completed）；接口没给是 undefined。 */
  subIssuesDone?: number | undefined;
  /** 母单的号（parent_issue_url）；没有母单是 undefined。 */
  parent?: number | undefined;
}

/** 带说明的里程碑：版本里的先后写在说明里（#169 第 5 件）。 */
export interface MilestoneDetail extends MilestoneInfo {
  /** 说明原文；空的是 ''。 */
  description: string;
  /** 关掉的时间（ISO）；开着的是 null。 */
  closedAt: string | null;
}

export interface GitHubReader {
  /** 开着的 issue（不含 PR）。 */
  openIssues(): Promise<PlanIssue[]>;
  /** 这个号现在的样子；没有这个号（404、410）返回 undefined。 */
  issue(n: number): Promise<PlanIssue | undefined>;
  /** 所有里程碑（开着的、关了的），带说明。 */
  milestones(): Promise<MilestoneDetail[]>;
  /** 这个里程碑里的 issue，开着的、关了的都要（不含 PR）。 */
  milestoneIssues(milestone: number): Promise<PlanIssue[]>;
  /** 这张单的子单（GitHub 自带的子议题），按母单页面上排的先后。 */
  subIssues(n: number): Promise<PlanIssue[]>;
}

/** 欠账检查、对账往单上留言用（要能写 issue 的令牌）。 */
export interface GitHubCommenter {
  /** 这张单上所有留言的正文。 */
  comments(n: number): Promise<string[]>;
  comment(n: number, body: string): Promise<void>;
}

/** 一张已经合并的 PR：号、合并的时间（ISO）、合进主线的那个提交（squash / merge / rebase 都是 GitHub 给的 merge_commit_sha）。 */
export interface MergedPull {
  number: number;
  mergedAt: string;
  mergeCommitSha: string;
}

/** 一份 GitHub Release（发布收尾只用到这几样）。 */
export interface GitHubRelease {
  id: number;
  tagName: string;
  /** 正文原文；GitHub 回 null 的当空串。 */
  body: string;
}

/**
 * 发布收尾（release.yml，编排在 release-finalize.ts）用：令牌要能写 contents（tag、release）和 issues（里程碑）。
 * 「不在」一律回 undefined（只认 404），别的失败都抛——读挂了不能当「不在」接着建（会重复或覆盖）。
 */
export interface GitHubReleaser {
  /** head 是本仓这个分支、已经合并了的 PR，照 GitHub 回的先后（新开的在前）。 */
  mergedPulls(head: string): Promise<MergedPull[]>;
  /** 关掉这个里程碑，回 GitHub 关完之后的那一份（PATCH 的回包，调用方拿它核是不是真关了）。 */
  closeMilestone(n: number): Promise<MilestoneDetail>;
  /** 这个 tag 最终指的提交（附注 tag 剥到底）；没有这个 tag 回 undefined。 */
  tagCommit(tag: string): Promise<string | undefined>;
  /** 在这个提交上打附注 tag（先建 tag 对象、再建 refs/tags/<tag>）；ref 已经有了照样抛，由调用方重读再判。 */
  createTag(tag: string, sha: string, message: string): Promise<void>;
  /** 挂在这个 tag 上的 Release（已发布的）；没有回 undefined。 */
  release(tag: string): Promise<GitHubRelease | undefined>;
  createRelease(tag: string, name: string, body: string): Promise<GitHubRelease>;
  updateReleaseBody(id: number, body: string): Promise<GitHubRelease>;
  /** 这个提交上某个文件的原文；文件不在回 undefined。 */
  fileAt(path: string, ref: string): Promise<string | undefined>;
}

/** 远端的一条分支。 */
export interface RemoteBranch {
  name: string;
  /** 分支头（40 位）。 */
  sha: string;
  protected: boolean;
}

/** 一个 PR 的头和目标分支（分支体检判「有没有开着的 PR」「合并时的头是不是现在的头」用）。 */
export interface PullHead {
  number: number;
  state: 'open' | 'closed';
  /** 合并过（merged_at 有值）。 */
  merged: boolean;
  headRef: string;
  /** 合并的、关掉的 PR，这是它最后的头（GitHub 留在 refs/pull/N/head）。 */
  headSha: string;
  /** 头分支所在的仓（owner/名字）；fork 被删了是 null。 */
  headRepo: string | null;
  baseRef: string;
}

/** 一张开着的单或 PR：标题、正文、评论（分支体检查「有没有被提到」用）、谁开的（认巡检单用）。 */
export interface OpenThread {
  number: number;
  isPr: boolean;
  title: string;
  body: string;
  comments: string[];
  /** 开单的人（login）；账号没了是 null。 */
  author: string | null;
  /** 开单的人和仓的关系（OWNER、MEMBER、COLLABORATOR、CONTRIBUTOR、NONE…）。 */
  association: string;
}

/** GitHub 动态记录里一条分支的一次推送、新建、删除（/activity）。 */
export interface BranchActivity {
  /** ISO 时间。 */
  timestamp: string;
  /** push、force_push、branch_creation、branch_deletion、pr_merge…… */
  type: string;
  /** 谁干的（login）；账号没了是 null。 */
  actor: string | null;
}

/** 分支体检（#769）读写 GitHub：列分支和 PR、读开着的单和评论、读动态、删分支、维护巡检单。 */
export interface GitHubBranches {
  /** 仓的默认分支名。 */
  defaultBranch(): Promise<string>;
  branches(): Promise<RemoteBranch[]>;
  /** 开着的 PR（fork 来的也在内）。 */
  openPulls(): Promise<PullHead[]>;
  /**
   * 头是本仓这条分支的 PR（开着的、关了的、合了的）。按分支查，不一次列全部 PR：全部 PR 一天几十个地涨，
   * 几个月就翻过 50 页的上限，整轮就读不成了。
   */
  pullsForHead(branch: string): Promise<PullHead[]>;
  /** 开着的单和开着的 PR，带标题、正文和全部评论。 */
  openThreads(): Promise<OpenThread[]>;
  /** 这条分支最近的动态（新的在前，最多 100 条）；没有记录是空列表。 */
  activity(branch: string): Promise<BranchActivity[]>;
  /** 这条分支现在的头；分支不在了回 undefined。 */
  branchHead(branch: string): Promise<string | undefined>;
  /** 删这条分支；回 false = 删的时候它已经不在了。 */
  deleteBranch(branch: string): Promise<boolean>;
  /** 开一张单，回号。 */
  createIssue(title: string, body: string, labels: string[]): Promise<number>;
  /** 改一张单的正文。 */
  updateIssueBody(n: number, body: string): Promise<void>;
}

type Env = Record<string, string | undefined>;

/** 仓名：GITHUB_REPOSITORY（Actions 里有），没有就从 origin 的地址认。认不出返回 undefined。 */
export function repoName(env: Env, root: string, git = gitOrigin): string | undefined {
  const fromEnv = env.GITHUB_REPOSITORY?.trim();
  if (fromEnv) return /^[\w.-]+\/[\w.-]+$/.test(fromEnv) ? fromEnv : undefined;
  const url = git(root);
  const m = url && /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m?.[1];
}

function gitOrigin(root: string): string | undefined {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
  } catch {
    return undefined;
  }
}

function ghToken(): string | undefined {
  try {
    const t = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
      windowsHide: true,
    }).trim();
    return t || undefined;
  } catch {
    return undefined;
  }
}

/** 读 GitHub 用的令牌：GITHUB_TOKEN → GH_TOKEN → 本机 `gh auth token`；都没有是 undefined（没登录）。 */
export function githubToken(env: Env, gh: () => string | undefined = ghToken): string | undefined {
  return env.GITHUB_TOKEN || env.GH_TOKEN || gh() || undefined;
}

export function liveGitHub(
  repo: string,
  env: Env,
  opts: { fetchImpl?: typeof fetch; token?: () => string | undefined } = {},
): GitHubReader & GitHubCommenter & GitHubReleaser & GitHubBranches {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const api = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
  let token: string | undefined | null = null;
  const auth = () => {
    if (token === null) token = githubToken(env, opts.token ?? ghToken);
    return token;
  };

  const get = async (path: string, init: { method?: string; body?: string } = {}): Promise<Response> => {
    const t = auth();
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'fleet-dao-conventions',
    };
    if (t) headers.authorization = `Bearer ${t}`;
    let res: Response;
    try {
      res = await fetchImpl(path.startsWith('http') ? path : `${api}${path}`, {
        ...init,
        headers: init.body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      throw new Error(`连不上 GitHub（${message(e)}）`);
    }
    return res;
  };

  const failed = (res: Response, what: string): Error => {
    const limited = res.status === 403 || res.status === 429;
    const hint =
      limited && res.headers.get('x-ratelimit-remaining') === '0'
        ? auth()
          ? '：被限流了'
          : '：被限流了（没带令牌时每小时 60 次；设 GITHUB_TOKEN，或本机 gh auth login）'
        : '';
    return new Error(`${what.startsWith('在') ? what : `读${what}`}，GitHub 回了 ${res.status}${hint}`);
  };

  /** 逐页读完（按 Link 头的 next）。 */
  const pages = async (path: string, what: string): Promise<unknown[]> => {
    const all: unknown[] = [];
    let next: string | undefined = path;
    for (let i = 0; next; i++) {
      if (i >= 50) throw new Error(`读${what}翻了 50 页还没完，不当成读完了`);
      const res = await get(next);
      if (!res.ok) throw failed(res, what);
      const data = await json(res, what);
      if (!Array.isArray(data)) throw new Error(`读${what}，读回来的不是列表`);
      all.push(...data);
      next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1];
    }
    return all;
  };

  const readComments = async (n: number): Promise<string[]> => {
    const rows = await pages(`/repos/${repo}/issues/${n}/comments?per_page=100`, ` #${n} 的留言`);
    return rows.map((r) => {
      if (!isObject(r) || typeof r.body !== 'string')
        throw new Error(`读 #${n} 的留言，有一条认不出（body）`);
      return r.body;
    });
  };

  const branchHead = async (branch: string): Promise<string | undefined> => {
    const what = ` ${branch} 的分支头`;
    const res = await get(`/repos/${repo}/git/ref/heads/${encRef(branch)}`);
    if (res.status === 404) return undefined;
    if (!res.ok) throw failed(res, what);
    const data = await json(res, what);
    const sha = isObject(data) && isObject(data.object) ? data.object.sha : undefined;
    if (typeof sha !== 'string' || !SHA.test(sha)) throw new Error(`读${what}，认不出（object.sha）`);
    return sha;
  };

  return {
    async openIssues() {
      const rows = await pages(`/repos/${repo}/issues?state=open&per_page=100`, '开着的 issue');
      return rows.map((r) => toPlanIssue(r, '开着的 issue')).filter((i) => !i.isPr);
    },
    async issue(n) {
      const res = await get(`/repos/${repo}/issues/${n}`);
      if (res.status === 404 || res.status === 410) return undefined;
      if (!res.ok) throw failed(res, ` #${n} `);
      return toPlanIssue(await json(res, ` #${n} `), ` #${n} `);
    },
    async milestones() {
      const rows = await pages(`/repos/${repo}/milestones?state=all&per_page=100`, '里程碑');
      return rows.map(toMilestoneDetail);
    },
    async milestoneIssues(milestone) {
      const what = '里程碑里的单';
      const rows = await pages(`/repos/${repo}/issues?milestone=${milestone}&state=all&per_page=100`, what);
      return rows.map((r) => toPlanIssue(r, what)).filter((i) => !i.isPr);
    },
    async subIssues(n) {
      const what = ` #${n} 的子单`;
      const rows = await pages(`/repos/${repo}/issues/${n}/sub_issues?per_page=100`, what);
      return rows.map((r) => toPlanIssue(r, what));
    },
    comments: readComments,
    async comment(n, body) {
      const res = await get(`/repos/${repo}/issues/${n}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      });
      if (res.status !== 201) throw failed(res, `在 #${n} 上留言`);
    },
    async mergedPulls(head) {
      const owner = repo.split('/')[0];
      const what = ` head 是 ${head} 的 PR`;
      const rows = await pages(`/repos/${repo}/pulls?state=closed&head=${owner}:${head}&per_page=100`, what);
      const merged: MergedPull[] = [];
      for (const r of rows) {
        if (!isObject(r) || typeof r.number !== 'number')
          throw new Error(`读${what}，有一条认不出（number）`);
        // merged_at 整个不在、或不是时间：认不出就抛，不当成「没合并」（那会把这张发布 PR 漏掉）。
        if (!('merged_at' in r) || (r.merged_at !== null && !isTime(r.merged_at))) {
          throw new Error(`读${what}，有一条认不出（merged_at）`);
        }
        if (typeof r.merged_at !== 'string') continue;
        // 合并了的一定有 merge_commit_sha；没有、认不出就抛，不拿空串去打 tag。
        if (typeof r.merge_commit_sha !== 'string' || !SHA.test(r.merge_commit_sha)) {
          throw new Error(`读${what}，#${r.number} 认不出（merge_commit_sha）`);
        }
        merged.push({ number: r.number, mergedAt: r.merged_at, mergeCommitSha: r.merge_commit_sha });
      }
      return merged;
    },
    async tagCommit(tag) {
      const what = ` tag ${tag}`;
      const res = await get(`/repos/${repo}/git/ref/tags/${encRef(tag)}`);
      if (res.status === 404) return undefined;
      if (!res.ok) throw failed(res, what);
      let obj = gitObject(await json(res, what), what);
      // 附注 tag 指的是 tag 对象，要再剥一层；tag 指 tag 的套娃最多剥 5 层，再多当认不出。
      for (let i = 0; obj.type === 'tag'; i++) {
        if (i >= 5) throw new Error(`读${what}，tag 套了 5 层还没到提交，认不出`);
        const r = await get(`/repos/${repo}/git/tags/${obj.sha}`);
        if (!r.ok) throw failed(r, `${what} 的 tag 对象`);
        obj = gitObject(await json(r, `${what} 的 tag 对象`), `${what} 的 tag 对象`);
      }
      if (obj.type !== 'commit') throw new Error(`读${what}，它指的不是提交（${obj.type}）`);
      return obj.sha;
    },
    async createTag(tag, sha, message) {
      const res = await get(`/repos/${repo}/git/tags`, {
        method: 'POST',
        body: JSON.stringify({ tag, message, object: sha, type: 'commit' }),
      });
      if (res.status !== 201) throw failed(res, `在建 tag 对象 ${tag} 时`);
      const data = await json(res, `建 tag 对象 ${tag} 的回包`);
      const objSha = isObject(data) ? data.sha : undefined;
      if (typeof objSha !== 'string' || !SHA.test(objSha))
        throw new Error(`读建 tag 对象 ${tag} 的回包，认不出（sha）`);
      const ref = await get(`/repos/${repo}/git/refs`, {
        method: 'POST',
        body: JSON.stringify({ ref: `refs/tags/${tag}`, sha: objSha }),
      });
      if (ref.status !== 201) throw failed(ref, `在建 refs/tags/${tag} 时`);
    },
    async release(tag) {
      const what = ` ${tag} 的 Release`;
      const res = await get(`/repos/${repo}/releases/tags/${encRef(tag)}`);
      if (res.status === 404) return undefined;
      if (!res.ok) throw failed(res, what);
      return toRelease(await json(res, what), what);
    },
    async createRelease(tag, name, body) {
      const res = await get(`/repos/${repo}/releases`, {
        method: 'POST',
        body: JSON.stringify({ tag_name: tag, name, body, draft: false, prerelease: false }),
      });
      if (res.status !== 201) throw failed(res, `在建 ${tag} 的 Release 时`);
      return toRelease(await json(res, `建 ${tag} 的 Release 的回包`), `建 ${tag} 的 Release 的回包`);
    },
    async updateReleaseBody(id, body) {
      const res = await get(`/repos/${repo}/releases/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ body }),
      });
      if (!res.ok) throw failed(res, `在改 Release #${id} 的正文时`);
      return toRelease(await json(res, `改 Release #${id} 的回包`), `改 Release #${id} 的回包`);
    },
    async fileAt(path, ref) {
      const what = ` ${path}（${ref.slice(0, 7)}）`;
      const res = await get(`/repos/${repo}/contents/${encRef(path)}?ref=${encodeURIComponent(ref)}`);
      if (res.status === 404) return undefined;
      if (!res.ok) throw failed(res, what);
      const data = await json(res, what);
      if (
        !isObject(data) ||
        data.type !== 'file' ||
        data.encoding !== 'base64' ||
        typeof data.content !== 'string'
      ) {
        throw new Error(`读${what}，认不出（不是 base64 的文件；超过 1MB 的文件 GitHub 不给内容）`);
      }
      return Buffer.from(data.content, 'base64').toString('utf8');
    },
    async closeMilestone(n) {
      const res = await get(`/repos/${repo}/milestones/${n}`, {
        method: 'PATCH',
        body: JSON.stringify({ state: 'closed' }),
      });
      if (!res.ok) throw failed(res, `在关里程碑 #${n} 时`);
      return toMilestoneDetail(await json(res, `关里程碑 #${n} 的回包`));
    },
    async defaultBranch() {
      const res = await get(`/repos/${repo}`);
      if (!res.ok) throw failed(res, '仓的设置');
      const data = await json(res, '仓的设置');
      if (!isObject(data) || typeof data.default_branch !== 'string' || !data.default_branch) {
        throw new Error('读仓的设置，认不出（default_branch）');
      }
      return data.default_branch;
    },
    async branches() {
      const what = '远端分支';
      const rows = await pages(`/repos/${repo}/branches?per_page=100`, what);
      return rows.map((r) => {
        if (!isObject(r) || typeof r.name !== 'string' || !r.name)
          throw new Error(`读${what}，有一条认不出（name）`);
        const sha = isObject(r.commit) ? r.commit.sha : undefined;
        if (typeof sha !== 'string' || !SHA.test(sha))
          throw new Error(`读${what}，${r.name} 认不出（commit.sha）`);
        if (typeof r.protected !== 'boolean') throw new Error(`读${what}，${r.name} 认不出（protected）`);
        return { name: r.name, sha, protected: r.protected };
      });
    },
    async openPulls() {
      const rows = await pages(`/repos/${repo}/pulls?state=open&per_page=100`, '开着的 PR');
      return rows.map((r) => toPullHead(r, '开着的 PR'));
    },
    async pullsForHead(branch) {
      const owner = repo.split('/')[0];
      const what = ` ${branch} 的 PR`;
      const rows = await pages(
        `/repos/${repo}/pulls?state=all&head=${owner}:${encodeURIComponent(branch)}&per_page=100`,
        what,
      );
      const found = rows.map((r) => toPullHead(r, what));
      // head 过滤要是被 GitHub 忽略了（参数写错、接口变了），回来的就是别的分支的 PR：认不出，不拿它判
      if (found.some((p) => p.headRef !== branch)) throw new Error(`读${what}，回来的 PR 头不是这条分支`);
      return found;
    },
    async openThreads() {
      const what = '开着的单和 PR';
      const rows = await pages(`/repos/${repo}/issues?state=open&per_page=100`, what);
      const threads: OpenThread[] = [];
      for (const r of rows) {
        const i = toIssue(r, what);
        if (i.body === undefined) throw new Error(`读${what}，#${i.number} 认不出（body）`);
        // 接口给了评论数且是 0 就不再去读（省一次请求）；给的不是数就照读，不猜。
        const count = isObject(r) && typeof r.comments === 'number' ? r.comments : undefined;
        // 开单的人认不出就抛：巡检单只认仓里的人或 Actions 开的，猜错了就会照外人写的勾删分支
        const user = isObject(r) ? r.user : undefined;
        const author =
          user === null ? null : isObject(user) && typeof user.login === 'string' ? user.login : undefined;
        const association = isObject(r) ? r.author_association : undefined;
        if (author === undefined || typeof association !== 'string') {
          throw new Error(`读${what}，#${i.number} 认不出（user、author_association）`);
        }
        const comments = count === 0 ? [] : await readComments(i.number);
        threads.push({
          number: i.number,
          isPr: i.isPr,
          title: i.title,
          body: i.body,
          comments,
          author,
          association,
        });
      }
      return threads;
    },
    async activity(branch) {
      const what = ` ${branch} 的动态`;
      const ref = encodeURIComponent(`refs/heads/${branch}`);
      const res = await get(`/repos/${repo}/activity?ref=${ref}&per_page=100`);
      if (!res.ok) throw failed(res, what);
      const data = await json(res, what);
      if (!Array.isArray(data)) throw new Error(`读${what}，读回来的不是列表`);
      return data.map((r) => {
        if (!isObject(r) || !isTime(r.timestamp) || typeof r.activity_type !== 'string') {
          throw new Error(`读${what}，有一条认不出（timestamp、activity_type）`);
        }
        const actor =
          r.actor === null
            ? null
            : isObject(r.actor) && typeof r.actor.login === 'string'
              ? r.actor.login
              : undefined;
        if (actor === undefined) throw new Error(`读${what}，有一条认不出（actor）`);
        return { timestamp: r.timestamp, type: r.activity_type, actor };
      });
    },
    branchHead,
    async deleteBranch(branch) {
      const res = await get(`/repos/${repo}/git/refs/heads/${encRef(branch)}`, { method: 'DELETE' });
      if (res.status === 204) return true;
      if (res.status === 404) return false;
      // 422 也可能是「不让删」（规则集挡着）：回读一下，真不在了才算「本来就没了」，还在就照报没删成。
      if (res.status === 422 && (await branchHead(branch)) === undefined) return false;
      throw failed(res, `在删分支 ${branch} 时`);
    },
    async createIssue(title, body, labels) {
      const res = await get(`/repos/${repo}/issues`, {
        method: 'POST',
        body: JSON.stringify({ title, body, labels }),
      });
      if (res.status !== 201) throw failed(res, '在开单时');
      const data = await json(res, '开单的回包');
      if (!isObject(data) || typeof data.number !== 'number')
        throw new Error('读开单的回包，认不出（number）');
      return data.number;
    },
    async updateIssueBody(n, body) {
      const res = await get(`/repos/${repo}/issues/${n}`, {
        method: 'PATCH',
        body: JSON.stringify({ body }),
      });
      if (!res.ok) throw failed(res, `在改 #${n} 的正文时`);
    },
  };
}

const SHA = /^[0-9a-f]{40}$/;

/** git 引用、tag 对象回包里的 object：{ type, sha }；认不出就抛。 */
function gitObject(raw: unknown, what: string): { type: string; sha: string } {
  const obj = isObject(raw) ? raw.object : undefined;
  if (!isObject(obj) || typeof obj.type !== 'string' || typeof obj.sha !== 'string' || !SHA.test(obj.sha)) {
    throw new Error(`读${what}，认不出（object）`);
  }
  return { type: obj.type, sha: obj.sha };
}

/** 接口回来的一份 Release；缺字段就抛。body 只有明确的 null 当空串。 */
function toRelease(raw: unknown, what: string): GitHubRelease {
  const bad = (field: string) => new Error(`读${what}，认不出（${field}）`);
  if (!isObject(raw)) throw bad('不是对象');
  if (typeof raw.id !== 'number') throw bad('id');
  if (typeof raw.tag_name !== 'string') throw bad('tag_name');
  if (!('body' in raw) || (raw.body !== null && typeof raw.body !== 'string')) throw bad('body');
  return { id: raw.id, tagName: raw.tag_name, body: typeof raw.body === 'string' ? raw.body : '' };
}

/** 分支名放进网址：按 / 分段各自转义（分支名里可以有 /）。 */
function encRef(branch: string): string {
  return branch.split('/').map(encodeURIComponent).join('/');
}

/** 接口回来的一个 PR，只取头、目标分支和状态；缺字段、认不出就抛，不猜（漏认一个开着的 PR 会把它的分支删掉）。 */
export function toPullHead(raw: unknown, what = 'PR'): PullHead {
  const bad = (field: string) => new Error(`读${what}，有一条认不出（${field}）`);
  if (!isObject(raw)) throw bad('不是对象');
  const { number, state, merged_at, head, base } = raw;
  if (typeof number !== 'number') throw bad('number');
  if (state !== 'open' && state !== 'closed') throw bad(`#${number} 的 state`);
  if (!('merged_at' in raw) || (merged_at !== null && !isTime(merged_at)))
    throw bad(`#${number} 的 merged_at`);
  if (
    !isObject(head) ||
    typeof head.ref !== 'string' ||
    typeof head.sha !== 'string' ||
    !SHA.test(head.sha)
  ) {
    throw bad(`#${number} 的 head`);
  }
  const headRepo =
    head.repo === null
      ? null
      : isObject(head.repo) && typeof head.repo.full_name === 'string'
        ? head.repo.full_name
        : undefined;
  if (headRepo === undefined) throw bad(`#${number} 的 head.repo`);
  if (!isObject(base) || typeof base.ref !== 'string') throw bad(`#${number} 的 base`);
  return {
    number,
    state,
    merged: merged_at !== null,
    headRef: head.ref,
    headSha: head.sha,
    headRepo,
    baseRef: base.ref,
  };
}

async function json(res: Response, what: string): Promise<unknown> {
  try {
    return await res.json();
  } catch (e) {
    throw new Error(`读${what}，读回来的不是 JSON（${message(e)}）`);
  }
}

/** 接口回来的一条 issue；缺字段就抛，不猜。 */
export function toIssue(raw: unknown, what = 'issue'): IssueInfo {
  const bad = (field: string) => new Error(`读${what}，有一条认不出（${field}）`);
  if (!isObject(raw)) throw bad('不是对象');
  const { number, title, state, created_at, labels, milestone, pull_request, body } = raw;
  if (typeof number !== 'number') throw bad('number');
  if (typeof title !== 'string') throw bad('title');
  if (state !== 'open' && state !== 'closed') throw bad('state');
  if (typeof created_at !== 'string') throw bad('created_at');
  if (!Array.isArray(labels) || !labels.every((l) => isObject(l) && typeof l.name === 'string')) {
    throw bad('labels');
  }
  if (milestone !== null && !(isObject(milestone) && typeof milestone.title === 'string')) {
    throw bad('milestone');
  }
  if (body !== undefined && body !== null && typeof body !== 'string') throw bad('body');
  return {
    number,
    title,
    state,
    isPr: pull_request !== undefined && pull_request !== null,
    createdAt: created_at,
    labels: labels.map((l) => String((l as { name: string }).name)),
    milestone: milestone === null ? null : String((milestone as { title: string }).title),
    ...(typeof body === 'string' ? { body } : body === null ? { body: '' } : {}),
  };
}

function toMilestone(raw: unknown): MilestoneInfo {
  if (
    !isObject(raw) ||
    typeof raw.number !== 'number' ||
    typeof raw.title !== 'string' ||
    (raw.state !== 'open' && raw.state !== 'closed')
  ) {
    throw new Error('读里程碑，有一条认不出');
  }
  return { number: raw.number, title: raw.title, state: raw.state };
}

/**
 * 接口回来的一个里程碑，带说明和关掉的时间；缺字段就抛，不猜。
 *
 * 两个字段都不是「可有可无」：`description` 缺了会变成「说明里没有先后标记」，被对账当成真断裂（退出码 1，
 * 留言到单上让人去改 GitHub）；`closed_at` 缺了会变成「这是个还开着的版本」。这两种都是接口没给，不是仓里真错了，
 * 要的是「没查成」（退出码 2）。所以只有明确的 `null`（GitHub 自己的「没有说明」/「还没关」）才当空，
 * 字段整个不在就抛出来；`closed_at` 缺失只有一种可能——上游没给，同样抛。
 */
export function toMilestoneDetail(raw: unknown): MilestoneDetail {
  const base = toMilestone(raw);
  const has = (k: string) => isObject(raw) && k in raw;
  const { description, closed_at } = raw as Record<string, unknown>;
  const bad = (field: string) => new Error(`读里程碑「${base.title}」，认不出（${field}）`);
  if (!has('description') || (description !== null && typeof description !== 'string')) {
    throw bad('description');
  }
  if (!has('closed_at') || (closed_at !== null && !isTime(closed_at))) throw bad('closed_at');
  return {
    ...base,
    description: description === null ? '' : (description as string),
    closedAt: closed_at === null ? null : (closed_at as string),
  };
}

/** 接口回来的一张单，外加关单原因、子单数、已关的子单数、母单号；缺字段、认不出就抛，不猜。 */
export function toPlanIssue(raw: unknown, what = 'issue'): PlanIssue {
  const base = toIssue(raw, what);
  const { state_reason, sub_issues_summary, parent_issue_url } = raw as Record<string, unknown>;
  const bad = (field: string) => new Error(`读${what}，有一条认不出（${field}）`);
  if (state_reason !== null && state_reason !== undefined && typeof state_reason !== 'string') {
    throw bad('state_reason');
  }
  let subIssues: number | undefined;
  let subIssuesDone: number | undefined;
  if (sub_issues_summary !== null && sub_issues_summary !== undefined) {
    const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined);
    const summary = isObject(sub_issues_summary) ? sub_issues_summary : {};
    subIssues = count(summary.total);
    subIssuesDone = count(summary.completed);
    if (subIssues === undefined || subIssuesDone === undefined || subIssuesDone > subIssues) {
      throw bad('sub_issues_summary');
    }
  }
  let parent: number | undefined;
  if (parent_issue_url !== null && parent_issue_url !== undefined) {
    const m = typeof parent_issue_url === 'string' ? /\/issues\/(\d+)$/.exec(parent_issue_url) : null;
    if (!m?.[1]) throw bad('parent_issue_url');
    parent = Number(m[1]);
  }
  return {
    ...base,
    stateReason: typeof state_reason === 'string' ? state_reason : null,
    subIssues,
    subIssuesDone,
    parent,
  };
}

function isTime(v: unknown): v is string {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function message(e: unknown): string {
  const cause = e instanceof Error && isObject(e.cause) ? e.cause.code : undefined;
  const text = e instanceof Error ? e.message : String(e);
  return typeof cause === 'string' ? `${text}：${cause}` : text;
}
