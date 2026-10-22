// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  ClampedText,
  OutputBox,
  StepDivider,
  SubagentFrame,
  ToolToggle,
  TranscriptFooter,
  TranscriptItem,
  TranscriptList,
  TranscriptPane,
} from './transcript';

afterEach(cleanup);

describe('TranscriptPane', () => {
  test('筛选条、搜索、正文、底栏各在各的位置；正文是自己滚的那块，滚动事件和 ref 交给页面', () => {
    const onScroll = vi.fn();
    const ref = { current: null as HTMLDivElement | null };
    render(
      <TranscriptPane
        filters={<span>筛选</span>}
        search={<span>搜索</span>}
        footer={<TranscriptFooter action={<button type="button">跳到最新</button>}>还在跑</TranscriptFooter>}
        scrollRef={ref}
        onScroll={onScroll}
      >
        <p>正文</p>
      </TranscriptPane>,
    );
    const filters = document.querySelector('[data-transcript-filters]') as HTMLElement;
    expect(filters.textContent).toBe('筛选搜索');
    const body = document.querySelector('[data-transcript-body]') as HTMLElement;
    expect(ref.current).toBe(body);
    expect(body.textContent).toBe('正文');
    fireEvent.scroll(body);
    expect(onScroll).toHaveBeenCalledTimes(1);
    const live = document.querySelector('[data-live]') as HTMLElement;
    expect(live.textContent).toBe('还在跑跳到最新');
  });

  test('没给筛选和搜索就不画筛选条', () => {
    render(<TranscriptPane>正文</TranscriptPane>);
    expect(document.querySelector('[data-transcript-filters]')).toBeNull();
  });
});

describe('TranscriptList / TranscriptItem', () => {
  test('ol 带名字；一条一个 li，记块种类和条目序号', () => {
    render(
      <TranscriptList label="会话内容">
        <TranscriptItem block="say" seq={3}>
          一句话
        </TranscriptItem>
        <TranscriptItem block="divider">分隔</TranscriptItem>
      </TranscriptList>,
    );
    expect(screen.getByRole('list', { name: '会话内容' })).toBeTruthy();
    const [say, divider] = Array.from(document.querySelectorAll('li'));
    expect(say?.dataset.block).toBe('say');
    expect(say?.dataset.seq).toBe('3');
    expect(divider?.dataset.block).toBe('divider');
    expect(divider?.dataset.seq).toBeUndefined();
  });
});

describe('StepDivider', () => {
  test('圆圈里是序号加一，后面标题、起止和用时', () => {
    render(<StepDivider index={1} title="第 2 步" tail="10:48:20 · 8 分" />);
    const d = document.querySelector('[data-step-divider]') as HTMLElement;
    expect(d.dataset.stepDivider).toBe('1');
    expect(d.textContent).toBe('2第 2 步· 10:48:20 · 8 分');
    expect(d.dataset.tone).toBe('default');
  });

  test.each(['processing', 'error'] as const)('tone=%s 记在 data-tone 上；flag 摆在标题后面', (tone) => {
    render(<StepDivider index={0} title="第 1 步" tone={tone} flag={<span>有失败</span>} />);
    const d = document.querySelector('[data-step-divider]') as HTMLElement;
    expect(d.dataset.tone).toBe(tone);
    expect(d.textContent).toContain('有失败');
  });
});

describe('ToolToggle', () => {
  test('按钮带 aria-expanded，点一下通知页面；开着才画下面的内容', () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <ToolToggle open={false} onToggle={onToggle} lead="已运行" label="git status" data-call>
        <p>输出</p>
      </ToolToggle>,
    );
    const btn = screen.getByRole('button');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.textContent).toBe('已运行git status');
    expect(screen.queryByText('输出')).toBeNull();
    expect(document.querySelector('[data-call]')).toBeTruthy();
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledTimes(1);
    rerender(
      <ToolToggle open onToggle={onToggle} lead="已运行" label="git status">
        <p>输出</p>
      </ToolToggle>,
    );
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('输出')).toBeTruthy();
  });

  test('行尾标记在按钮里面；对象带悬停全文', () => {
    render(
      <ToolToggle
        open={false}
        onToggle={() => undefined}
        label="很长的命令"
        title="很长的命令全文"
        trailing={<i>没读到结果</i>}
      />,
    );
    expect(screen.getByRole('button').textContent).toBe('很长的命令没读到结果');
    expect(screen.getByTitle('很长的命令全文')).toBeTruthy();
  });
});

describe('OutputBox / SubagentFrame / ClampedText', () => {
  test('输出框：failed 记 data-tone=danger；可以带小标题', () => {
    render(
      <>
        <OutputBox label="它回的话" indent={false}>
          找到了
        </OutputBox>
        <OutputBox failed>FAIL</OutputBox>
      </>,
    );
    const [a, b] = Array.from(document.querySelectorAll<HTMLElement>('[data-tone]'));
    expect(a?.dataset.tone).toBe('muted');
    expect(a?.textContent).toBe('它回的话找到了');
    expect(b?.dataset.tone).toBe('danger');
  });

  test('子代理卡：头一句话；点头通知页面；开着才画里面', () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <SubagentFrame
        open={false}
        onToggle={onToggle}
        head="子代理 scout · 找文件 · 1 次调用"
        trailing={<b>在跑</b>}
      >
        <p>它说的话</p>
      </SubagentFrame>,
    );
    expect(document.querySelector('[data-subagent-head]')?.textContent).toBe(
      '子代理 scout · 找文件 · 1 次调用',
    );
    expect(screen.queryByText('它说的话')).toBeNull();
    fireEvent.click(screen.getByRole('button'));
    expect(onToggle).toHaveBeenCalled();
    rerender(
      <SubagentFrame open onToggle={onToggle} head="子代理">
        <p>它说的话</p>
      </SubagentFrame>,
    );
    expect(screen.getByText('它说的话')).toBeTruthy();
  });

  test('超长文字：lines 只露前几行（data-clamped），不给就整段', () => {
    render(
      <>
        <ClampedText lines={2}>一</ClampedText>
        <ClampedText lines={4}>二</ClampedText>
        <ClampedText>三</ClampedText>
      </>,
    );
    expect(screen.getByText('一').dataset.clamped).toBe('2');
    expect(screen.getByText('二').dataset.clamped).toBe('4');
    expect(screen.getByText('三').dataset.clamped).toBeUndefined();
  });
});
