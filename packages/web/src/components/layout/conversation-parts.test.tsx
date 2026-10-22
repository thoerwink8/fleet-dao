// @vitest-environment happy-dom
// 提需求页用到的几个版式件（#3533）：Title、Avatar、Inset、RuleLabel、Pane/Workspace、ChoiceRow、MenuButton。
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Avatar, AvatarPair, AvatarStack, BotAvatar } from './avatar';
import { ChoiceRow } from './choice-row';
import { Inset, RuleLabel } from './inset';
import { Pane, Workspace } from './pane';
import { Title } from './title';

afterEach(cleanup);

describe('Title', () => {
  test('level 对应 h1–h3；truncate 带悬停全文；data-* 透传', () => {
    render(
      <>
        <Title level={1}>页</Title>
        <Title truncate title="全文" data-x="1">
          区块
        </Title>
        <Title level={3}>小</Title>
      </>,
    );
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('页');
    const h2 = screen.getByRole('heading', { level: 2 });
    expect(h2.getAttribute('title')).toBe('全文');
    expect(h2.getAttribute('data-x')).toBe('1');
    expect(screen.getByRole('heading', { level: 3 })).toBeTruthy();
  });
});

describe('Avatar', () => {
  test('我是品牌色、别人是灰；字是名字最后一个字；机器人是方形图标', () => {
    const { container } = render(
      <>
        <Avatar person={{ id: 'a', name: '阿岚' }} me />
        <Avatar person={{ id: 'b', name: '成员 B' }} me={false} />
        <BotAvatar who="commander" />
      </>,
    );
    const avatars = container.querySelectorAll('[data-avatar]');
    expect(avatars[0]?.getAttribute('data-avatar')).toBe('me');
    expect(avatars[0]?.textContent).toBe('岚');
    expect(avatars[1]?.getAttribute('data-avatar')).toBe('other');
    expect(container.querySelector('[title="指挥官"] svg')).not.toBeNull();
  });

  test('AvatarPair 叠第二个小头像；AvatarStack 悬停写参与人', () => {
    const { container } = render(
      <>
        <AvatarPair main={{ id: 'a', name: '甲' }} extra={{ id: 'b', name: '乙' }} meId="a" />
        <AvatarStack
          people={[
            { id: 'a', name: '甲' },
            { id: 'b', name: '乙' },
          ]}
          meId="a"
          data-stack="1"
        />
      </>,
    );
    expect(container.querySelectorAll('[data-avatar]').length).toBe(4);
    expect(container.querySelector('[data-stack]')?.getAttribute('title')).toBe('参与：甲、乙');
  });
});

describe('Inset / RuleLabel', () => {
  test('Inset 默认实底、dashed 画虚线；RuleLabel 两边各一条线', () => {
    const { container } = render(
      <>
        <Inset data-a="1">卡</Inset>
        <Inset look="dashed" data-b="1">
          虚
        </Inset>
        <RuleLabel accent data-c="1">
          以下是新消息
        </RuleLabel>
      </>,
    );
    expect(container.querySelector('[data-a]')?.getAttribute('data-look')).toBe('solid');
    expect(container.querySelector('[data-b]')?.getAttribute('data-look')).toBe('dashed');
    const rule = container.querySelector('[data-c]');
    expect(rule?.textContent).toBe('以下是新消息');
    expect(rule?.querySelectorAll('[aria-hidden]').length).toBe(2);
  });
});

describe('Pane / Workspace', () => {
  test('带名字、顶栏、底栏；data-* 落在根上', () => {
    render(
      <Workspace data-ws="1">
        <Pane label="列表" as="nav" size="list" head={<span>头</span>} foot={<span>脚</span>} data-p="1">
          <span>身</span>
        </Pane>
      </Workspace>,
    );
    const nav = screen.getByRole('navigation', { name: '列表' });
    expect(nav.getAttribute('data-p')).toBe('1');
    expect(nav.textContent).toBe('头身脚');
    expect(document.querySelector('[data-ws]')).not.toBeNull();
  });

  test('column 把内容放进居中一列', () => {
    const { container } = render(
      <Pane label="对话" column>
        <span>话</span>
      </Pane>,
    );
    expect(container.querySelector('.max-w-chat')?.textContent).toBe('话');
  });
});

describe('ChoiceRow', () => {
  test('点一下选中；选中那行 aria-current；多选时 aria-pressed 跟着 checked', () => {
    const onClick = vi.fn();
    render(
      <ul>
        <ChoiceRow title="一条" selected checked={false} onClick={onClick} meta="预览" data-row="1" />
      </ul>,
    );
    const btn = screen.getByRole('button');
    expect(btn.getAttribute('aria-current')).toBe('true');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-row]')).not.toBeNull();
  });

  test('长按调 onLongPress，长按之后那一下点击不算选中', () => {
    vi.useFakeTimers();
    const onClick = vi.fn();
    const onLongPress = vi.fn();
    render(
      <ul>
        <ChoiceRow title="一条" onClick={onClick} onLongPress={onLongPress} />
      </ul>,
    );
    const btn = screen.getByRole('button');
    fireEvent.pointerDown(btn);
    vi.advanceTimersByTime(600);
    fireEvent.pointerUp(btn);
    fireEvent.click(btn);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  test('compact 只剩头像位和状态点，菜单和第二行不画', () => {
    render(
      <ul>
        <ChoiceRow
          compact
          title="一条"
          meta="预览"
          menu={<button type="button">菜单</button>}
          leading={<span>头</span>}
          tags={<span>点</span>}
          onClick={() => {}}
        />
      </ul>,
    );
    expect(screen.queryByText('预览')).toBeNull();
    expect(screen.queryByText('菜单')).toBeNull();
    expect(screen.getByText('点')).toBeTruthy();
  });
});
