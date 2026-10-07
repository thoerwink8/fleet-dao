// @vitest-environment happy-dom
// /changelog 页的钉子（#227 切片、#725）：
// - 仓根的 CHANGELOG.md 真能被 vite 的 ?raw 读到、共享的 splitChangelog 真能切出来；
// - 解析失败，lib 抛错，页面给 LoadError——不能拿空、0 或 ok 冒充没事；
// - 「发布 v<N>」的版本号只听后端（/api/release/version，和 pnpm publish:pr 同一份判法）：读不到、定不了就照实说，
//   不显示 v1、不显示 0；点下去再核一次，和按钮上写的对不上就拒绝；弹窗里是现在的做法（release/v<N> + pnpm publish:pr）；
// - 演示版不带这一页：导航不给 module（演示版 NAV 自动不收）；仓根的 CHANGELOG.md 里有仓名 fleet，
//   演示版扫描（build/scan.ts）已把「fleet」列进内置禁词——这一页万一被错误地放进演示版路由，构建时会红。

import { splitChangelog } from '@fleet-dao/shared';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { ApiError, type FleetApi } from '../api/client';
import { createMockApi, MOCK_RELEASED_VERSIONS, type MockApi } from '../api/mock/server';
import type { ReleaseVersion } from '../api/types';
import { NAV } from '../components/shell/nav';
import { readChangelog } from '../lib/changelog';
import ChangelogPage from '../routes/changelog';
import { renderApp } from './harness';

afterEach(cleanup);

const AS_OF = '2026-10-03T08:00:00.000Z';
const V3 = { number: 31, title: 'v3 三段一条龙' };
const V4 = { number: 32, title: 'v4 看得更清楚' };

