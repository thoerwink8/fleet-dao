// 公开仓：夹具是真机回包脱敏来的，这里扫一遍，凭据、邮箱、IP、账号编号、服务用户名一律不许混进来。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURES } from './helpers.ts';

const EXAMPLE = join(FIXTURES, '..', '..', '..', '..', '..', 'deploy', 'examples', 'quota.example.json');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const PATTERNS: [string, RegExp][] = [
  ['邮箱', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/],
  ['IP', /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/],
  ['JWT', /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['API key', /\b(?:sk|rk|xai)-[A-Za-z0-9_-]{12,}/],
  ['长令牌', /[A-Za-z0-9+/_-]{48,}/],
  ['服务用户家目录', /\/home\/(?!<)[a-z]/],
  ['服务用户名', /\borca\b/i],
];

describe('夹具与样例配置已脱敏', () => {
  const files = [...walk(FIXTURES), EXAMPLE];

  it('扫到了文件（不是空扫一遍就算过）', () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  for (const file of files) {
    it(relative(join(FIXTURES, '..'), file), () => {
      const text = readFileSync(file, 'utf8');
      const hits = PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
      expect(hits).toEqual([]);
    });
  }
});
