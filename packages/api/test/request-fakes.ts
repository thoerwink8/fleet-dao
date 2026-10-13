// 提需求测试用的假「引擎机器人 GitHub」（#2060）：开单、评论按幂等键只做一次，和真的 openIssue / commentIssue 一个行为；
// 可以故意让它失败、让它开成之后才报错（模拟超时：GitHub 那边其实已经建好了）、让它卡住等放行。不打真 GitHub。
import type { RequestIssuePort } from '../src/request-issue.ts';

export type OpenCall = Parameters<RequestIssuePort['openIssue']>[0];
export type CommentCall = Parameters<RequestIssuePort['commentIssue']>[0];

export interface FakeIssues {
  port: RequestIssuePort;
  /** 每次调用的入参，按调用先后。 */
  opened: OpenCall[];
  commented: CommentCall[];
  /** 真正建出来的单（按幂等键去重）。 */
  issues: Map<string, { number: number; url: string }>;
  /** 真正发出的评论（按幂等键去重）。 */
  comments: Map<string, { commentId: number; url: string; body: string }>;
  state: {
    /** 开单直接失败（没建出来）。 */
    failOpen: Error | null;
    /** 开单：先建出来，再抛错（超时，回执丢了）。只管下一次。 */
    failAfterCreate: boolean;
    failComment: Error | null;
    /** 开单卡在这里等放行。 */
    gate: Promise<void> | null;
    /** readIssueState 回什么；给 Error 就抛。 */
    issueState: { state: 'open' | 'closed'; stateReason: string | null } | Error;
  };
}

export function fakeIssues(firstNumber = 100): FakeIssues {
  let next = firstNumber;
  let nextComment = 5000;
  const f: FakeIssues = {
    opened: [],
    commented: [],
    issues: new Map(),
    comments: new Map(),
    state: {
      failOpen: null,
      failAfterCreate: false,
      failComment: null,
      gate: null,
      issueState: { state: 'open', stateReason: null },
    },
    port: {
      async openIssue(input) {
        f.opened.push(input);
        if (f.state.gate) await f.state.gate;
        if (f.state.failOpen) throw f.state.failOpen;
        const hit = f.issues.get(input.key);
        if (hit) return { ...hit, created: false };
        const number = next++;
        const made = {
          number,
          url: `https://github.com/${input.repo.owner}/${input.repo.name}/issues/${number}`,
        };
        f.issues.set(input.key, made);
        if (f.state.failAfterCreate) {
          f.state.failAfterCreate = false;
          throw new Error('socket hang up（回执丢了，单其实已经建好）');
        }
        return { ...made, created: true };
      },
      async commentIssue(input) {
        f.commented.push(input);
        if (f.state.failComment) throw f.state.failComment;
        const hit = f.comments.get(input.key);
        if (hit) return { commentId: hit.commentId, url: hit.url, created: false };
        const commentId = nextComment++;
        const url = `https://github.com/${input.repo.owner}/${input.repo.name}/issues/${input.issueNumber}#issuecomment-${commentId}`;
        f.comments.set(input.key, { commentId, url, body: input.body });
        return { commentId, url, created: true };
      },
      async readIssueState() {
        if (f.state.issueState instanceof Error) throw f.state.issueState;
        return f.state.issueState;
      },
    },
  };
  return f;
}
