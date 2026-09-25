// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { PALETTES, THEME_KEY } from '../../lib/theme';
import { ThemeProvider, useTheme } from '../theme-provider';
import { PaletteSwatch } from './palette-swatch';
import { ModeSwitch } from './topbar';

function Picker() {
  const { pref, resolvedMode, setPalette } = useTheme();
  return (
    <>
      <ModeSwitch />
      {PALETTES.map((p) => (
        <PaletteSwatch
          key={p.id}
          id={p.id}
          mode={resolvedMode}
          active={pref.palette === p.id}
          onPick={setPalette}
        />
      ))}
    </>
  );
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

test('点一套主题色：页面立刻换色，下次打开还记得', () => {
  render(
    <ThemeProvider>
      <Picker />
    </ThemeProvider>,
  );
  act(() => {
    fireEvent.click(screen.getByRole('button', { name: '主题色：北境' }));
  });
  expect(document.documentElement.dataset.palette).toBe('nord');
  expect(JSON.parse(localStorage.getItem(THEME_KEY) ?? '{}').palette).toBe('nord');
  expect(screen.getByRole('button', { name: '主题色：北境' }).getAttribute('aria-pressed')).toBe('true');
});

test('深浅切换写到根节点上，所有主题色的小样都跟着换', () => {
  render(
    <ThemeProvider>
      <Picker />
    </ThemeProvider>,
  );
  act(() => {
    fireEvent.click(screen.getByRole('radio', { name: '深色' }));
  });
  expect(document.documentElement.dataset.mode).toBe('dark');
  const swatches = document.querySelectorAll('[aria-label^="主题色："] [data-palette]');
  expect(swatches.length).toBe(PALETTES.length);
  for (const s of swatches) expect(s.getAttribute('data-mode')).toBe('dark');

  act(() => {
    fireEvent.click(screen.getByRole('radio', { name: '浅色' }));
  });
  expect(document.documentElement.dataset.mode).toBe('light');
});
