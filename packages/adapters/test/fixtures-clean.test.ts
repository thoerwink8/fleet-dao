// 公开仓：夹具里除了会话编号，不许有能认出人、账号、机器的东西。以后新夹具进仓，这道测试把关。
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURES } from './helpers.ts';

const RULES: [string, RegExp][] = [
  ['邮箱', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g],
  ['IP', /\b(?!(?:127\.0\.0\.1|0\.0\.0\.0)\b)(?:\d{1,3}\.){3}\d{1,3}\b/g],
  ['家目录里的用户名', /\/home\/(?!agent\b)[A-Za-z0-9_.-]+/g],
  ['令牌', /\b(?:ghp_|gho_|ghs_|ghu_|github_pat_|sk-ant-|xai-)[A-Za-z0-9_-]{8,}/g],
  // Claude 的 thinking signature 里编着账号级编号，必须打码
  ['没打码的 signature', /"signature":"(?!<redacted>")[^"]+"/g],
];

export function findLeaks(text: string): string[] {
  return RULES.flatMap(([label, re]) => [...text.matchAll(re)].map((m) => `${label}：${m[0].slice(0, 60)}`));
}

function allFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? allFiles(join(dir, d.name)) : [join(dir, d.name)],
  );
}

describe('夹具脱敏', () => {
  it('每个夹具文件都干净', () => {
    const files = allFiles(FIXTURES);
    expect(files.length).toBeGreaterThan(0);
    const leaks = files.flatMap((f) =>
      findLeaks(readFileSync(f, 'utf8')).map((l) => `${relative(FIXTURES, f)} ${l}`),
    );
    expect(leaks).toEqual([]);
  });

  it('故意放进去的违规样本都拦得住', () => {
    const samples = [
      'mail me: someone@example.com',
      'host 10.2.3.4',
      '"auto":"/home/orca/.claude/projects/x"',
      'token ghs_abcdefghijklmnop',
      '{"type":"thinking","signature":"ErEECrIBCBIYAipA"}',
    ];
    for (const s of samples) expect(findLeaks(s)).toHaveLength(1);
    expect(findLeaks('agents-md@builtin · 127.0.0.1 · /home/agent · "signature":"<redacted>"')).toEqual([]);
  });
});
