// 终端 16 色对着 inset 背景至少 4.5:1。色值只在 app.css 的两套主题里。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const NAMES = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'bright-black',
  'bright-red',
  'bright-green',
  'bright-yellow',
  'bright-blue',
  'bright-magenta',
  'bright-cyan',
  'bright-white',
] as const;

function lin(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function lum(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

function contrast(a: string, b: string): number {
  const hi = Math.max(lum(a), lum(b));
  const lo = Math.min(lum(a), lum(b));
  return (hi + 0.05) / (lo + 0.05);
}

function block(css: string, selector: string): Map<string, string> {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`找不到 ${selector}`);
  const open = css.indexOf('{', start);
  let depth = 0;
  let end = open;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const vars = new Map<string, string>();
  for (const match of css.slice(open + 1, end).matchAll(/(--fleet-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    vars.set(match[1] ?? '', (match[2] ?? '').trim());
  }
  return vars;
}

describe('终端 16 色', () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'app.css'), 'utf8');
  const themes = [
    ['浅色', block(css, ':root {')],
    ['深色', block(css, ':root.dark {')],
  ] as const;

  it('两套主题里每一色对着 inset 都至少 4.5:1', () => {
    const low: string[] = [];
    for (const [label, vars] of themes) {
      const bg = vars.get('--fleet-layer-inset');
      expect(bg, label).toMatch(/^#[0-9a-f]{6}$/);
      for (const name of NAMES) {
        const hex = vars.get(`--fleet-term-${name}`);
        expect(hex, `${label} ${name}`).toMatch(/^#[0-9a-f]{6}$/);
        const ratio = contrast(hex ?? '#000000', bg ?? '#000000');
        if (ratio < 4.5) low.push(`${label} ${name} ${hex} ${ratio.toFixed(2)}`);
      }
    }
    expect(low).toEqual([]);
  });
});
