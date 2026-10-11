// cn()：自定义字号档位（app.css 的 --text-*）和文字颜色放进同一个 cn() 时，两样都留着；同是字号的，后写的赢。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { cn, FONT_SIZE_TOKENS, RING_WIDTH_TOKENS } from './utils';

describe('cn 认得自定义字号档位', () => {
  test('【故意造出的失败】字号档位 + 颜色：字号不被当成颜色吞掉（额度页用满的大数字、带颜色的指标卡丢过字号）', () => {
    expect(cn('text-heading font-semibold', 'text-ink-fail')).toBe(
      'text-heading font-semibold text-ink-fail',
    );
    expect(cn('num mt-2 text-display', 'text-ink-stall')).toBe('num mt-2 text-display text-ink-stall');
    expect(cn('mt-1.5 text-meta', 'text-muted-foreground')).toBe('mt-1.5 text-meta text-muted-foreground');
  });

  test('两个字号：后写的赢；两个颜色：后写的赢', () => {
    expect(cn('text-meta', 'text-title')).toBe('text-title');
    expect(cn('text-sm', 'text-heading')).toBe('text-heading');
    expect(cn('text-ink-fail', 'text-ink-stall')).toBe('text-ink-stall');
    expect(cn('text-meta', 'text-body')).toBe('text-body');
    expect(cn('text-heading', 'text-ink-fail')).toBe('text-heading text-ink-fail');
  });

  test('阴影档位：后写的赢，不当成阴影颜色', () => {
    expect(cn('shadow-xs', 'shadow-card')).toBe('shadow-card');
    expect(cn('shadow-card', 'shadow-overlay')).toBe('shadow-overlay');
  });

  test('档位清单和 app.css 的 --text-* 一致（app.css 加减档位忘了改这里会红）', () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'app.css'), 'utf8');
    // --text-meta--line-height 这种是字号附带的行高、字重，不算一档。
    const inCss = [...css.matchAll(/^\s*--text-([a-z][a-z0-9]*(?:-[a-z0-9]+)*):/gm)].map((m) => m[1]);
    expect([...inCss].sort()).toEqual([...FONT_SIZE_TOKENS].sort());
  });

  test('聚焦圈 token 和数字档位冲突时后写的赢，和颜色不互相吞', () => {
    expect(cn('focus-visible:ring-focus', 'focus-visible:ring-2')).toBe('focus-visible:ring-2');
    expect(cn('focus-visible:ring-3', 'focus-visible:ring-focus')).toBe('focus-visible:ring-focus');
    expect(cn('focus-visible:ring-focus', 'focus-visible:ring-ring/50')).toBe(
      'focus-visible:ring-focus focus-visible:ring-ring/50',
    );
  });

  test('聚焦圈档位和 app.css 的 --ring-width-* 一致（忘了登记 cn() 会红）', () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'app.css'), 'utf8');
    const inCss = [...css.matchAll(/^\s*--ring-width-([a-z][a-z0-9-]*):/gm)].map((m) => m[1]);
    expect([...inCss].sort()).toEqual([...RING_WIDTH_TOKENS].sort());
  });
});
