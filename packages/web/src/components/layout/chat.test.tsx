// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Chat, Composer, Message } from './chat';

afterEach(cleanup);

describe('Chat / Message', () => {
  test('三种角色三种样子：me 靠右蓝底、other 浅灰底、tool 细框等宽', () => {
    const { container } = render(
      <Chat
        messages={[
          { role: 'me', meta: '你 10:00', body: '开个单' },
          { role: 'other', body: '好的' },
          { role: 'tool', body: 'gh issue create' },
        ]}
      />,
    );
    const roles = Array.from(container.querySelectorAll<HTMLElement>('[data-role]'));
    expect(roles.map((r) => r.dataset.role)).toEqual(['me', 'other', 'tool']);
    expect(roles[0]?.className).toContain('self-end');
    expect(screen.getByText('开个单').className).toContain('bg-brand-1');
    expect(screen.getByText('好的').className).toContain('bg-fill-1');
    expect(screen.getByText('gh issue create').className).toContain('font-mono');
    expect(screen.getByText('你 10:00').className).toContain('text-ink-3');
  });

  test('role=log 读屏跟随；没有消息画 empty', () => {
    const { rerender } = render(<Chat messages={[{ role: 'other', body: 'x' }]} />);
    expect(screen.getByRole('log')).toBeTruthy();
    rerender(<Chat messages={[]} empty={<span>还没有对话</span>} />);
    expect(screen.getByText('还没有对话')).toBeTruthy();
  });

  test('Message 单用', () => {
    // biome-ignore lint/a11y/useValidAriaRole: role 是消息的角色（me、other、tool），不是 ARIA role。
    render(<Message role="other">一句话</Message>);
    expect(screen.getByText('一句话')).toBeTruthy();
  });
});

describe('Composer', () => {
  test('空白不能发；有字点发送调 onSend', () => {
    const onSend = vi.fn();
    const { rerender } = render(<Composer value="  " onChange={() => {}} onSend={onSend} />);
    const send = screen.getByRole('button', { name: '发送' });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    rerender(<Composer value="你好" onChange={() => {}} onSend={onSend} />);
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  test('⌘/Ctrl+Enter 发送，单按 Enter 只是换行；输入走 onChange', () => {
    const onSend = vi.fn();
    const onChange = vi.fn();
    render(<Composer value="你好" onChange={onChange} onSend={onSend} placeholder="说点什么" />);
    const box = screen.getByPlaceholderText('说点什么');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    expect(onSend).toHaveBeenCalledTimes(1);
    fireEvent.change(box, { target: { value: '你好啊' } });
    expect(onChange).toHaveBeenCalledWith('你好啊');
  });

  test('sending 时发不出；disabled 时灰字写原因', () => {
    const onSend = vi.fn();
    const { rerender } = render(<Composer value="你好" onChange={() => {}} onSend={onSend} sending />);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', metaKey: true });
    expect(onSend).not.toHaveBeenCalled();
    rerender(
      <Composer value="你好" onChange={() => {}} onSend={onSend} disabled disabledReason="只读环境" />,
    );
    expect(screen.getByText('只读环境')).toBeTruthy();
  });
});
