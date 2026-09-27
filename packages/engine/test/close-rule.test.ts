// 关单要有结果（#241）：引擎第 6 步收的 结果.md（core 的 specDocs）就是 pnpm issue:close、合并闸、每天对账认的那一份
// （conventions 的 resultDocOf）。两边在两个包里（合并闸不装依赖、只引 conventions；core 只许依赖 shared 和 zod），
// 引擎两个都依赖，在这里钉住别走岔：哪边改了文件名、目录写法，这里先红。
import { RESULT_FILE, resultDocOf } from '@fleet-dao/conventions';
import { SPEC_FILES, specDocs, specOf } from '@fleet-dao/core';
import { describe, expect, it } from 'vitest';

describe('引擎收的结果文档和关单认的是同一份', () => {
  it('文件名一样', () => {
    expect(SPEC_FILES.result).toBe(RESULT_FILE);
  });

  it.each([
    [
      '正文指着需求文档的',
      { body: '文档：`specs/<本单号>-登录验证码/需求.md`（完整需求）', issueNumber: 12, title: '登录' },
    ],
    [
      '正文写全了需求、照标题取短名的（#295）',
      { body: '## 怎么算做完\n\n- 测试：过期的验证码被拒。', issueNumber: 13, title: '关单 要有「结果」！' },
    ],
  ])('%s：第 6 步要的 结果.md，关单也认；别的单不认', (_name, input) => {
    const got = specOf(input);
    if ('error' in got) throw new Error(got.error);
    const { result } = specDocs(got.ok);
    expect(resultDocOf(input.issueNumber, [result])).toBe(result);
    expect(resultDocOf(input.issueNumber + 1, [result])).toBeUndefined();
  });
});
