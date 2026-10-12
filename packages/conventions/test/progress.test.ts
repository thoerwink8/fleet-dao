// pnpm progress:*（进度单 #1055）：贴进度、记引导、标已处理、读待办。
// 【故意造出的失败】：gh 报错 / 读回来认不出 / 评论没读全 / 贴完回读对不上，都要明确报错，不拿「没读到」当「没有待办」。
import { describe, expect, it } from 'vitest';
import type { GhResult } from '../src/issue-new.ts';
import {
  DONE_TAG,
  NO_OWNER,
  NOTE_TAG,
  ownerOf,
  PENDING_TAG,
  PROGRESS_ISSUE,
  ProgressRefused,
  ProgressUnchecked,
  progressClaim,
  progressDirective,
  progressDone,
  progressNote,
  progressRead,
  stamp,
  textOf,
} from '../src/progress.ts';

const ok = (data: unknown): GhResult => ({ code: 0, stdout: JSON.stringify(data), stderr: '' });
const fail = (stderr: string): GhResult => ({ code: 1, stdout: '', stderr });
const NOW = () => new Date('2026-10-05T10:30:00Z'); // 北京 18:30

interface Fake {
  id: number;
  body: string;
}
/** 一张假的进度单：评论按编号存；gh api 的几种调用都认。 */
function world(
  initial: Fake[] = [],
  over: { fail?: (args: string[]) => GhResult | undefined; garble?: boolean } = {},
) {
  const comments = initial.map((c) => ({ ...c }));
  let next = 1000;
  const calls: string[][] = [];
  const url = (id: number) => `https://github.com/o/r/issues/${PROGRESS_ISSUE}#issuecomment-${id}`;
  const view = (c: Fake) => ({ id: c.id, body: c.body, html_url: url(c.id) });
  const gh = async (args: string[]): Promise<GhResult> => {
    calls.push(args);
    const forced = over.fail?.(args);
    if (forced) return forced;
    const path = args.find((a) => a.startsWith('repos/')) ?? '';
    const field = args.find((a) => a.startsWith('body='))?.slice(5);
    if (args.includes('POST')) {
      const c = { id: next++, body: over.garble ? 'garbled' : (field ?? '') };
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
    const page = Number(/&page=(\d+)/.exec(path)?.[1] ?? 1);
    return ok(comments.slice((page - 1) * 100, page * 100).map(view));
  };
  return { gh, comments, calls };
}

describe('progress：贴进度、记引导', () => {
  it('stamp 是北京时间', () => {
    expect(stamp(NOW())).toBe('2026-10-05 18:30');
  });

  it('note 贴一条带标记和时间的评论', async () => {
    const w = world();
    const c = await progressNote('  第二个 PR 合了 ', { gh: w.gh, now: NOW });
    expect(c.kind).toBe('note');
    expect(w.comments[0]?.body).toBe(`${NOTE_TAG}2026-10-05 18:30\n\n第二个 PR 合了`);
  });

  it('directive 记成待处理，带原话、他说话的时间和主人（记它的会话的血缘）', async () => {
    const w = world();
    const c = await progressDirective('都按照你推荐', '2026-10-05 16:20', 'mira-a', { gh: w.gh, now: NOW });
    expect(c.kind).toBe('pending');
    expect(c.owner).toBe('mira-a');
    expect(w.comments[0]?.body).toBe(`${PENDING_TAG}2026-10-05 16:20\n〔主：mira-a〕\n\n原话：都按照你推荐`);
  });

  it('取不到主人的记成「无主」', async () => {
    const w = world();
    const c = await progressDirective('先这样', '2026-10-05 16:20', NO_OWNER, { gh: w.gh, now: NOW });
    expect(c.owner).toBe(NO_OWNER);
    expect(w.comments[0]?.body).toContain('〔主：无主〕');
  });

  it('【故意造出失败】空内容、缺 --at、主人认不出拒绝，一次 gh 也不调', async () => {
    const w = world();
    await expect(progressNote('   ', { gh: w.gh })).rejects.toBeInstanceOf(ProgressRefused);
    await expect(progressDirective('原话', '', NO_OWNER, { gh: w.gh })).rejects.toThrow(/--at/);
    await expect(progressDirective('原话', 't', '有 空格', { gh: w.gh })).rejects.toThrow(/主人/);
    expect(w.calls).toEqual([]);
  });

  it('【故意造出失败】gh 报错、贴完回读对不上都报没贴成（不是静默成功）', async () => {
    const bad = world([], { fail: () => fail('HTTP 502') });
    await expect(progressNote('x', { gh: bad.gh })).rejects.toBeInstanceOf(ProgressUnchecked);
    await expect(progressNote('x', { gh: bad.gh })).rejects.toThrow(/HTTP 502/);
    const garbled = world([], { garble: true });
    await expect(progressNote('x', { gh: garbled.gh })).rejects.toThrow(/对不上/);
  });
});

describe('progress：标已处理', () => {
  const pending = { id: 7, body: `${PENDING_TAG}2026-10-05 16:20\n\n原话：先这样` };

  it('待处理改成已处理，保留原话、补一段办成了什么', async () => {
    const w = world([pending]);
    const c = await progressDone(7, '#1060 合了', { gh: w.gh, now: NOW });
    expect(c.kind).toBe('done');
    expect(w.comments[0]?.body).toBe(
      `${DONE_TAG}2026-10-05 16:20\n\n原话：先这样\n\n已处理 2026-10-05 18:30：#1060 合了`,
    );
  });

  it('【故意造出失败】不是待处理的、不存在的、改失败的都不动', async () => {
    const w = world([
      { id: 8, body: `${NOTE_TAG}2026-10-05 10:00\n\n进度` },
      { ...pending, id: 9, body: `${DONE_TAG}x` },
      pending,
    ]);
    await expect(progressDone(8, undefined, { gh: w.gh })).rejects.toThrow(/不是待处理/);
    await expect(progressDone(9, undefined, { gh: w.gh })).rejects.toThrow(/已经标过/);
    await expect(progressDone(404, undefined, { gh: w.gh })).rejects.toBeInstanceOf(ProgressUnchecked);
    await expect(progressDone(0, undefined, { gh: w.gh })).rejects.toBeInstanceOf(ProgressRefused);
    const broken = world([pending], { fail: (a) => (a.includes('PATCH') ? fail('HTTP 403') : undefined) });
    await expect(progressDone(7, undefined, { gh: broken.gh })).rejects.toThrow(/HTTP 403/);
    expect(broken.comments[0]?.body.startsWith(PENDING_TAG)).toBe(true);
  });

  it('【故意造出失败】别的单下面的评论不许改', async () => {
    const gh = async (): Promise<GhResult> =>
      ok({ id: 5, body: `${PENDING_TAG}x`, html_url: 'https://github.com/o/r/issues/12#issuecomment-5' });
    await expect(progressDone(5, undefined, { gh })).rejects.toThrow(/不在 #1055/);
  });

  it('标已处理保留主人那一行', async () => {
    const w = world([{ id: 7, body: `${PENDING_TAG}2026-10-05 16:20\n〔主：mira-a〕\n\n原话：先这样` }]);
    const c = await progressDone(7, undefined, { gh: w.gh, now: NOW });
    expect(c.owner).toBe('mira-a');
    expect(w.comments[0]?.body).toBe(
      `${DONE_TAG}2026-10-05 16:20\n〔主：mira-a〕\n\n原话：先这样\n\n已处理 2026-10-05 18:30`,
    );
  });
});

describe('progress：认领（引导认主，创始人 2026-10-11「现在你实现的引导方式会串会话」）', () => {
  const legacy = { id: 21, body: `${PENDING_TAG}2026-10-05 16:20\n\n原话：老的、没写主人` };
  const unowned = { id: 22, body: `${PENDING_TAG}2026-10-11 18:15\n〔主：无主〕\n\n原话：字号太大` };
  const theirs = { id: 23, body: `${PENDING_TAG}2026-10-11 18:15\n〔主：mira-b〕\n\n原话：字号太大` };
  const ours = { id: 24, body: `${PENDING_TAG}2026-10-11 18:15\n〔主：mira-a〕\n\n原话：参考苹果` };

  it('ownerOf / textOf：认标记那一行，没有就是无主；列原话时去掉标记', async () => {
    expect(ownerOf(legacy.body)).toBe(NO_OWNER);
    expect(ownerOf(theirs.body)).toBe('mira-b');
    const v = await progressRead(0, { gh: world([legacy, theirs]).gh });
    expect(v.pending.map((c) => c.owner)).toEqual([NO_OWNER, 'mira-b']);
    expect(v.pending.map(textOf)).toEqual(['原话：老的、没写主人', '原话：字号太大']);
  });

  it('无主的（旧的没标记、写了「无主」的）认领成本会话：主人改掉、原话不动，回读核对', async () => {
    const w = world([legacy, unowned]);
    const a = await progressClaim(21, 'mira-a', {}, { gh: w.gh, now: NOW });
    expect(a.owner).toBe('mira-a');
    expect(w.comments[0]?.body).toBe(
      `${PENDING_TAG}2026-10-05 16:20\n〔主：mira-a〕\n\n原话：老的、没写主人`,
    );
    await progressClaim(22, 'mira-a', {}, { gh: w.gh, now: NOW });
    expect(w.comments[1]?.body).toBe(`${PENDING_TAG}2026-10-11 18:15\n〔主：mira-a〕\n\n原话：字号太大`);
  });

  it('已经是本会话的：不改、不调 PATCH', async () => {
    const w = world([ours]);
    const c = await progressClaim(24, 'mira-a', {}, { gh: w.gh });
    expect(c.owner).toBe('mira-a');
    expect(w.calls.some((a) => a.includes('PATCH'))).toBe(false);
  });

  it('【故意造出失败】已归别的会话：拒绝、评论一字不动；--force 不带理由也拒', async () => {
    const w = world([theirs]);
    await expect(progressClaim(23, 'mira-a', {}, { gh: w.gh })).rejects.toThrow(/已归别的会话（mira-b）/);
    await expect(progressClaim(23, 'mira-a', { force: true }, { gh: w.gh })).rejects.toThrow(/--why/);
    expect(w.comments[0]?.body).toBe(theirs.body);
    expect(w.calls.some((a) => a.includes('PATCH'))).toBe(false);
  });

  it('--force 带理由：原会话没了才接手，改主那一笔记进评论', async () => {
    const w = world([theirs]);
    const c = await progressClaim(23, 'mira-a', { force: true, why: '原会话已关' }, { gh: w.gh, now: NOW });
    expect(c.owner).toBe('mira-a');
    expect(w.comments[0]?.body).toBe(
      `${PENDING_TAG}2026-10-11 18:15\n〔主：mira-a〕\n\n原话：字号太大\n\n改主 2026-10-05 18:30：mira-b → mira-a（原会话已关）`,
    );
  });

  it('【故意造出失败】本会话认不出主、不是待处理、改完回读主人不对：都不算认领成', async () => {
    const w = world([legacy, { id: 25, body: `${DONE_TAG}x` }]);
    await expect(progressClaim(21, NO_OWNER, {}, { gh: w.gh })).rejects.toBeInstanceOf(ProgressRefused);
    await expect(progressClaim(25, 'mira-a', {}, { gh: w.gh })).rejects.toThrow(/已经标过/);
    expect(w.calls).toHaveLength(1); // 认不出主那次一次 gh 也不调；第二次只读了一下
    const garbled = world([legacy], {
      fail: (a) =>
        a.includes('PATCH')
          ? ok({
              id: 21,
              body: legacy.body,
              html_url: `https://github.com/o/r/issues/${PROGRESS_ISSUE}#issuecomment-21`,
            })
          : undefined,
    });
    await expect(progressClaim(21, 'mira-a', {}, { gh: garbled.gh })).rejects.toBeInstanceOf(
      ProgressUnchecked,
    );
  });
});

describe('progress：读', () => {
  it('最近 limit 条加全部待处理（旧评论里的待办也找得出）', async () => {
    const list: Fake[] = [{ id: 1, body: `${PENDING_TAG}2026-10-01 09:00\n\n原话：很早的` }];
    for (let i = 2; i <= 150; i += 1) list.push({ id: i, body: `${NOTE_TAG}t\n\n第 ${i} 条` });
    list.push({ id: 151, body: `${DONE_TAG}x` });
    const w = world(list);
    const v = await progressRead(3, { gh: w.gh });
    expect(v.recent.map((c) => c.id)).toEqual([149, 150, 151]);
    expect(v.pending.map((c) => c.id)).toEqual([1]);
  });

  it('【故意造出失败】gh 报错、不是列表、评论认不出、评论太多没读全都报没查成，不当成「没有待办」', async () => {
    const down = world([], { fail: () => fail('network down') });
    await expect(progressRead(5, { gh: down.gh })).rejects.toThrow(/network down/);
    const notList: (args: string[]) => Promise<GhResult> = async () => ok({ message: 'x' });
    await expect(progressRead(5, { gh: notList })).rejects.toThrow(/不是列表/);
    const odd: (args: string[]) => Promise<GhResult> = async () => ok([{ id: 1 }]);
    await expect(progressRead(5, { gh: odd })).rejects.toThrow(/认不出/);
    const endless: (args: string[]) => Promise<GhResult> = async () =>
      ok(Array.from({ length: 100 }, (_, i) => ({ id: i, body: 'x', html_url: 'u' })));
    await expect(progressRead(5, { gh: endless })).rejects.toThrow(/没读全/);
  });
});
