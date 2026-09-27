// @vitest-environment happy-dom
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { brand } from '#brand';
import type { Board } from '../api/types';
import { renderApp } from '../test/harness';
import { FlowBanner, OrgDefaultMark } from './flow-source';

afterEach(cleanup);

const MIN = 60_000;
const syncedAt = () => new Date(Date.now() - 10 * MIN).toISOString();

function open(source: 'project' | 'org_default'): Board['flow'] {
  return { paused: false, source, commit: 'abc1234', syncedAt: syncedAt() };
}

describe('全组织默认的小标', () => {
  test('只有 org_default 渲染「全组织默认配置」，project 和空的不渲染', () => {
    const { rerender } = renderApp(<OrgDefaultMark flowSource="org_default" />);
    expect(screen.getByRole('button', { name: '全组织默认配置' })).toBeTruthy();
    rerender(<OrgDefaultMark flowSource="project" />);
    expect(screen.queryByRole('button', { name: '全组织默认配置' })).toBeNull();
    rerender(<OrgDefaultMark flowSource={undefined} />);
    expect(screen.queryByRole('button', { name: '全组织默认配置' })).toBeNull();
  });

  test('点开是品牌上的那一句，而且不把外层的点击一起触发', () => {
    let bubbled = 0;
    renderApp(
      // biome-ignore lint/a11y/noStaticElementInteractions: 只用来看点击有没有冒出去
      // biome-ignore lint/a11y/useKeyWithClickEvents: 同上，不是页面上的控件
      <div
        onClick={() => {
          bubbled += 1;
        }}
      >
        <OrgDefaultMark flowSource="org_default" />
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: '全组织默认配置' }));
    expect(bubbled).toBe(0);
    expect(screen.getByText(brand.flow.orgDefaultDetail)).toBeTruthy();
  });
});

describe('看板顶栏三种样子', () => {
  test('读自仓里', () => {
    renderApp(<FlowBanner flow={open('project')} />);
    const banner = screen.getByRole('region', { name: '流程配置' });
    expect(banner.textContent).toContain('流程配置读自仓里 · ');
    expect(banner.textContent).toContain('abc1234');
    expect(banner.textContent).toContain('10 分钟前');
    expect(banner.className).not.toContain('text-ink-fail');
  });

  test('全组织默认', () => {
    renderApp(<FlowBanner flow={open('org_default')} />);
    const banner = screen.getByRole('region', { name: '流程配置' });
    expect(banner.textContent).toContain('流程配置用的全组织默认 · ');
    expect(banner.textContent).toContain('abc1234');
    expect(banner.textContent).toContain('10 分钟前');
  });

  test('认不出就停派，标红，写原因；还有上次读成的就补上', () => {
    renderApp(
      <FlowBanner
        flow={{
          paused: true,
          why: '流程配置认不出：不是合法的 JSON。改好仓里的文件，合进主线、对账读成后自动恢复',
          source: 'project',
          commit: 'abc1234',
          syncedAt: syncedAt(),
        }}
      />,
    );
    const banner = screen.getByRole('region', { name: '流程配置' });
    expect(banner.textContent).toContain('这个项目停派');
    expect(banner.textContent).toContain('不是合法的 JSON');
    expect(banner.textContent).toContain('上次读成：');
    expect(banner.textContent).toContain('abc1234');
    expect(banner.textContent).toContain('10 分钟前');
    expect(banner.className).toContain('border-st-fail');
    expect(banner.textContent && banner.querySelector('.text-ink-fail')).toBeTruthy();
  });
});
