// 需求文档写进主线：Contents API，全走假服务（不出网、不碰真 git）。
import { describe, expect, it } from 'vitest';
import { validSpecPath } from '../src/contents.ts';
import { json, repo, setup } from './helpers.ts';

describe('validSpecPath', () => {
  it('必须在 specs/ 下、是相对路径，不含 .. 、反斜杠、控制字符', () => {
    expect(validSpecPath('specs/12-登录验证码/需求.md')).toBe(true);
    expect(validSpecPath('specs/x')).toBe(true);
    for (const bad of [
      '',
      'specs',
      'specs/',
      'docs/x.md',
      '/specs/x.md',
      'specs/../x.md',
      'specs/..\\x.md',
      'specs\\x.md',
      `specs/x\u0000.md`,
    ]) {
      expect(validSpecPath(bad)).toBe(false);
    }
  });
});

describe('writeSpecDoc', () => {
  it('新建：以「引擎」身份写，回执带提交号与 blob 地址', async () => {
    const { gh, fake } = setup();
    const path = 'specs/12-登录验证码/需求.md';
    const res = await gh.writeSpecDoc({ repo, path, content: '# 需求\n', message: '写需求文档' });
    expect(res.changed).toBe(true);
    expect(res.commit).not.toBeNull();
    expect(res.path).toBe(path);
    expect(res.url).toContain('/blob/main/');
    expect(fake.specs.get(path)?.content).toBe('# 需求\n');
    const puts = fake.calls('PUT', /\/contents\//);
    expect(puts).toHaveLength(1);
    expect(puts[0]?.as).toBe('engine');
  });

  it('更新：文件已存在，带上读到的 sha 覆盖写', async () => {
    const { gh, fake } = setup();
    const path = 'specs/13-foo/需求.md';
    const first = await gh.writeSpecDoc({ repo, path, content: '版本一\n', message: 'm1' });
    const second = await gh.writeSpecDoc({ repo, path, content: '版本二\n', message: 'm2' });
    expect(second.changed).toBe(true);
    expect(second.commit).not.toBe(first.commit);
    expect(fake.specs.get(path)?.content).toBe('版本二\n');
    expect(fake.calls('PUT', /\/contents\//)).toHaveLength(2);
  });

  it('内容和远端一样：不写，commit 为 null', async () => {
    const { gh, fake } = setup();
    const path = 'specs/14-foo/需求.md';
    await gh.writeSpecDoc({ repo, path, content: '一样的内容\n', message: 'm1' });
    const res = await gh.writeSpecDoc({ repo, path, content: '一样的内容\n', message: 'm2（内容没变）' });
    expect(res).toMatchObject({ changed: false, commit: null, path });
    expect(fake.calls('PUT', /\/contents\//)).toHaveLength(1);
  });

  it('路径出了 specs/：拒收，一个请求都不发', async () => {
    const { gh, fake } = setup();
    await expect(
      gh.writeSpecDoc({ repo, path: 'docs/x.md', content: 'x', message: 'm' }),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    expect(fake.requests).toHaveLength(0);
  });

  it('sha 过期（409）：重读到别人写的新内容，用新 sha 再写一次就成', async () => {
    const { gh, fake } = setup();
    const path = 'specs/15-foo/需求.md';
    await gh.writeSpecDoc({ repo, path, content: '原始\n', message: 'm0' });
    let hit = 0;
    fake.before.push((req) => {
      if (req.method === 'PUT' && req.path.includes('/contents/') && hit === 0) {
        hit += 1;
        // 模拟：我们读完之后，别人抢先改了一版
        fake.specs.set(path, { sha: 'c'.repeat(40), content: '别人改的\n' });
        return json(409, { message: 'x does not match' });
      }
      return undefined;
    });
    const res = await gh.writeSpecDoc({ repo, path, content: '我们要写的\n', message: 'm1' });
    expect(res.changed).toBe(true);
    expect(fake.specs.get(path)?.content).toBe('我们要写的\n');
    expect(fake.calls('PUT', /\/contents\//)).toHaveLength(3); // m0 一次 + m1 撞 409 一次 + m1 重试成功一次
  });

  it('权限不够（403）：明确报错，不当成可重试的冲突', async () => {
    const { gh, fake } = setup();
    fake.before.push((req) =>
      req.method === 'PUT' && req.path.includes('/contents/')
        ? json(403, { message: 'Resource not accessible by integration' })
        : undefined,
    );
    await expect(
      gh.writeSpecDoc({ repo, path: 'specs/16-foo/需求.md', content: 'x', message: 'm' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
