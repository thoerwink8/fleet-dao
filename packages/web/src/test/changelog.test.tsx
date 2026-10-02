// @vitest-environment happy-dom
// /changelog 页的钉子（#227 切片）：
// - 仓根的 CHANGELOG.md 真能被 vite 的 ?raw 读到、共享的 splitChangelog 真能切出来；
// - 解析失败，lib 抛错，页面给 LoadError——不能拿空、0 或 ok 冒充没事；
// - 演示版不带这一页：导航不给 module（演示版 NAV 自动不收）；仓根的 CHANGELOG.md 里有仓名 fleet，
//   演示版扫描（build/scan.ts）已把「fleet」列进内置禁词——这一页万一被错误地放进演示版路由，构建时会红。

import { splitChangelog } from '@fleet-dao/shared';
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { NAV } from '../components/shell/nav';
import { readChangelog } from '../lib/changelog';
import ChangelogPage from '../routes/changelog';
import { renderApp } from './harness';

afterEach(cleanup);

describe('lib/changelog', () => {
  test('把仓根的 CHANGELOG.md 切出 Unreleased 段和已发布版本', () => {
    const r = readChangelog();
    // 仓里 Keep a Changelog 的格式钉死了：Unreleased 段一定解析得出来。
    expect(typeof r.section).toBe('string');
    expect(Array.isArray(r.released)).toBe(true);
    expect(r.next.version).toMatch(/^v\d+$/);
  });

  test('共享的那份 splitChangelog：缺 Unreleased 标题就报错（lib 走同一个实现，不吞错）', () => {
    // 仓根的 CHANGELOG.md 是 vite ?raw 顶层读的——文件不在编译就挂；这里钉「内容格式坏掉」的路：
    // splitChangelog 是共享那份，lib 调它不包不藏，所以 splitChangelog 抛，lib 就抛，页面给 LoadError。
    expect(() => splitChangelog('# Changelog\n\n## 认不出的标题\n')).toThrow(/缺 ## \[Unreleased\]/);
  });
});

describe('/changelog 页', () => {
  test('渲染出「还没发版」和「已发布」两块', () => {
    renderApp(<ChangelogPage />);
    expect(screen.getByText(/^还没发版 · 下一版 v\d+$/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: '已发布' })).toBeTruthy();
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
