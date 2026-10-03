// cn()：自定义字号档位（app.css 的 --text-*）和文字颜色放进同一个 cn() 时，两样都留着；同是字号的，后写的赢。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { cn, FONT_SIZE_TOKENS } from './utils';

describe('cn 认得自定义字号档位', () => {
  test('【故意造出的失败】字号档位 + 颜色：字号不被当成颜色吞掉（额度页用满的大数字、带颜色的指标卡丢过字号）', () => {
    expect(cn('text-stat-num font-semibold', 'text-ink-fail')).toBe(
      'text-stat-num font-semibold text-ink-fail',
    );
    expect(cn('num mt-2 text-stat', 'text-ink-stall')).toBe('num mt-2 text-stat text-ink-stall');
    expect(cn('mt-1.5 text-caption', 'text-muted-foreground')).toBe(
      'mt-1.5 text-caption text-muted-foreground',
    );
  });

  test('两个字号：后写的赢；两个颜色：后写的赢', () => {
    expect(cn('text-caption', 'text-sub')).toBe('text-sub');
    expect(cn('text-sm', 'text-strong')).toBe('text-strong');
    expect(cn('text-ink-fail', 'text-ink-stall')).toBe('text-ink-stall');
  });

  test('档位清单和 app.css 的 --text-* 一致（app.css 加减档位忘了改这里会红）', () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'app.css'), 'utf8');
    const inCss = [...css.matchAll(/^\s*--text-([a-z][a-z0-9-]*):/gm)].map((m) => m[1]);
    expect([...inCss].sort()).toEqual([...FONT_SIZE_TOKENS].sort());
  });
});
