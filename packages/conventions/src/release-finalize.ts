// 「发布 vN」PR 合进 main 之后的收尾（#593，决定 0011 第 4 条）：.github/workflows/release.yml 认出这一版要发，
// 就跑 ./bin/release-finalize.ts，这里按固定顺序走完：
//   找本次发布合并的提交 → 读这一版的更新日志 → 核版本里程碑 → 打 tag → 建 Release → 关里程碑 → 推飞书。
// 每一步先查 GitHub 上的现状（tag、Release、里程碑、Release 正文末尾的飞书标记）再动手：已经做过的跳过，所以手动补跑
// （workflow_dispatch）多少遍都一样。哪一步红了，后面的一步都不走，并在报告里写明每一步是做了、跳了、红了还是没走。
// 每一步「该做、该跳、该红」的判定在 publish-release-logic.ts；这里只管先后和读写。测试在 test/release-finalize.test.ts。
// 改这里之前必须知道：
// - 顺序不能换：打 tag 之前先核里程碑（版本号贴错时 tag、Release 一样都不动）；Release 没建成不关里程碑、不推飞书。
// - 更新日志按本次发布合并的那个提交读（不读工作区）：手动补跑时 main 早就往前走了，工作区那份可能已经是下一版的。
// - 飞书 webhook 地址是密钥：报错里不带它。

import type { GitHubReleaser } from './github-api.ts';
import {
  appendFeishuAttemptMark,
  decideRelease,
  decideTag,
  extractReleaseBody,
  feishuAlreadyNotified,
  feishuReplyOk,
  isVersionTag,
  promoteFeishuAttemptToNotified,
  releaseBodyCore,
} from './publish-release-logic.ts';
import { type ReleaseMilestoneGitHub, releaseMilestone } from './release-milestone.ts';
import { feishuBody } from './release-notes.ts';

export type FinalizeStepId =
  | 'merge'
  | 'changelog'
  | 'milestone-check'
  | 'tag'
  | 'release'
  | 'milestone-close'
  | 'feishu';
export type FinalizeStatus = 'done' | 'skipped' | 'failed' | 'not-run';

export interface FinalizeStep {
  id: FinalizeStepId;
  title: string;
  status: FinalizeStatus;
  note: string;
}

/** 按先后排好的七步；报告里永远是这七行，没走到的写「没走」。 */
export const FINALIZE_STEPS: readonly { id: FinalizeStepId; title: string }[] = [
  { id: 'merge', title: '找本次发布合进 main 的提交' },
  { id: 'changelog', title: '读这一版的更新日志' },
  { id: 'milestone-check', title: '核版本里程碑（打 tag 之前）' },
  { id: 'tag', title: '打 tag' },
  { id: 'release', title: '建 GitHub Release' },
  { id: 'milestone-close', title: '关版本里程碑' },
  { id: 'feishu', title: '推飞书' },
];

export type FinalizeGitHub = GitHubReleaser & ReleaseMilestoneGitHub;

export type FinalizeTrigger =
  /** 「发布 vN」PR 合并触发：事件里带着合并的提交和时间。 */
  | { kind: 'pull_request'; mergeSha: string; mergedAt: string }
  /** 手动补一轮：按 head=release/vN 查已合并的那张 PR 拿。 */
  | { kind: 'dispatch' };

export interface FinalizeOptions {
  version: string;
  trigger: FinalizeTrigger;
  github: FinalizeGitHub;
  /** 没配飞书（secret 不在）就不传：这一步记「跳过：没配」，不算红。 */
  feishu?: { send(text: string): Promise<void> } | undefined;
  /** 飞书消息末尾贴的更新日志地址。 */
  changelogUrl: string;
  log?: (line: string) => void;
}

export interface FinalizeResult {
  ok: boolean;
  steps: FinalizeStep[];
}

type Outcome = { status: 'done' | 'skipped'; note: string };

