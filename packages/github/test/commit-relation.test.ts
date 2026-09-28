// commitContains：流程配置对账判「新字段是不是还没发布的引擎版本才认得」用它（jobs/flow-config.ts）。
import { describe, expect, it } from 'vitest';
import { json, repo, setup, sha } from './helpers.ts';

const BASE = sha('a');
const HEAD = sha('b');

describe('commitContains：base...head 谁含谁', () => {
  it('head 含着 base（behind_by = 0）：回 true', async () => {
    const { gh, fake } = setup();
    fake.behindBy.set(HEAD, 0);
    expect(await gh.commitContains({ repo, base: BASE, head: HEAD })).toBe(true);
  });

  it('head 不含 base（behind_by > 0）：回 false', async () => {
    const { gh, fake } = setup();
    fake.behindBy.set(HEAD, 3);
    expect(await gh.commitContains({ repo, base: BASE, head: HEAD })).toBe(false);
  });

  it('【失败】两个提交比较不出关系（GitHub 回 404，多半不是同一个仓）：回 null，不当成「不含」', async () => {
    const { gh, fake } = setup();
    fake.before.push((req) =>
      req.path.includes('/compare/') ? json(404, { message: 'no common ancestor' }) : undefined,
    );
    expect(await gh.commitContains({ repo, base: BASE, head: HEAD })).toBeNull();
  });

  it('【失败】GitHub 的返回认不出（不是 404）：抛错，不当判不出悄悄放过', async () => {
    const { gh, fake } = setup();
    fake.before.push((req) => (req.path.includes('/compare/') ? json(200, { odd: true }) : undefined));
    await expect(gh.commitContains({ repo, base: BASE, head: HEAD })).rejects.toMatchObject({
      code: 'UNEXPECTED_RESPONSE',
    });
  });
});