/** 假后端，版本号接口按顺序回这几样（回完了一直回最后一样）；给 Error 就当接口本身挂了。 */
function releasing(...answers: (ReleaseVersion | Error)[]): MockApi & { calls: () => number } {
  const api = createMockApi({ live: false });
  let n = 0;
  const releaseVersion: FleetApi['releaseVersion'] = async () => {
    const answer = answers[Math.min(n, answers.length - 1)];
    n += 1;
    if (!answer) throw new Error('测试没给版本号接口的回答');
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return Object.assign(api, { releaseVersion, calls: () => n });
}

type Milestone = { number: number; title: string };
const ok = (version: string, milestone: Milestone, others: Milestone[] = []): ReleaseVersion => ({
  state: 'ok',
  version,
  milestone,
  others,
  asOf: AS_OF,
});

async function openDialog(name: RegExp | string) {
  await act(async () => {
    fireEvent.click(await screen.findByRole('button', { name }));
  });
}

describe('lib/changelog', () => {
  test('把仓根的 CHANGELOG.md 切出 Unreleased 段和已发布版本', () => {
    const r = readChangelog();
    // 仓里 Keep a Changelog 的格式钉死了：Unreleased 段一定解析得出来。
    expect(typeof r.section).toBe('string');
    expect(Array.isArray(r.released)).toBe(true);
    // 下一版叫什么不从更新日志推（#725）：切出来的东西里没有版本号可拿
    expect(r.next).not.toHaveProperty('version');
  });

  test('共享的那份 splitChangelog：缺 Unreleased 标题就报错（lib 走同一个实现，不吞错）', () => {
    // 仓根的 CHANGELOG.md 是 vite ?raw 顶层读的——文件不在编译就挂；这里钉「内容格式坏掉」的路：
    // splitChangelog 是共享那份，lib 调它不包不藏，所以 splitChangelog 抛，lib 就抛，页面给 LoadError。
    expect(() => splitChangelog('# Changelog\n\n## 认不出的标题\n')).toThrow(/缺 ## \[Unreleased\]/);
  });
});

describe('/changelog 页', () => {
  test('假数据：v3 已有发布标记就不当这一版，这一版取下一个号', async () => {
    const released = readChangelog().released.map((item) => item.version);
    expect(released).toContain('v3');
    expect([...MOCK_RELEASED_VERSIONS.map((item) => item.version)].sort()).toEqual([...released].sort());
    renderApp(<ChangelogPage />);
    expect(await screen.findByRole('heading', { name: '还没发版 · 这一版是 v4' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '还没发版 · 这一版是 v3' })).toBeNull();
    expect(screen.getByRole('button', { name: '发布 v4' })).toBeTruthy();
    expect(screen.getByText('2026-10-05')).toBeTruthy();
  });

  test('当前版本里程碑是 v3：按钮、标题都写 v3（不是按更新日志「上一版 +1」的 v1），还有「已发布」', async () => {
    renderApp(<ChangelogPage />, { api: releasing(ok('v3', V3)) });
    expect(await screen.findByRole('button', { name: '发布 v3' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '还没发版 · 这一版是 v3' })).toBeTruthy();
    expect(screen.getByText(/版本号取当前版本里程碑「v3 三段一条龙」/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: '已发布' })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/发布 v1|这一版是 v1|下一版/);
  });

  test('弹窗是现在的做法：release/v3 + pnpm publish:pr，不提 Closes #227、不提旧的 publish-pr.ts', async () => {
    const api = releasing(ok('v3', V3));
    renderApp(<ChangelogPage />, { api });
    await openDialog('发布 v3');
    const dialog = await screen.findByRole('alertdialog');
    expect(await screen.findByRole('heading', { name: '发布 v3' })).toBeTruthy();
    const text = dialog.textContent ?? '';
    expect(text).toContain('git switch -c release/v3');
    expect(text).toContain('pnpm publish:pr');
    expect(text).toContain('Unreleased 段');
    expect(text).toContain('关里程碑「v3 三段一条龙」');
    expect(text).toContain('第一类');
    expect(text).not.toContain('Closes');
    expect(text).not.toContain('#227');
    expect(text).not.toContain('publish-pr.ts');
    expect(text).not.toMatch(/release\/v1\b/);
    // 点下去又核了一次（页面打开一次 + 点「发布」一次）
    expect(api.calls()).toBe(2);
  });

  test('开着几张版本里程碑：别的也列出来，写明这次只发 v3（和发布 PR 正文一致）', async () => {
    renderApp(<ChangelogPage />, { api: releasing(ok('v3', V3, [V4])) });
    expect(await screen.findByText(/还开着的别的版本里程碑：「v4 看得更清楚」，这次只发 v3/)).toBeTruthy();
  });
});

describe('/changelog 页：故意造出的失败照实说', () => {
  test('后端读不到当前版本：明说「读不到当前版本」和原因，按钮不带版本号，不显示 v1、不显示 0', async () => {
    renderApp(<ChangelogPage />, {
      api: releasing({ state: 'unreadable', why: '读 GitHub 上开着的里程碑失败：连不上', asOf: AS_OF }),
    });
    expect(await screen.findByText('读不到当前版本：读 GitHub 上开着的里程碑失败：连不上')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '还没发版 · 读不到当前版本' })).toBeTruthy();
    // 按钮名字恰好是「发布」：不带 v1、不带 0
    expect(screen.getByRole('button', { name: '发布' })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/发布 v?[01]\b|这一版是/);
  });

  test('读不到时点「发布」：拒绝、说清，不给命令', async () => {
    renderApp(<ChangelogPage />, {
      api: releasing({ state: 'unreadable', why: '读 GitHub 上开着的里程碑失败：连不上', asOf: AS_OF }),
    });
    await screen.findByText(/读不到当前版本：/);
    await openDialog('发布');
    const dialog = await screen.findByRole('alertdialog');
    expect(await screen.findByRole('heading', { name: '现在发不了' })).toBeTruthy();
    expect(dialog.textContent).toContain('读不到当前版本：读 GitHub 上开着的里程碑失败：连不上');
    expect(dialog.textContent).not.toContain('git switch');
  });

  test('驾驶舱后端的接口本身挂了：一样算读不到，不拿上一次的顶', async () => {
    renderApp(<ChangelogPage />, { api: releasing(new ApiError(500, 'internal', '后端出错了')) });
    expect(await screen.findByText('读不到当前版本：后端出错了')).toBeTruthy();
    expect(screen.getByRole('button', { name: '发布' })).toBeTruthy();
  });

  test('一张版本里程碑都没开：写「定不了这一版的版本号」和判法原话，点下去拒绝', async () => {
    const why = '开着的里程碑里没有版本里程碑（标题写成「v<N> 一句目标」的）';
    renderApp(<ChangelogPage />, { api: releasing({ state: 'blocked', why, asOf: AS_OF }) });
    expect(await screen.findByText(`定不了这一版的版本号：${why}`)).toBeTruthy();
    expect(screen.getByRole('heading', { name: '还没发版 · 定不了这一版的版本号' })).toBeTruthy();
    await openDialog('发布');
    const dialog = await screen.findByRole('alertdialog');
    expect(await screen.findByRole('heading', { name: '现在发不了' })).toBeTruthy();
    expect(dialog.textContent).not.toContain('git switch');
  });

  test('点下去版本对不上（页面上是 v3，点的时候核到 v4）：拒绝、说清，不给命令', async () => {
    renderApp(<ChangelogPage />, { api: releasing(ok('v3', V3), ok('v4', V4)) });
    await openDialog('发布 v3');
    const dialog = await screen.findByRole('alertdialog');
    expect(await screen.findByRole('heading', { name: '版本对不上' })).toBeTruthy();
    expect(dialog.textContent).toContain(
      '你点的是「发布 v3」，刚从 GitHub 核到的当前版本是 v4（「v4 看得更清楚」）',
    );
    expect(dialog.textContent).not.toContain('git switch');
    // 关掉弹窗，按钮已经换成核到的那个
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '知道了' }));
    });
    expect(await screen.findByRole('button', { name: '发布 v4' })).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('演示版不泄仓名', () => {
  test('导航里 /changelog 不给 module——演示版 NAV 自动不收它', () => {
    const all = NAV.flatMap((g) => g.items);
    const entry = all.find((i) => i.to === '/changelog');
    expect(entry, 'NAV 里要挂 /changelog').toBeDefined();
    // 不给 module 是刻意的：visibleNav() 在演示版里只留 module 给了的，这一页不会进演示版产物。
    expect(entry?.module).toBeUndefined();
  });
});