export async function finalizeRelease(opts: FinalizeOptions): Promise<FinalizeResult> {
  const { github, trigger, log = () => {} } = opts;
  const steps: FinalizeStep[] = FINALIZE_STEPS.map((s) => ({ ...s, status: 'not-run', note: '' }));
  const version = opts.version.trim();

  let mergeSha = '';
  let mergedAt = '';
  let want = '';

  const bodies: Record<FinalizeStepId, () => Promise<Outcome>> = {
    async merge() {
      if (!isVersionTag(version)) throw new Error(`版本号不是 v<N> 的模样：「${opts.version}」`);
      if (trigger.kind === 'pull_request') {
        if (!/^[0-9a-f]{40}$/.test(trigger.mergeSha.trim())) {
          throw new Error(
            `事件里的 merge_commit_sha 认不出（「${trigger.mergeSha}」）：不知道 main 上哪一次合并是这次发布，不接着走。`,
          );
        }
        if (Number.isNaN(Date.parse(trigger.mergedAt))) {
          throw new Error(`事件里的 merged_at 认不出（「${trigger.mergedAt}」）：核里程碑要用，不猜。`);
        }
        mergeSha = trigger.mergeSha.trim();
        mergedAt = trigger.mergedAt.trim();
        return { status: 'done', note: `发布 PR 合并成 ${mergeSha.slice(0, 7)}（${mergedAt}）。` };
      }
      const head = `release/${version}`;
      const [pr] = await github.mergedPulls(head);
      if (!pr) {
        throw new Error(
          `没找到 head=${head} 已合并的 PR：手动补跑填的 version 多半写错了，或这一版的发布 PR 用的不是 ${head} 这个分支名。`,
        );
      }
      mergeSha = pr.mergeCommitSha;
      mergedAt = pr.mergedAt;
      return {
        status: 'done',
        note: `手动补跑：#${pr.number} 合并成 ${mergeSha.slice(0, 7)}（${mergedAt}）。`,
      };
    },

    async changelog() {
      const text = await github.fileAt('CHANGELOG.md', mergeSha);
      if (text === undefined)
        throw new Error(`本次发布合并的提交 ${mergeSha.slice(0, 7)} 上没有 CHANGELOG.md。`);
      const r = extractReleaseBody(text, version as `v${number}`);
      if (r.kind !== 'ok') throw new Error(r.message);
      want = r.body;
      return { status: 'done', note: `拿到「## [${version}]」那一段（${want.split('\n').length} 行）。` };
    },

    async 'milestone-check'() {
      const r = await releaseMilestone({ mode: 'check', version, mergedAt, github });
      return { status: r.kind === 'already-closed' ? 'skipped' : 'done', note: r.note };
    },

    async tag() {
      const v = version as `v${number}`;
      const d = decideTag(v, await github.tagCommit(v), mergeSha);
      if (d.kind === 'error') throw new Error(d.message);
      if (d.kind === 'skip') return { status: 'skipped', note: d.note };
      await github.createTag(v, mergeSha, v);
      // 读回核对：打完再查一次它指的提交，对不上不接着建 Release。
      const after = await github.tagCommit(v);
      if (after !== mergeSha) {
        throw new Error(
          `tag ${v} 打完读回指的是「${after ?? '（不在）'}」，不是 ${mergeSha.slice(0, 7)}：不接着走。`,
        );
      }
      return { status: 'done', note: `tag ${v} 已打，指着 ${mergeSha.slice(0, 7)}。` };
    },

    async release() {
      const v = version as `v${number}`;
      const existing = await github.release(v);
      const d = decideRelease(v, existing, want);
      if (d.kind === 'error') throw new Error(d.message);
      if (d.kind === 'skip') return { status: 'skipped', note: d.note };
      if (d.kind === 'create' || !existing) await github.createRelease(v, v, d.body);
      else await github.updateReleaseBody(existing.id, d.body);
      // 读回核对：正文（去掉飞书标记）得是 CHANGELOG.md 那一段，对不上就不关里程碑、不推飞书。
      const after = await github.release(v);
      if (!after || after.tagName !== v || releaseBodyCore(after.body) !== releaseBodyCore(want)) {
        throw new Error(
          `Release ${v} ${d.kind === 'create' ? '建好' : '改完'}之后读回对不上 CHANGELOG.md 那一段：不接着走。`,
        );
      }
      return { status: 'done', note: d.kind === 'create' ? `Release ${v} 已建，读回核对过。` : d.note };
    },

    async 'milestone-close'() {
      const r = await releaseMilestone({ mode: 'close', version, mergedAt, github });
      return { status: r.kind === 'already-closed' ? 'skipped' : 'done', note: r.note };
    },

    async feishu() {
      const v = version as `v${number}`;
      if (!opts.feishu) return { status: 'skipped', note: '没配飞书（secret FLEET_FEISHU 不在），没推。' };
      const rel = await mustRelease(github, v);
      if (feishuAlreadyNotified(rel.body, v)) {
        return { status: 'skipped', note: `Release 正文末尾已有 fleet-notified: ${v}：上一轮推过了（跳）。` };
      }
      // 先写「试过」标记再发：runner 在发出去之前死掉，下一轮看到的不是 notified，会再发——宁可重一条，不漏。
      const attempt = appendFeishuAttemptMark(rel.body, v);
      if (attempt !== rel.body) {
        try {
          await github.updateReleaseBody(rel.id, attempt);
        } catch (e) {
          throw new Error(`「试过」标记写不进 Release 正文，没发（不变成没标就发）：${text(e)}`);
        }
      }
      try {
        await opts.feishu.send(feishuBody(v, want, opts.changelogUrl));
      } catch (e) {
        throw new Error(
          `飞书没发成：${text(e)}。Release 正文留着 fleet-notify-attempt: ${v}，查完 webhook 手动补跑会再发一次。`,
        );
      }
      let after: { body: string };
      try {
        after = await github.updateReleaseBody(rel.id, promoteFeishuAttemptToNotified(attempt, v));
      } catch (e) {
        throw new Error(
          `飞书发成了，但「已发」标记写不回 Release 正文：${text(e)}。再补跑会重发一条；不想重发就手动把正文末尾的 attempt 改成 notified。`,
        );
      }
      if (!feishuAlreadyNotified(after.body, v)) {
        throw new Error('飞书发成了，但 Release 正文读回没有「已发」标记：再补跑会重发一条。');
      }
      return { status: 'done', note: '飞书推了一条，Release 正文末尾记了 fleet-notified。' };
    },
  };

  for (const step of steps) {
    try {
      const r = await bodies[step.id]();
      step.status = r.status;
      step.note = r.note;
      log(`【${step.title}】${r.status === 'done' ? '做了' : '跳过'}：${r.note}`);
    } catch (e) {
      step.status = 'failed';
      step.note = text(e);
      log(`【${step.title}】红了：${step.note}`);
      return { ok: false, steps };
    }
  }
  return { ok: true, steps };
}

