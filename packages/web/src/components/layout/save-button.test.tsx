// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { SaveButton } from './save-button';

afterEach(cleanup);

describe('SaveButton', () => {
  test('能存：默认是品牌实色；variant=secondary 是灰底次按钮（一页好几个保存键并列时用）', () => {
    const { rerender } = render(<SaveButton canSave />);
    const primary = screen.getByRole('button', { name: '保存' });
    expect(primary.getAttribute('data-state')).toBe('ready');
    expect(primary.className).toContain('bg-brand');
    rerender(<SaveButton canSave variant="secondary" />);
    const quiet = screen.getByRole('button', { name: '保存' });
    expect(quiet.getAttribute('data-state')).toBe('ready');
    expect(quiet.className).not.toContain('bg-brand');
  });

  test('没东西可存、正在存：点不了，灰底', () => {
    const { rerender } = render(<SaveButton canSave={false} />);
    const off = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement;
    expect(off.disabled).toBe(true);
    expect(off.getAttribute('data-state')).toBe('disabled');
    expect(off.className).toContain('bg-muted');
    rerender(<SaveButton canSave pending />);
    expect((screen.getByRole('button') as HTMLButtonElement).getAttribute('data-state')).toBe('disabled');
  });
});
