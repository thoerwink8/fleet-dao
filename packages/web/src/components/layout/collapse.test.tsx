// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { Collapse } from './collapse';

afterEach(cleanup);

describe('Collapse', () => {
  test('默认收着：按钮 aria-expanded=false，内容 aria-hidden 且 inert', () => {
    render(<Collapse title="高级">内容</Collapse>);
    const btn = screen.getByRole('button', { name: '高级' });
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    const region = screen.getByText('内容').closest('[aria-hidden]') as HTMLElement;
    expect(region.getAttribute('aria-hidden')).toBe('true');
    expect(region.hasAttribute('inert')).toBe(true);
  });

  test('defaultOpen 一开始就开着', () => {
    render(
      <Collapse title="高级" defaultOpen>
        内容
      </Collapse>,
    );
    expect(screen.getByRole('button', { name: '高级' }).getAttribute('aria-expanded')).toBe('true');
    expect(
      (screen.getByText('内容').closest('[aria-hidden]') as HTMLElement).getAttribute('aria-hidden'),
    ).toBe('false');
  });

  test('点标题开合，aria-controls 指到内容', () => {
    render(<Collapse title="高级">内容</Collapse>);
    const btn = screen.getByRole('button', { name: '高级' });
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(btn.getAttribute('aria-controls') as string)).not.toBeNull();
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });
});