async function mustRelease(github: GitHubReleaser, v: string) {
  const r = await github.release(v);
  if (!r) throw new Error(`Release ${v} 读不到（前一步明明建好了）：不接着走。`);
  return r;
}

const STATUS_TEXT: Record<FinalizeStatus, string> = {
  done: '做了',
  skipped: '跳过',
  failed: '**红了**',
  'not-run': '没走',
};

/** 写进 Actions 运行摘要的表：七步各是什么状态（半截失败时一眼看出停在哪、哪些没走）。 */
export function renderFinalizeReport(version: string, r: FinalizeResult): string {
  const head = r.ok
    ? `发布 ${version} 收尾走完了`
    : `发布 ${version} 收尾停在半截（红的那步之后都没走，补跑会从头查、做过的跳过）`;
  const rows = r.steps.map(
    (s) => `| ${s.title} | ${STATUS_TEXT[s.status]} | ${s.note.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`,
  );
  return [`### ${head}`, '', '| 步骤 | 状态 | 说明 |', '| --- | --- | --- |', ...rows, ''].join('\n');
}

/** 往飞书自定义机器人 webhook 发一条文字；HTTP 不是 2xx、回包认不出、业务码不是 0 都抛（报错里不带 webhook 地址）。 */
export async function postFeishu(
  webhook: string,
  message: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  let res: Response;
  try {
    res = await fetchImpl(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text: message } }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new Error(`连不上飞书（${text(e)}）`);
  }
  if (!res.ok) throw new Error(`飞书回了 HTTP ${res.status}`);
  let reply: unknown;
  try {
    reply = await res.json();
  } catch {
    throw new Error('飞书回包不是 JSON');
  }
  const ok = feishuReplyOk(reply);
  if (!ok.ok) throw new Error(ok.message);
}

function text(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
