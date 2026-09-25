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

  it('409 / 422 不是 sha 过期（规则集拒写、路径不合法）：明确报 SPEC_DOC_REJECTED，不重读重写', async () => {
    for (const [status, message] of [
      [409, 'Repository rule violations found\n\nChanges must be made through a pull request.'],
      [422, 'path contains a malformed path component'],
    ] as const) {
      const { gh, fake } = setup();
      fake.before.push((req) =>
        req.method === 'PUT' && req.path.includes('/contents/') ? json(status, { message }) : undefined,
      );
      await expect(
        gh.writeSpecDoc({ repo, path: 'specs/20-foo/需求.md', content: 'x', message: 'm' }),
      ).rejects.toMatchObject({ code: 'SPEC_DOC_REJECTED', retryable: false, status });
      expect(fake.calls('PUT', /\/contents\//)).toHaveLength(1);
    }
  });
});

describe('写主线之前的卫生检查（直写不经 git 推送，推前扫描拦不到）', () => {
  it('正文里有名单上的值：不写（HYGIENE_BLOCKED，不可重试），一个请求都不发，报错只带位置不带值', async () => {
    const { gh, fake } = setup();
    const err = await gh
      .writeSpecDoc({
        repo,
        path: 'specs/17-foo/需求.md',
        content: '# 需求\n\n切到组织 fake-org-778899 再跑\n',
        message: '写需求文档',
      })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'HYGIENE_BLOCKED', retryable: false });
    expect((err as Error).message).toContain('specs/17-foo/需求.md:3');
    expect((err as Error).message).not.toContain('fake-org-778899');
    expect((err as { details: unknown }).details).toMatchObject({
      findings: [{ path: 'specs/17-foo/需求.md', line: 3, rule: 'known-value' }],
    });
    expect(fake.requests).toHaveLength(0);
  });

  it('路径里带名单上的值（正文干净）：拦（HYGIENE_NAME_BLOCKED：名字不是会话写的），一个请求都不发，报错里的路径打了码', async () => {
    const { gh, fake } = setup();
    const err = await gh
      .writeSpecDoc({
        repo,
        path: 'specs/22-fake-org-778899-迁移/需求.md',
        content: '# 需求\n\n干净的正文\n',
        message: '写需求文档',
      })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'HYGIENE_NAME_BLOCKED', retryable: false });
    expect((err as Error).message).toContain('specs/22-〔名单上的值〕-迁移/需求.md 名单里的敏感值');
    expect(`${(err as Error).message}${JSON.stringify((err as { details: unknown }).details)}`).not.toContain(
      '778899',
    );
    expect((err as { details: unknown }).details).toMatchObject({
      findings: [{ path: 'specs/22-〔名单上的值〕-迁移/需求.md', line: 0, rule: 'known-value' }],
    });
    expect(fake.requests).toHaveLength(0);
  });

  it('提交说明里有也拦', async () => {
    const { gh, fake } = setup();
    await expect(
      gh.writeSpecDoc({
        repo,
        path: 'specs/18-foo/需求.md',
        content: '# 需求\n',
        message: 'docs: 组织 fake-org-778899 的需求',
      }),
    ).rejects.toMatchObject({ code: 'HYGIENE_BLOCKED' });
    expect(fake.requests).toHaveLength(0);
  });

  it('名单没读到：不写（HYGIENE_LIST_MISSING），不当成查过没事', async () => {
    const { gh, fake } = setup({
      sensitiveValues: () => ({ ok: false, reason: '已知敏感值名单没读到', tried: ['/nonexistent'] }),
    });
    await expect(
      gh.writeSpecDoc({ repo, path: 'specs/19-foo/需求.md', content: '# 需求\n', message: 'm' }),
    ).rejects.toMatchObject({ code: 'HYGIENE_LIST_MISSING', retryable: false });
    expect(fake.requests).toHaveLength(0);
  });

  it('正文里带 NUL（扫不成内容，只能按二进制算）：不写（HYGIENE_UNSCANNED），一个请求都不发，不当成扫过没事', async () => {
    const { gh, fake } = setup();
    const err = await gh
      .writeSpecDoc({
        repo,
        path: 'specs/21-foo/需求.md',
        content: '# 需求\n\u0000\n',
        message: '写需求文档',
      })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'HYGIENE_UNSCANNED' });
    expect((err as Error).message).toContain('specs/21-foo/需求.md');
    expect(fake.requests).toHaveLength(0);
  });
});

describe('readSpecDoc', () => {
  it('读默认分支上的需求文档：以「引擎」身份读，拿回正文', async () => {
    const { gh, fake } = setup();
    const path = 'specs/12-登录验证码/需求.md';
    fake.specs.set(path, { sha: 'a'.repeat(40), content: '对应计划：plan.md P1「工作流」\n' });
    const res = await gh.readSpecDoc({ repo, path });
    expect(res?.content).toBe('对应计划：plan.md P1「工作流」\n');
    expect(res?.url).toContain('/blob/main/');
    const gets = fake.calls('GET', /\/contents\//);
    expect(gets).toHaveLength(1);
    expect(gets[0]?.as).toBe('engine');
  });

  it('文件不在：回 null（不当成空文档）', async () => {
    const { gh } = setup();
    await expect(gh.readSpecDoc({ repo, path: 'specs/13-没有的/需求.md' })).resolves.toBeNull();
  });

  it('路径出了 specs/：拒收，一个请求都不发', async () => {
    const { gh, fake } = setup();
    await expect(gh.readSpecDoc({ repo, path: 'docs/x.md' })).rejects.toMatchObject({
      code: 'BAD_INPUT',
    });
    expect(fake.requests).toHaveLength(0);
  });

  it('拿回来的不是文件（目录、子模块）：报「回的东西不对」，不当成空文档', async () => {
    const { gh, fake } = setup();
    fake.before.push((req) =>
      req.method === 'GET' && req.path.includes('/contents/')
        ? json(200, [{ type: 'file', path: 'specs/14-foo/需求.md' }])
        : undefined,
    );
    await expect(gh.readSpecDoc({ repo, path: 'specs/14-foo/需求.md' })).rejects.toMatchObject({
      code: 'UNEXPECTED_RESPONSE',
    });
  });

  it('读不了（403）：明确报错，不当成「文件不在」', async () => {
    const { gh, fake } = setup();
    fake.before.push((req) =>
      req.method === 'GET' && req.path.includes('/contents/')
        ? json(403, { message: 'Resource not accessible by integration' })
        : undefined,
    );
    await expect(gh.readSpecDoc({ repo, path: 'specs/15-foo/需求.md' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
