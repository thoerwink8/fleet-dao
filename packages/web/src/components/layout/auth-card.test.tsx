// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { AuthCard } from './auth-card';

afterEach(cleanup);

describe('AuthCard', () => {
  test('整屏浅灰底居中，一张卡片：h1 标题、说明、表单、卡片下的灰字', () => {
    const { container } = render(
      <AuthCard title="登录驾驶舱" description="用口令进来" footer="v1.2.3">
        <input aria-label="口令" />
      </AuthCard>,
    );
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('登录驾驶舱');
    expect(screen.getByText('用口令进来')).toBeTruthy();
    expect(screen.getByLabelText('口令')).toBeTruthy();
    expect(screen.getByText('v1.2.3')).toBeTruthy();
    const main = container.querySelector('main') as HTMLElement;
    expect(main.className).toContain('bg-page');
    expect(main.className).toContain('min-h-screen');
    expect(container.querySelector('section')?.className).toContain('bg-card');
  });

  test('logo：标题上面画品牌标志', () => {
    const { container } = render(
      <AuthCard title="t" logo>
        x
      </AuthCard>,
    );
    expect(container.querySelector('header svg')).not.toBeNull();
  });

  test('embedded（陈列页里用）不撑满整屏', () => {
    const { container } = render(
      <AuthCard title="t" embedded>
        x
      </AuthCard>,
    );
    expect((container.querySelector('main') as HTMLElement).className).not.toContain('min-h-screen');
  });
});
