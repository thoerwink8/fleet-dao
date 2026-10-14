// 置顶单 #1055：进度流水和驾驶舱来的引导收件箱（引导本身搬进仓了，测试在 directives.test.ts）。
// 【故意造出的失败】：gh 报错 / 读回来认不出 / 收件箱没读全 / 贴完回读对不上，都要明确报错，不拿「没读到」当「没有待办」。
import { describe, expect, it } from 'vitest';
import type { GhResult } from '../src/issue-new.ts';
import {
  INBOX_DAYS,
  inboxPending,
  kindOf,
  MIGRATED_TAG,
  markMigrated,
  NOTE_TAG,
  ownerOf,
  PENDING_TAG,
  PROGRESS_ISSUE,
  ProgressRefused,
  ProgressUnchecked,
  progressNote,
  readInboxComment,
  recentComments,
  stamp,
} from '../src/progress.ts';

const ok = (data: unknown): GhResult => ({ code: 0, stdout: JSON.stringify(data), stderr: '' });
const fail = (stderr: string): GhResult => ({ code: 1, stdout: '', stderr });
const NOW = () => new Date('2026-10-05T10:30:00Z'); // 北京 18:30

interface Fake {
  id: number;
  body: string;
}
function world(initial: Fake[] = [], over: { fail?: (args: string[]) => GhResult | undefined } = {}) {
  const comments = initial.map((c) => ({ ...c }));
  let next = 1000;
  const calls: string[][] = [];
  const url = (id: number) => `https://github.com/o/r/issues/${PROGRESS_ISSUE}#issuecomment-${id}`;
  const view = (c: Fake) => ({
    id: c.id,
    body: c.body,
    html_url: url(c.id),
    created_at: '2026-10-05T01:00:00Z',
  });
  const gh = async (args: string[]): Promise<GhResult> => {
    calls.push(args);
    const forced = over.fail?.(args);
    if (forced) return forced;
    const path = args.find((a) => a.startsWith('repos/')) ?? '';
    const field = args.find((a) => a.startsWith('body='))?.slice(5);
    if (args.includes('POST')) {
      const c = { id: next++, body: field ?? '' };
      comments.push(c);
      return ok(view(c));
    }
    if (args.includes('PATCH')) {
      const c = comments.find((x) => path.endsWith(`/${x.id}`));
      if (!c) return fail('Not Found');
      c.body = field ?? '';
      return ok(view(c));
    }
    const one = /issues\/comments\/(\d+)$/.exec(path);
    if (one) {
      const c = comments.find((x) => x.id === Number(one[1]));
      return c ? ok(view(c)) : fail('Not Found');
    }
    if (path.endsWith(`/issues/${PROGRESS_ISSUE}`)) return ok({ comments: comments.length });
    const page = Number(/&page=(\d+)/.exec(path)?.[1] ?? 1);
    return ok(comments.slice((page - 1) * 100, page * 100).map(view));
  };
  return { gh, comments, calls };
}

describe('progress：进度流水', () => {
  it('stamp 是北京时间；kindOf 认四种标记', () => {
    expect(stamp(NOW())).toBe('2026-10-05 18:30');
    expect(kindOf(`${MIGRATED_TAG}2026-10-05`)).toBe('migrated');
    expect(kindOf(`${PENDING_TAG}2026-10-05`)).toBe('pending');
  });

  it('note 贴一条带标记和时间的评论', async () => {
    const w = world();
    const c = await progressNote('合了 #12', { gh: w.gh, now: NOW });
    expect(c.body).toBe(`${NOTE_TAG}2026-10-05 18:30\n\n合了 #12`);
  });

  it('【故意造出失败】空内容拒绝、gh 报错报没贴成', async () => {
    const w = world([], { fail: () => fail('boom') });
    await expect(progressNote('  ', { gh: w.gh })).rejects.toBeInstanceOf(ProgressRefused);
    await expect(progressNote('x', { gh: w.gh })).rejects.toBeInstanceOf(ProgressUnchecked);
  });

  it('最近 limit 条从最后一页往前读，不从第一页翻全量（2500 条也不报错）', async () => {
    const w = world(
      Array.from({ length: 2500 }, (_, i) => ({ id: i + 1, body: `${NOTE_TAG}x\n\n第 ${i + 1} 条` })),
    );
    const got = await recentComments(3, { gh: w.gh });
    expect(got.map((c) => c.id)).toEqual([2498, 2499, 2500]);
    const pages = w.calls.filter((a) => a.some((x) => x.includes('/comments?')));
    expect(pages).toHaveLength(1);
    expect(pages[0]?.join(' ')).toContain('page=25');
  });
});

describe('progress：收件箱（驾驶舱来的引导）', () => {
  it('按 since 只读最近 INBOX_DAYS 天改过的，挑出待处理的', async () => {
    const w = world([
      { id: 1, body: `${NOTE_TAG}x` },
      { id: 2, body: `${PENDING_TAG}2026-10-05 18:00\n〔主：无主〕\n\n原话：创始人已选：删` },
    ]);
    const got = await inboxPending({ gh: w.gh, now: NOW });
    expect(got.map((c) => c.id)).toEqual([2]);
    const since = new Date(NOW().getTime() - INBOX_DAYS * 86_400_000).toISOString();
    expect(w.calls[0]?.join(' ')).toContain(`since=${since}`);
  });

  it('【故意造出失败】gh 报错、读回来不是列表都报没查成，不当成「没有待办」', async () => {
    await expect(inboxPending({ gh: world([], { fail: () => fail('boom') }).gh })).rejects.toBeInstanceOf(
      ProgressUnchecked,
    );
    await expect(inboxPending({ gh: async () => ok({ not: 'list' }) })).rejects.toBeInstanceOf(
      ProgressUnchecked,
    );
  });

  it('搬进仓：改成「已迁」并写明去处、回读核对；不是待处理的拒绝', async () => {
    const w = world([
      { id: 7, body: `${PENDING_TAG}2026-10-05 18:00\n〔主：dir-a〕\n\n原话：x` },
      { id: 8, body: `${NOTE_TAG}x` },
    ]);
    const c = await readInboxComment(7, { gh: w.gh });
    expect(ownerOf(c.body)).toBe('dir-a');
    await markMigrated(c, 'docs/directives/2026-10/7.md', { gh: w.gh });
    expect(w.comments[0]?.body).toMatch(
      /^【创始人引导·已迁】2026-10-05 18:00\n〔主：dir-a〕[\s\S]*已迁到仓里：docs\/directives/,
    );
    await expect(readInboxComment(8, { gh: w.gh })).rejects.toBeInstanceOf(ProgressRefused);
    await expect(readInboxComment(7, { gh: w.gh })).rejects.toBeInstanceOf(ProgressRefused);
  });
});
