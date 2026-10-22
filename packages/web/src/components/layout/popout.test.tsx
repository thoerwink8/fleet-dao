// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, test } from 'vitest';
import { PickGroup, PickList } from './pick-list';
import { Popout } from './popout';

afterEach(cleanup);

function renderPopout(ui: React.ReactNode) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('Popout', () => {
  test('顶栏回链和这张单；左卡标题加笔数；右卡标题（h1）、概况、提示条、内容', () => {
    renderPopout(
      <Popout
        backHref="/tasks/t-1"
        taskLabel="#1 标题"
        sideTitle="这张单的笔"
        sideCount={4}
        side={<p>笔列表</p>}
        title="第 3 笔 · 动手"
        meta="概况"
        notice={<span>刷新没成</span>}
      >
        <p>会话</p>
      </Popout>,
    );
    const back = document.querySelector('[data-popout-back]') as HTMLAnchorElement;
    expect(back.getAttribute('href')).toBe('/tasks/t-1');
    expect(back.textContent).toBe('回到任务页');
    expect(screen.getByText('#1 标题')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('这张单的笔4');
    expect(document.querySelector('[data-popout-title]')?.textContent).toBe('第 3 笔 · 动手');
    expect(screen.getByText('概况')).toBeTruthy();
    expect(screen.getByText('刷新没成')).toBeTruthy();
    expect(screen.getByText('笔列表')).toBeTruthy();
    expect(screen.getByText('会话')).toBeTruthy();
  });

  test('没有 side：只画一张居中的窄卡，没有左卡和标题', () => {
    renderPopout(
      <Popout backHref="/tasks/t-1">
        <p>没有这张单</p>
      </Popout>,
    );
    expect(screen.getByText('没有这张单')).toBeTruthy();
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(document.querySelector('[data-popout-title]')).toBeNull();
  });

  test('左卡在窄屏收起（hidden md:flex），右卡始终在', () => {
    renderPopout(
      <Popout backHref="/x" sideTitle="笔" side={<p>列表</p>} title="标题">
        <p>会话</p>
      </Popout>,
    );
    const aside = document.querySelector('aside') as HTMLElement;
    expect(aside.className).toContain('hidden');
    expect(aside.className).toContain('md:flex');
  });
});

describe('PickList 的链接行、PickGroup', () => {
  test('给了 href 的行是站内链接（a），当前这一行 aria-current=page；组标题是 p', () => {
    renderPopout(
      <PickGroup label="第 1 回合">
        <PickList
          aria-label="第 1 回合"
          value="b"
          items={[
            { key: 'a', title: '第 1 笔', href: '/tasks/t/runs/a', replace: true },
            { key: 'b', title: '第 2 笔', href: '/tasks/t/runs/b', status: 'tone:run' },
          ]}
        />
      </PickGroup>,
    );
    expect(document.querySelector('[data-pick-group] p')?.textContent).toBe('第 1 回合');
    const links = Array.from(document.querySelectorAll('a'));
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/tasks/t/runs/a', '/tasks/t/runs/b']);
    expect(links[1]?.getAttribute('aria-current')).toBe('page');
    expect(links[0]?.getAttribute('aria-current')).toBeNull();
    expect(document.querySelector('button')).toBeNull();
  });
});
