// @vitest-environment happy-dom
// 模型强弱档徽标（#2691）：三档各一个字样，没标的不出徽标；路由页模型目录里每个模型旁带上。
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import RoutingPage from '../routes/routing';
import { renderApp } from '../test/harness';
import { ModelStrengthBadge } from './model-strength-badge';

afterEach(cleanup);

describe('ModelStrengthBadge', () => {
  test.each([
    ['strong', '强档'],
    ['standard', '标准档'],
    ['light', '快档'],
  ] as const)('%s 显示「%s」', (strength, word) => {
    const { container } = render(<ModelStrengthBadge strength={strength} />);
    expect(screen.getByText(word)).toBeTruthy();
    expect(container.querySelector(`[data-model-strength="${strength}"]`)).not.toBeNull();
  });

  test('没标的不出徽标', () => {
    const { container } = render(
      <>
        <ModelStrengthBadge strength={undefined} />
        <ModelStrengthBadge strength={null} />
      </>,
    );
    expect(container.querySelector('[data-model-strength]')).toBeNull();
    expect(container.textContent).toBe('');
  });
});

describe('路由页模型目录', () => {
  test('有档位的模型行带徽标，没标的不带', async () => {
    renderApp(<RoutingPage />, { route: '/routing?tab=models' });
    await screen.findByRole('list', { name: '目录里的模型' });
    const row = async (id: string) =>
      waitFor(() => {
        const el = document.querySelector(`li[data-catalog="${id}"]`);
        if (!(el instanceof HTMLElement)) throw new Error(`目录里还没有 ${id}`);
        return el;
      });
    expect((await row('opus-5.5')).querySelector('[data-model-strength="strong"]')?.textContent).toBe('强档');
    expect((await row('sonnet-5')).querySelector('[data-model-strength="standard"]')?.textContent).toBe(
      '标准档',
    );
    expect(
      (await row('deepseek-v4.1-flash')).querySelector('[data-model-strength="light"]')?.textContent,
    ).toBe('快档');
    expect((await row('grok-4.7')).querySelector('[data-model-strength]')).toBeNull();
  });
});
