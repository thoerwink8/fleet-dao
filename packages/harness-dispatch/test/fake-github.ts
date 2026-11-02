// 测试用的假 GitHub 写口：分支落在一个真的本机裸仓里（推送是真 git push），PR 在内存里。
// 可以让「开 PR」建成了却回超时（响应丢了），或让改名分支失败（补偿失败）。
import { execFileSync } from 'node:child_process';
import {
  GitHubDefiniteError,
  GitHubUncertainError,
  type GitHubWriter,
  mentionsIssue,
  type PrInfo,
} from '../src/github-write.ts';

const run = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

export interface FakeGitHub extends GitHubWriter {
  prs: PrInfo[];
  calls: string[];
  /** 每次 openPr 收到的参数，按调用顺序。 */
  openPrArgs: { head: string; base: string; title: string; body: string }[];
  /** 下一次开 PR：建出来了，但回超时。 */
  loseNextOpenResponse: boolean;
  failRename: boolean;
  status: 'pending' | 'success' | 'failure' | 'none';
  /** 模拟人手：关掉 / 合掉某个 PR。 */
  closePrByHand(number: number, merged?: boolean): void;
  setOpenPr(pr: Partial<PrInfo> & { number: number; headRef: string }): void;
}

export function fakeGitHub(bare: string): FakeGitHub {
  const prs: PrInfo[] = [];
  const calls: string[] = [];
  const openPrArgs: FakeGitHub['openPrArgs'] = [];
  const sha = (branch: string): string | null => {
    try {
      return run(bare, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`).trim() || null;
    } catch {
      return null;
    }
  };
  const gh: FakeGitHub = {
    prs,
    calls,
    openPrArgs,
    loseNextOpenResponse: false,
    failRename: false,
    status: 'none',
    async branchSha(_repo, branch) {
      calls.push(`branchSha ${branch}`);
      return sha(branch);
    },
    async defaultBranch() {
      return 'main';
    },
    async prByHead(_repo, branch) {
      calls.push(`prByHead ${branch}`);
      return prs.find((p) => p.headRef === branch) ?? null;
    },
    async openPrsForIssue(_repo, issue) {
      return prs.filter((p) => p.state === 'open' && mentionsIssue(p, issue));
    },
    async openPr(repo, pr) {
      calls.push(`openPr ${pr.head}`);
      openPrArgs.push({ head: pr.head, base: pr.base, title: pr.title, body: pr.body });
      if (prs.some((p) => p.headRef === pr.head))
        throw new GitHubDefiniteError('开 PR', 422, 'A pull request already exists');
      const made: PrInfo = {
        number: 100 + prs.length + 1,
        url: `https://github.com/${repo}/pull/${100 + prs.length + 1}`,
        state: 'open',
        merged: false,
        headRef: pr.head,
        headSha: sha(pr.head) ?? '',
        body: pr.body,
      };
      prs.push(made);
      if (gh.loseNextOpenResponse) {
        gh.loseNextOpenResponse = false;
        throw new GitHubUncertainError('POST /pulls', '超时');
      }
      return made;
    },
    async getPr(_repo, number) {
      const p = prs.find((x) => x.number === number);
      if (!p) throw new GitHubDefiniteError('读 PR', 404, '');
      return p;
    },
    async commitStatus() {
      return gh.status;
    },
    async renameBranch(_repo, from, to) {
      calls.push(`rename ${from} -> ${to}`);
      if (gh.failRename) throw new GitHubUncertainError('改名分支', '502');
      run(bare, 'branch', '-m', from, to);
    },
    async closePr(_repo, number) {
      calls.push(`closePr ${number}`);
      gh.closePrByHand(number);
    },
    closePrByHand(number, merged = false) {
      const p = prs.find((x) => x.number === number);
      if (p) {
        p.state = 'closed';
        p.merged = merged;
      }
    },
    setOpenPr(pr) {
      prs.push({
        url: `https://github.com/o/r/pull/${pr.number}`,
        state: 'open',
        merged: false,
        headSha: '',
        body: '',
        ...pr,
      });
    },
  };
  return gh;
}
