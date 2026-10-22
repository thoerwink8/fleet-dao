// @vitest-environment happy-dom
// 全站面包屑（验收修正）：二级页「上级 / 当前页名」，当前页名不能缺（以前只剩「法国 /」）；顶层菜单页不画面包屑。
import { cleanup, screen } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, test } from 'vitest';
import AuditPage from '../routes/audit';
import ChangelogPage from '../routes/changelog';
import ResourcesPage from '../routes/resources';
import RoutingStatusPage from '../routes/routing-status';
import SchedulesPage from '../routes/schedules';
import { renderApp } from './harness';

afterEach(cleanup);

const CASES: { path: string; title: string; parent: string; parentHref: string; current: string }[] = [
  { path: '/schedules', title: '定时任务', parent: '法国', parentHref: '/france', current: '定时任务' },
  { path: '/resources', title: '资源', parent: '法国', parentHref: '/france', current: '资源' },
  { path: '/changelog', title: '发布记录', parent: '法国', parentHref: '/france', current: '发布记录' },
  { path: '/audit', title: '操作记录', parent: '法国', parentHref: '/france', current: '操作记录' },
  { path: '/routing/status', title: '渠道状态', parent: '路由', parentHref: '/routing', current: '渠道状态' },
];

describe('二级页面包屑：上级 / 当前页', () => {
  for (const c of CASES) {
    test(`${c.path}：${c.parent} / ${c.current}`, async () => {
      renderApp(
        <Routes>
          <Route path="/schedules" element={<SchedulesPage />} />
          <Route path="/resources" element={<ResourcesPage />} />
          <Route path="/changelog" element={<ChangelogPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="/routing/status" element={<RoutingStatusPage />} />
        </Routes>,
        { route: c.path },
      );
      await screen.findByRole('heading', { level: 1, name: c.title });
      const crumbs = document.querySelector('[data-breadcrumb]') as HTMLElement;
      expect(crumbs, '没有面包屑').not.toBeNull();
      const items = [...crumbs.querySelectorAll('li')].map((li) => li.textContent?.replace('/', '').trim());
      expect(items).toEqual([c.parent, c.current]);
      expect(crumbs.querySelector('a')?.getAttribute('href')).toBe(c.parentHref);
      expect(crumbs.querySelector('[aria-current="page"]')?.textContent).toBe(c.current);
    });
  }
});
