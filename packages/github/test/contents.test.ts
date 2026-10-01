// 需求文档写进主线：Contents API，全走假服务（不出网、不碰真 git）。
import { describe, expect, it } from 'vitest';
import { validRepoFilePath, validSpecPath } from '../src/contents.ts';
import { json, repo, setup, sha } from './helpers.ts';

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
  it('正文里有真密钥：不写（HYGIENE_BLOCKED，不可重试），一个请求都不发，报错只带位置不带值', async () => {
    const { gh, fake } = setup();
    const token = ['ghp', 'q7Rz2LmX9vKp4TnB8wYc1HdF6jGs3NaEw5Yu'].join('_');
    const err = await gh
      .writeSpecDoc({
        repo,
        path: 'specs/17-foo/需求.md',
        content: `# 需求\n\n令牌 ${token}\n`,
        message: '写需求文档',
      })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'HYGIENE_BLOCKED', retryable: false });
    expect((err as Error).message).toContain('specs/17-foo/需求.md:3');
    expect((err as Error).message).not.toContain(token);
    expect((err as { details: unknown }).details).toMatchObject({
      findings: [{ path: 'specs/17-foo/需求.md', line: 3, rule: 'token' }],
    });
    expect(fake.requests).toHaveLength(0);
  });

  it('提交说明里有也拦', async () => {
    const { gh, fake } = setup();
    const token = ['ghp', 'Zt4wQ9mB2xKc7RvN1pLs8HdJ3fGy6TaEu5Vo'].join('_');
    await expect(
      gh.writeSpecDoc({
        repo,
        path: 'specs/18-foo/需求.md',
        content: '# 需求\n',
        message: `docs: 令牌 ${token} 的需求`,
      }),
    ).rejects.toMatchObject({ code: 'HYGIENE_BLOCKED' });
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

describe('readRepoFile（仓的流程配置 .fleet/flow.json 这样读）', () => {
  const HEAD = sha('d');
  const PATH = '.fleet/flow.json';

  it('先读默认分支头、再按这个提交读文件（两样对得上），以「引擎」身份', async () => {
    const { gh, fake } = setup();
    fake.refs.set('main', HEAD);
    fake.specs.set(PATH, { sha: sha('a'), content: '{"formatVersion":1}\n' });
    await expect(gh.readRepoFile({ repo, path: PATH })).resolves.toEqual({
      defaultBranch: 'main',
      commit: HEAD,
      file: { kind: 'text', text: '{"formatVersion":1}\n' },
    });
    const [read] = fake.calls('GET', /\/contents\//);
    expect(read?.as).toBe('engine');
    expect(read?.query.get('ref')).toBe(HEAD);
    expect(fake.calls('GET', /\/git\/ref\/heads\/main$/)).toHaveLength(1);
  });

  it('文件不在：missing，照样带上读的是哪个提交', async () => {
    const { gh, fake } = setup();
    fake.refs.set('main', HEAD);
    await expect(gh.readRepoFile({ repo, path: PATH })).resolves.toEqual({
      defaultBranch: 'main',
      commit: HEAD,
      file: { kind: 'missing' },
    });
  });

  it.each<[string, unknown, RegExp]>([
    ['是个目录', [{ type: 'file', path: '.fleet/flow.json/x' }], /是个目录/],
    ['是子模块', { type: 'submodule', path: '.fleet/flow.json' }, /不是普通文件（是 submodule）/],
    [
      '太大拿不回内容',
      { type: 'file', encoding: 'none', content: '', path: '.fleet/flow.json' },
      /拿不回内容（encoding none/,
    ],
  ])('那个路径%s：not_file（仓里的东西不对，由调用方判认不出），不是没查成', async (_name, body, why) => {
    const { gh, fake } = setup();
    fake.refs.set('main', HEAD);
    fake.before.push((req) =>
      req.method === 'GET' && req.path.includes('/contents/') ? json(200, body) : undefined,
    );
    const got = await gh.readRepoFile({ repo, path: PATH });
    expect(got.file).toMatchObject({ kind: 'not_file', why: expect.stringMatching(why) });
  });

  it('【失败】默认分支头读不到（404）：抛错，不当成文件不在', async () => {
    const { gh } = setup();
    await expect(gh.readRepoFile({ repo, path: PATH })).rejects.toMatchObject({ name: 'GitHubError' });
  });

  it('【失败】分支头的形状认不出：抛 UNEXPECTED_RESPONSE（没查成）', async () => {
    const { gh, fake } = setup();
    fake.before.push((req) =>
      req.method === 'GET' && /\/git\/ref\/heads\//.test(req.path)
        ? json(200, { object: { sha: 'not-a-sha', type: 'commit' } })
        : undefined,
    );
    await expect(gh.readRepoFile({ repo, path: PATH })).rejects.toMatchObject({
      code: 'UNEXPECTED_RESPONSE',
    });
  });

  it('【失败】读文件时 GitHub 出错（403）：抛错，不当成文件不在', async () => {
    const { gh, fake } = setup();
    fake.refs.set('main', HEAD);
    fake.before.push((req) =>
      req.method === 'GET' && req.path.includes('/contents/')
        ? json(403, { message: 'Resource not accessible by integration' })
        : undefined,
    );
    await expect(gh.readRepoFile({ repo, path: PATH })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('【失败】路径不合规：拒收，一个请求都不发', async () => {
    const { gh, fake } = setup();
    for (const bad of ['', '/etc/passwd', '../x.json', '.fleet/../x', '.fleet\\flow.json', '.fleet/']) {
      await expect(gh.readRepoFile({ repo, path: bad })).rejects.toMatchObject({ code: 'BAD_INPUT' });
    }
    expect(fake.requests).toHaveLength(0);
    expect(validRepoFilePath(PATH)).toBe(true);
  });
});
