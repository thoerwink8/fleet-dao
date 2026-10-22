// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { Dialog } from './dialog';

afterEach(cleanup);

describe('Dialog', () => {
  test('打开时有标题、说明和里面的内容；关着什么都不画', () => {
    const { rerender } = render(
      <Dialog open={false} onOpenChange={() => {}} title="加模型" description="只列没排进来的">
        <p>里面的内容</p>
      </Dialog>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    rerender(
      <Dialog open onOpenChange={() => {}} title="加模型" description="只列没排进来的">
        <p>里面的内容</p>
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog', { name: '加模型' });
    expect(dialog.textContent).toContain('只列没排进来的');
    expect(dialog.textContent).toContain('里面的内容');
  });
});
