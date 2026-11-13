import { describe, expect, it } from 'vitest';
import { themeToggleLabel } from './theme';

describe('主题按钮', () => {
  it('写要切过去的那一侧，不写当前这侧的一个字', () => {
    expect(themeToggleLabel('light')).toBe('切到深色');
    expect(themeToggleLabel('dark')).toBe('切到浅色');
  });
});
