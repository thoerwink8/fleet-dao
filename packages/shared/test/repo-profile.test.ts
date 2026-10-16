import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REPO_PROFILE,
  parseRepoProfile,
  REPO_PROFILE_KEYS,
  repoProfileGaps,
  safeParseRepoProfile,
} from '../src/repo-profile.ts';

describe('仓档案', () => {
  it('缺项一律补默认值：空对象、null 都得到完整的档案', () => {
    expect(parseRepoProfile({})).toEqual(DEFAULT_REPO_PROFILE);
    expect(parseRepoProfile(null)).toEqual(DEFAULT_REPO_PROFILE);
    expect(parseRepoProfile(undefined)).toEqual(DEFAULT_REPO_PROFILE);
    expect(DEFAULT_REPO_PROFILE).toEqual({
      language: 'unknown',
      toolchain: [],
      testCommand: 'pnpm check',
      moduleRoots: [],
      mergeSignals: [],
      standardPathsFile: 'packages/conventions/standard-paths.json',
      weight: 1,
    });
  });

  it('给了的项照用，没给的补默认值', () => {
    const p = parseRepoProfile({
      language: 'go',
      moduleRoots: ['cmd/*', 'internal/*'],
      testCommand: 'go test ./...',
    });
    expect(p).toEqual({
      ...DEFAULT_REPO_PROFILE,
      language: 'go',
      moduleRoots: ['cmd/*', 'internal/*'],
      testCommand: 'go test ./...',
    });
  });

  it('fleet-dao 回填的那一份认得出', () => {
    expect(
      parseRepoProfile({ moduleRoots: ['packages/*'], mergeSignals: ['merge-gate', 'cold-verify'] }),
    ).toMatchObject({
      moduleRoots: ['packages/*'],
      mergeSignals: ['merge-gate', 'cold-verify'],
    });
  });

  it.each([
    ['认不出的键（多半是拼错）', { mergeSignal: ['merge-gate'] }, 'mergeSignal'],
    ['不是对象', ['packages/*'], ''],
    ['语言是空串', { language: '' }, 'language'],
    ['测试命令是空白', { testCommand: '   ' }, 'testCommand'],
    ['模块根不是数组', { moduleRoots: 'packages/*' }, 'moduleRoots'],
    ['模块根写成绝对路径', { moduleRoots: ['/packages/*'] }, 'moduleRoots'],
    ['模块根往上跳', { moduleRoots: ['../x'] }, 'moduleRoots'],
    ['检查名重复', { mergeSignals: ['merge-gate', 'merge-gate'] }, 'mergeSignals'],
    ['权重是 0', { weight: 0 }, 'weight'],
    ['权重不是整数', { weight: 1.5 }, 'weight'],
    ['标准清单写成绝对路径', { standardPathsFile: '/etc/x.json' }, 'standardPathsFile'],
  ])('形状不对就拒：%s', (_why, raw, key) => {
    const r = safeParseRepoProfile(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(key);
    expect(() => parseRepoProfile(raw)).toThrow(/仓档案/);
  });

  it('缺了哪几项：只看显式写了没有，不看默认值', () => {
    expect(repoProfileGaps({})).toEqual([...REPO_PROFILE_KEYS]);
    expect(repoProfileGaps(null)).toEqual([...REPO_PROFILE_KEYS]);
    expect(repoProfileGaps({ moduleRoots: ['packages/*'], mergeSignals: [] })).toEqual(
      REPO_PROFILE_KEYS.filter((k) => k !== 'moduleRoots' && k !== 'mergeSignals'),
    );
    const full = Object.fromEntries(REPO_PROFILE_KEYS.map((k) => [k, DEFAULT_REPO_PROFILE[k]]));
    expect(repoProfileGaps(full)).toEqual([]);
  });
});
