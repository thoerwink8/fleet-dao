import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const { flushQuotesInBackground } = (await import(
  new URL('../hooks/session-start.mjs', import.meta.url).href
)) as {
  flushQuotesInBackground(input: {
    home: string;
    script: string;
    run: (
      cmd: string,
      args: string[],
      opts: Record<string, unknown>,
    ) => { status: number; stdout: string; stderr: string };
  }): string[];
};
const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});
it('开场补传只在后台执行，失败有明确一句且不缓存私有回执', () => {
  const home = mkdtempSync(join(tmpdir(), 'quote-hook-'));
  homes.push(home);
  const dir = join(home, '.fleet-dao/private/quotes');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'fixture.json'), '合成私有内容');
  let calls = 0;
  const run = (_cmd: string, args: string[], opts: Record<string, unknown>) => {
    calls++;
    expect(args).toEqual(['fixture-progress.ts', 'quotes:flush']);
    expect(opts.timeout).toBeGreaterThan(0);
    return { status: 2, stdout: '合成私有内容', stderr: 'synthetic-password' };
  };
  const lines = flushQuotesInBackground({ home, script: 'fixture-progress.ts', run });
  expect(calls).toBe(1);
  expect(lines.join('')).toContain('没传成');
  expect(JSON.stringify(lines)).not.toMatch(/合成私有内容|synthetic-password/);
  expect(existsSync(join(dir, 'fixture.json'))).toBe(true);
  expect(
    flushQuotesInBackground({
      home,
      script: 'fixture-progress.ts',
      run: () => ({ status: 0, stdout: '', stderr: '' }),
    }),
  ).toEqual([]);
});
