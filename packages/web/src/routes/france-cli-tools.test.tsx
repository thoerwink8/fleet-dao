// @vitest-environment happy-dom
// 法国页「命令行工具」（#1969，#3533 起收在「更多」里，点开才摆）：两个会话用户分开列，在用版本、官方最新、状态都在。
// 读不到写读不到和原因；没查成写没查成和原因，不空白、不当成最新。这一块没有升级按钮。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import type { FleetApi } from '../api/client';
import { createMockApi, type MockApi } from '../api/mock/server';
import type { CliToolsResponse } from '../api/types';
import France from '../routes/france';
import { renderApp } from '../test/harness';

afterEach(() => cleanup());

function group(name: string): HTMLElement {
  const node = document.querySelector(`[data-cli-group="${name}"]`);
  if (!(node instanceof HTMLElement)) throw new Error(`找不到分组 ${name}`);
  return node;
}

/** 一行：按工具名找到那一行（tr）。 */
function row(owner: string, tool: string): HTMLElement {
  const mark = group(owner).querySelector(`[data-cli-tool="${tool}"]`);
  const tr = mark?.closest('tr');
  if (!(tr instanceof HTMLElement)) throw new Error(`找不到 ${owner} 的 ${tool}`);
  return tr;
}

/** 点开「更多」里的命令行工具。 */
async function openCli() {
  fireEvent.click(await screen.findByRole('button', { name: /命令行工具/ }));
  await screen.findAllByText('Claude Code');
}

describe('法国页命令行工具', () => {
  test('默认收着；点开后两个用户分开列：在用版本、官方最新、落后或最新都在，没有升级', async () => {
    renderApp(<France />, { route: '/france' });
    const entry = await screen.findByRole('button', { name: /命令行工具/ });
    expect(entry.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[data-cli-tools]')).toBeNull();
    await openCli();
    expect(screen.getAllByText('Claude Code').length).toBe(2);
    expect(within(group('fleet-agent-carpool')).getByText('Claude Code')).toBeTruthy();
    expect(within(group('pilot')).getByText('Claude Code')).toBeTruthy();
    expect(row('fleet-agent-carpool', 'claude').textContent).toContain('2.1.282');
    expect(row('fleet-agent-carpool', 'claude').textContent).toContain('2.1.296');
    expect(row('fleet-agent-carpool', 'claude').textContent).toContain('落后 14 个版本');
    expect(row('fleet-agent-carpool', 'codex').textContent).toContain('落后 6 个版本');
    expect(within(row('pilot', 'codex')).getByText('最新')).toBeTruthy();
    expect(row('fleet-agent-carpool', 'codex').textContent).toContain('0.156.1');
    expect(row('pilot', 'codex').textContent).toContain('0.162.1');
    expect(screen.queryByRole('button', { name: /升级/ })).toBeNull();
    expect(screen.queryByText('已升级')).toBeNull();
    expect(row('fleet-agent-carpool', 'claude').textContent ?? '').not.toContain('上次升级 ');
  });

  test('升完看得到新版本和上次升级时间', async () => {
    const inner = createMockApi({ live: false });
    const body = await inner.franceCliTools();
    if (body.state !== 'ok') throw new Error('假数据应该查得成');
    for (const group of body.groups) {
      for (const item of group.rows) {
        if (group.owner === 'fleet-agent-carpool' && item.tool === 'claude') {
          item.upgrade = {
            upgradedAt: '2026-10-12T12:00:01.000Z',
            outcome: 'ok',
            version: '2.1.287',
            detail: '升到 2.1.287',
          };
        }
      }
    }
    const api = { ...inner, franceCliTools: () => Promise.resolve(body) } as MockApi;
    renderApp(<France />, { api: api as unknown as FleetApi, route: '/france' });
    await openCli();
    const line = row('fleet-agent-carpool', 'claude');
    expect(line.textContent).toContain('2.1.287');
    expect(line.textContent).toContain('上次升级');
    expect(within(line).getByText('已升级')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /升级/ })).toBeNull();
    expect(within(row('pilot', 'claude')).queryByText('已升级')).toBeNull();
  });

  test('【故意造出的失败】读不到写读不到和原因，没查成写原因，不写成最新', async () => {
    renderApp(<France />, { route: '/france' });
    await openCli();
    const cursor = row('pilot', 'cursor-agent');
    expect(within(cursor).getByText('读不到')).toBeTruthy();
    expect(cursor.textContent).toContain('退出码 127（找不到命令）');
    expect(within(cursor).queryByText('最新')).toBeNull();
    const mirasim = row('fleet-agent-carpool', 'mirasim-server');
    expect(within(mirasim).getByText('没查成')).toBeTruthy();
    expect(mirasim.textContent).toContain('更新日志里没认出版本号');
    expect(within(mirasim).queryByText('最新')).toBeNull();
    const pi = row('npm', 'pi');
    expect(within(pi).getByText('读不到')).toBeTruthy();
    expect(pi.textContent).toContain('全局 npm 里没有 @earendil-works/pi-coding-agent');
    const reclaude = row('fleet-agent-carpool', 'reclaude');
    expect(within(reclaude).getAllByText('落后（数不出几个）').length).toBeGreaterThanOrEqual(1);
    expect(reclaude.textContent).toContain('发布源只给了最新版，没有版本列表，数不出落后几个');
  });

  test('整段没接上：入口写没读到和原因，点开写原因，不画工具行、不写成最新', async () => {
    const inner = createMockApi({ live: false });
    const body: CliToolsResponse = {
      state: 'unreadable',
      why: '这台后端没接上命令行工具版本的读取',
      asOf: '2026-10-12T12:00:00.000Z',
    };
    const api = { ...inner, franceCliTools: () => Promise.resolve(body) } as MockApi;
    renderApp(<France />, { api: api as unknown as FleetApi, route: '/france' });
    const entry = await screen.findByRole('button', { name: /命令行工具/ });
    await waitFor(() => expect(entry.textContent).toContain('没读到：这台后端没接上命令行工具版本的读取'));
    fireEvent.click(entry);
    const alert = await screen.findByText('没读到命令行工具');
    expect(alert.closest('[role="alert"]')?.textContent).toContain('这台后端没接上命令行工具版本的读取');
    expect(screen.queryByText('Claude Code')).toBeNull();
    expect(screen.queryByText('最新')).toBeNull();
  });
});
