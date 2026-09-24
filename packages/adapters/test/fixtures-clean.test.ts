// 公开仓：夹具里不许有能认出人、账号、机器的东西。以后新夹具进仓，这道测试把关。
// 插头夹具（test/fixtures）按原约定放行会话编号这类一次性随机号；额度夹具（test/quota/fixtures）与
// 装机样例配置更严：连 UUID 也不许有（只放行全零开头的占位号）——那边的回包里编号多半是账号、用户、组织。
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURES } from './helpers.ts';

const QUOTA_FIXTURES = join(FIXTURES, '..', 'quota', 'fixtures');
const QUOTA_EXAMPLE = join(FIXTURES, '..', '..', '..', '..', 'deploy', 'examples', 'quota.example.json');

const RULES: [string, RegExp][] = [
  ['邮箱', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g],
  ['IP', /\b(?!(?:127\.0\.0\.1|0\.0\.0\.0)\b)(?:\d{1,3}\.){3}\d{1,3}\b/g],
  // 大小写都算，JSON 转义的斜杠（\/）、Windows 反斜杠（C:\\Users\\…）也算；/home/agent 与 <占位> 放行
  ['家目录里的用户名', /[\\/]{1,2}(?:home|users)[\\/]{1,2}(?!agent\b|<)[A-Za-z0-9_.-]+/gi],
  ['令牌', /\b(?:gh[pousr]_|github_pat_|sk-ant-|xai-)[A-Za-z0-9_-]{8,}/g],
  ['API key', /\bsk-[A-Za-z0-9_-]{20,}/g],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  // Claude 的 thinking signature 里编着账号级编号，必须打码
  ['没打码的 signature', /"signature"\s*:\s*"(?!<redacted>")[^"]+"/gi],
  ['签名头', /\bx-[a-z-]*signature\b\s*[:=]\s*[A-Za-z0-9+/=_-]{8,}/gi],
];

const STRICT_RULES: [string, RegExp][] = [
  ['UUID', /\b(?!00000000-0000-)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi],
];

function scan(text: string, rules: [string, RegExp][]): string[] {
  return rules.flatMap(([label, re]) => [...text.matchAll(re)].map((m) => `${label}：${m[0].slice(0, 60)}`));
}

export function findLeaks(text: string): string[] {
  return scan(text, RULES);
}

/** 额度夹具与样例配置用的严格版：多查一道 UUID。 */
export function findStrictLeaks(text: string): string[] {
  return scan(text, [...RULES, ...STRICT_RULES]);
}

function allFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? allFiles(join(dir, d.name)) : [join(dir, d.name)],
  );
}

describe('夹具脱敏', () => {
  it('插头夹具每个文件都干净', () => {
    const files = allFiles(FIXTURES);
    expect(files.length).toBeGreaterThan(0);
    const leaks = files.flatMap((f) =>
      findLeaks(readFileSync(f, 'utf8')).map((l) => `${relative(FIXTURES, f)} ${l}`),
    );
    expect(leaks).toEqual([]);
  });

  it('额度夹具和装机样例配置更严：连 UUID 也不许有', () => {
    const files = [...allFiles(QUOTA_FIXTURES), QUOTA_EXAMPLE];
    // 扫到了文件才算数：空扫一遍不等于干净。
    expect(files.length).toBeGreaterThanOrEqual(10);
    const leaks = files.flatMap((f) =>
      findStrictLeaks(readFileSync(f, 'utf8')).map((l) => `${relative(QUOTA_FIXTURES, f)} ${l}`),
    );
    expect(leaks).toEqual([]);
  });

  it('故意放进去的违规样本都拦得住', () => {
    const samples = [
      'mail me: someone@example.com',
      'host 10.2.3.4',
      '"auto":"/home/orca/.claude/projects/x"',
      '"cwd":"\\/home\\/orca\\/work"',
      'path /HOME/Orca/.grok/auth.json',
      '"cwd":"C:\\\\Users\\\\Administrator\\\\.codex"',
      'token ghs_abcdefghijklmnop',
      'refresh ghr_abcdefghijklmnop',
      'key sk-proj-abcdefghijklmnopqrstuvwxyz',
      'bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0',
      '{"type":"thinking","signature":"ErEECrIBCBIYAipA"}',
      '{"Signature": "ErEECrIBCBIYAipA"}',
      'X-Reclaude-Signature: AbCdEf0123456789',
    ];
    for (const s of samples) expect(findLeaks(s), s).toHaveLength(1);
    expect(findLeaks('agents-md@builtin · 127.0.0.1 · /home/agent · "signature":"<redacted>"')).toEqual([]);
    expect(findLeaks('"dir":"/home/<服务用户>/.dao/judge-spend"')).toEqual([]);
  });

  it('严格版多拦 UUID，只放行全零开头的占位号', () => {
    expect(findStrictLeaks('"userId":"3f2b8c1e-9d4a-4b7e-8f1a-2c3d4e5f6a7b"')).toHaveLength(1);
    expect(findStrictLeaks('"session_id":"00000000-0000-4000-8000-000000000001"')).toEqual([]);
    // 插头夹具沿用原约定：会话编号这类随机号放行
    expect(findLeaks('"session_id":"3f2b8c1e-9d4a-4b7e-8f1a-2c3d4e5f6a7b"')).toEqual([]);
  });
});
