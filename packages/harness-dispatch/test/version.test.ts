// 内核版本号（#3889）：不读源码旁的 package.json，位置怎么挪都能给出版本号。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { kernelVersion, UNBUILT_VERSION } from '../src/profiles/version.ts';

describe('kernelVersion', () => {
  it('注入的值优先', () => {
    expect(kernelVersion('1.2.3')).toBe('1.2.3');
  });
  it('没注入有明确的回退值', () => {
    expect(kernelVersion()).toBe(UNBUILT_VERSION);
    expect(kernelVersion('')).toBe(UNBUILT_VERSION);
  });
  it('local 档案和版本模块都不再读 package.json', () => {
    for (const f of ['../src/profiles/local.ts', '../src/profiles/version.ts']) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8');
      expect(src).not.toMatch(/readFileSync|\.\.\/\.\.\/package\.json/);
    }
  });
});
