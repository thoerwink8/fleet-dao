import { describe, expect, it } from 'vitest';
import { mergeKey } from '../src/pulls.ts';
import { hasCloseKeywords } from '../src/text.ts';
import { json, repo, setup, sha } from './helpers.ts';

const A = sha('a');
const B = sha('b');

describe('开 PR', () => {
  it('用「干活的」机器人开；编号读返回体、不从链接里抠（B5）；正文按模板', async () => {
    const { gh, fake } = setup();
    fake.refs.set('task/12-otp', A);
    fake.before.push(async (req) => {
      if (req.method !== 'POST' || req.path !== '/repos/acme/widgets/pulls') return undefined;
      // 回执里的链接形状陌生：只要 number 在，结果照样对
      fake.before.pop();
      const res = await fake.fetch(`https://api.github.test${req.path}`, {
        method: 'POST',
        headers: req.headers,
        body: JSON.stringify(req.body),
      });
      const data = (await res.json()) as Record<string, unknown>;
      return json(201, { ...data, html_url: 'https://weird.example/whatever/not/a/pull' });
    });
    const res = await gh.openPr({
      repo,
      branch: 'task/12-otp',
      head: A,
      title: '登录页加验证码',
      body: {
        requirement: 12,
        subtask: 'A 登录表单',
        did: ['加了验证码输入框'],
        verified: ['pnpm check 全绿'],
        plan: 'P1「工作流」',
        specs: 'specs/12-otp/',
        changedFiles: ['packages/web/src/login.tsx', 'docs/design.md'],
      },
    });
    const pr = fake.pulls.get(res.number);
    expect(pr?.user.login).toBe('fleet-test-agent[bot]');
    expect(res).toMatchObject({ created: true, headMatches: true, author: 'fleet-test-agent[bot]' });
    // （上面的钩子转手又调了一次假服务，所以记录里有两条，都是「干活的」）
    expect(new Set(fake.calls('POST', /\/pulls$/).map((r) => r.as))).toEqual(new Set(['agent']));
    expect(fake.pulls.size).toBe(1);
    expect(pr?.body).toBe(
      '**做了什么**：\n- 加了验证码输入框\n**怎么验证的**：\n- pnpm check 全绿\n**还欠什么**：无\n**需求**：#12 · 子任务 A 登录表单\n**对应计划**：P1「工作流」\n**specs**：specs/12-otp/\n**文档**：design',
    );
    expect(pr?.base.ref).toBe('main');
  });

  it('B1：回执丢了，重试按分支找回那一张，不开第二张', async () => {
    const { gh, fake } = setup();
    fake.refs.set('task/1', A);
    let dropped = false;
    fake.dropAfter.push((req) => {
      if (req.method === 'POST' && req.path.endsWith('/pulls') && !dropped) {
        dropped = true;
        return true;
      }
      return false;
    });
    const input = { repo, branch: 'task/1', head: A, title: 't', body: 'b' };
    await expect(gh.openPr(input)).rejects.toMatchObject({ code: 'AMBIGUOUS_WRITE', maybeLanded: true });
    const again = await gh.openPr(input);
    expect(again.created).toBe(false);
    expect(fake.pulls.size).toBe(1);
    expect(fake.calls('POST', /\/pulls$/)).toHaveLength(1);
  });

  it('同一件事再调一次：账上有，直接用回执，不再发 POST', async () => {
    const { gh, fake } = setup();
    fake.refs.set('task/2', A);
    const input = { repo, branch: 'task/2', head: A, title: 't', body: 'b' };
    const first = await gh.openPr(input);
    const second = await gh.openPr(input);
    expect(second).toMatchObject({ number: first.number, created: false });
    expect(fake.calls('POST', /\/pulls$/)).toHaveLength(1);
  });

  it('分支上已经有一张目标不对的 PR：拒绝，不另开', async () => {
    const { gh, fake } = setup();
    fake.addPull({ head: { ref: 'task/3', sha: A }, base: { ref: 'develop' } });
    await expect(gh.openPr({ repo, branch: 'task/3', head: A, title: 't', body: 'b' })).rejects.toMatchObject(
      {
        code: 'PR_BASE_MISMATCH',
      },
    );
  });

  it('C13：标题正文里的关单词改成「关联」', async () => {
    const { gh, fake } = setup();
    fake.refs.set('task/4', A);
    const res = await gh.openPr({
      repo,
      branch: 'task/4',
      head: A,
      title: 'Fixes #3 登录',
      body: '做完了。Closes #12, resolves: acme/other#9',
    });
    const pr = fake.pulls.get(res.number);
    expect(pr?.title).toBe('关联 #3 登录');
    expect(pr?.body).toBe('做完了。关联 #12, 关联 acme/other#9');
  });

  it('B3：长正文走请求体；超过 65536 个字符发出前就拒，报实际字数', async () => {
    const { gh, fake } = setup();
    fake.refs.set('task/5', A);
    const big = '字'.repeat(60_000); // 约 180KB
    const ok = await gh.openPr({ repo, branch: 'task/5', head: A, title: 't', body: big });
    expect(fake.pulls.get(ok.number)?.body).toHaveLength(60_000);
    fake.refs.set('task/6', A);
    await expect(
      gh.openPr({ repo, branch: 'task/6', head: A, title: 't', body: '字'.repeat(70_000) }),
    ).rejects.toMatchObject({
      code: 'BODY_TOO_LONG',
      details: { length: 70_000 },
    });
  });

  it('A1：新开的 PR 回读作者不是「干活的」机器人，判失败', async () => {
    const { gh, fake } = setup();
    fake.refs.set('task/7', A);
    fake.authorOverride = fake.human;
    await expect(gh.openPr({ repo, branch: 'task/7', head: A, title: 't', body: 'b' })).rejects.toMatchObject(
      {
        code: 'AUTHOR_MISMATCH',
      },
    );
  });

  describe('inheritFrom：照抄需求 issue 的类别标签与里程碑', () => {
    it('issue 有「需求」与里程碑：开出的 PR 也照抄上；重试不重复加', async () => {
      const { gh, fake } = setup();
      const issue = fake.addIssue({ labels: ['需求', '别的标签'], milestone: { number: 7, title: 'P1' } });
      fake.refs.set('task/20-inherit', A);
      const input = {
        repo,
        branch: 'task/20-inherit',
        head: A,
        title: 'x',
        body: { did: ['x'], verified: ['x'], changedFiles: ['src/x.ts'] },
        inheritFrom: { issueNumber: issue.number },
      };
      const res = await gh.openPr(input);
      expect(res.inherited).toEqual({ labels: ['需求'], milestone: 'P1' });
      const pr = fake.pulls.get(res.number);
      expect(pr?.labels).toEqual(['需求']);
      expect(pr?.milestone).toEqual({ number: 7, title: 'P1' });

      // 重试（activity 重试会带同样的入参再调一次）：不重复加标签，milestone 也不会被覆盖
      const again = await gh.openPr(input);
      expect(again.inherited).toEqual({ labels: ['需求'], milestone: 'P1' });
      expect(fake.pulls.get(res.number)?.labels).toEqual(['需求']);
      expect(fake.calls('POST', /\/labels$/)).toHaveLength(1);
      expect(fake.calls('PATCH', new RegExp(`/issues/${res.number}$`))).toHaveLength(1);
    });

    it('issue 没有类别标签、没有里程碑：PR 也不挂，inherited 为空', async () => {
      const { gh, fake } = setup();
      const issue = fake.addIssue({});
      fake.refs.set('task/21-empty', A);
      const res = await gh.openPr({
        repo,
        branch: 'task/21-empty',
        head: A,
        title: 'x',
        body: { did: ['x'], verified: ['x'], changedFiles: ['src/x.ts'] },
        inheritFrom: { issueNumber: issue.number },
      });
      expect(res.inherited).toEqual({ labels: [], milestone: null });
      const pr = fake.pulls.get(res.number);
      expect(pr?.labels).toEqual([]);
      expect(pr?.milestone).toBeNull();
    });

    it('读 issue 403：明确报错，不当成「issue 没标签」', async () => {
      const { gh, fake } = setup();
      const issue = fake.addIssue({ labels: ['需求'] });
      fake.refs.set('task/22-forbidden', A);
      fake.before.push((req) =>
        req.path.endsWith(`/issues/${issue.number}`)
          ? json(403, { message: 'Resource not accessible by integration' })
          : undefined,
      );
      await expect(
        gh.openPr({
          repo,
          branch: 'task/22-forbidden',
          head: A,
          title: 'x',
          body: { did: ['x'], verified: ['x'], changedFiles: ['src/x.ts'] },
          inheritFrom: { issueNumber: issue.number },
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('不给 inheritFrom：不读 issue，结果里没有 inherited', async () => {
      const { gh, fake } = setup();
      fake.refs.set('task/23-no-inherit', A);
      const res = await gh.openPr({
        repo,
        branch: 'task/23-no-inherit',
        head: A,
        title: 'x',
        body: { did: ['x'], verified: ['x'], changedFiles: ['src/x.ts'] },
      });
      expect(res.inherited).toBeUndefined();
      expect(fake.calls('GET', /\/issues\//)).toHaveLength(0);
    });
  });
});

describe('等 CI', () => {
  const wait = (gh: ReturnType<typeof setup>['gh'], pr: number, head = A, extra = {}) =>
    gh.waitCi({ repo, prNumber: pr, head, ...extra });

  it('C9：一条检查都没有不算绿，等它出现、跑完才绿；必过检查从主线规则集读', async () => {
    const { gh, fake, sleeps } = setup();
    const pr = fake.addPull({ head: { ref: 'task/1', sha: A } });
    let polls = 0;
    fake.before.push((req) => {
      if (req.path.endsWith(`/commits/${A}/check-runs`) && ++polls === 3)
        fake.addCheck(A, 'check', 'success');
      return undefined;
    });
    const res = await wait(gh, pr.number);
    expect(res.state).toBe('green');
    expect(sleeps.filter((s) => s === 15_000)).toHaveLength(2);
    expect(fake.calls('GET', /\/rules\/branches\/main$/)).toHaveLength(1);
  });

  it('C9：同名检查取最新的一条（rerun、双触发）', async () => {
    const { gh, fake, clock } = setup();
    const pr = fake.addPull({ head: { ref: 'task/1', sha: A } });
    fake.addCheck(A, 'check', 'failure');
    clock.advance(1000);
    fake.addCheck(A, 'check', 'success');
    expect((await wait(gh, pr.number)).state).toBe('green');
  });

  it('C1：冲突的 PR 判「要同步主线」，不判 CI 缺失', async () => {
    const { gh, fake } = setup();
    const pr = fake.addPull({ head: { ref: 'task/1', sha: A }, mergeable: false, mergeable_state: 'dirty' });
    const res = await wait(gh, pr.number);
    expect(res).toMatchObject({ state: 'conflict' });
  });

  it('CI 根本没跑（没有检查也没有工作流）和「跑了没跑完」分开报', async () => {
    const missing = setup();
    const pr1 = missing.fake.addPull({ head: { ref: 'task/1', sha: A } });
    expect(await wait(missing.gh, pr1.number)).toMatchObject({ state: 'missing' });
    expect(missing.clock.now().getTime() - new Date('2026-09-25T12:00:00Z').getTime()).toBeLessThan(
      10 * 60_000,
    );

    const slow = setup();
    const pr2 = slow.fake.addPull({ head: { ref: 'task/2', sha: A } });
    slow.fake.addCheck(A, 'check', null);
    expect(await wait(slow.gh, pr2.number)).toMatchObject({ state: 'timeout', pending: ['check'] });

    // 检查还没建出来、但工作流在排队：不算「没跑」
    const queued = setup();
    const pr3 = queued.fake.addPull({ head: { ref: 'task/3', sha: A } });
    queued.fake.workflowRuns.set(A, 1);
    expect(await wait(queued.gh, pr3.number)).toMatchObject({ state: 'timeout', pending: ['check'] });
  });

  it('C8：PR 的头变了就不再等这个头', async () => {
    const { gh, fake } = setup();
    const pr = fake.addPull({ head: { ref: 'task/1', sha: B } });
    expect(await wait(gh, pr.number, A)).toMatchObject({ state: 'head_moved', actualHead: B });
  });

  it('C17：读到红隔一会儿在同一个头上再确认；期间有人重跑就接着等', async () => {
    const { gh, fake, clock } = setup();
    const pr = fake.addPull({ head: { ref: 'task/1', sha: A } });
    fake.addCheck(A, 'check', 'failure');
    let confirmed = 0;
    fake.before.push((req) => {
      if (req.path.endsWith(`/commits/${A}/check-runs`)) {
        confirmed += 1;
        if (confirmed === 2) {
          clock.advance(1000);
          fake.addCheck(A, 'check', 'success');
        }
      }
      return undefined;
    });
    expect((await wait(gh, pr.number)).state).toBe('green');
  });

  it('确认过还是红：报红，带失败的检查名和摘要', async () => {
    const { gh, fake } = setup();
    const pr = fake.addPull({ head: { ref: 'task/1', sha: A } });
    fake.addCheck(A, 'check', 'failure');
    const res = await wait(gh, pr.number);
    expect(res).toMatchObject({
      state: 'red',
      failedChecks: ['check'],
      digest: 'check：failure：2 个测试没过',
    });
  });

  it('C16：检查读不到算「没查成」，不当零条检查', async () => {
    const forbidden = setup();
    const pr = forbidden.fake.addPull({ head: { ref: 'task/1', sha: A } });
    forbidden.fake.before.push((req) =>
      req.path.includes('/check-runs')
        ? json(403, { message: 'Resource not accessible by integration' })
        : undefined,
    );
    expect(await wait(forbidden.gh, pr.number)).toMatchObject({ state: 'unknown' });

    const down = setup();
    const pr2 = down.fake.addPull({ head: { ref: 'task/1', sha: A } });
    down.fake.before.push((req) =>
      req.path.includes('/check-runs') ? json(503, { message: 'unavailable' }) : undefined,
    );
    expect(await wait(down.gh, pr2.number)).toMatchObject({ state: 'unknown' });
  });

  it('心跳带着计时：工人重启后接着算，不从头等', async () => {
    const { gh, fake, clock } = setup();
    const pr = fake.addPull({ head: { ref: 'task/1', sha: A } });
    const beats: unknown[] = [];
    const lastHeartbeat = { head: A, startedAt: clock.now().getTime() - 4.9 * 60_000, sawActivityAt: null };
    const res = await gh.waitCi(
      { repo, prNumber: pr.number, head: A },
      { heartbeat: (d) => beats.push(d), lastHeartbeat },
    );
    expect(res.state).toBe('missing');
    expect(beats.length).toBeLessThanOrEqual(2);
  });

  it('主线规则里没有必过检查：直说判不了，不当绿', async () => {
    const { gh, fake } = setup();
    fake.requiredChecks = [];
    const pr = fake.addPull({ head: { ref: 'task/1', sha: A } });
    await expect(wait(gh, pr.number)).rejects.toMatchObject({ code: 'NO_REQUIRED_CHECKS' });
  });
});

describe('合并', () => {
  function ready(
    fake: ReturnType<typeof setup>['fake'],
    init: Parameters<typeof fake.addPull>[0] = { head: { ref: 'task/1', sha: A } },
  ) {
    const pr = fake.addPull({ title: '登录页加验证码', ...init });
    fake.addCheck(init.head.sha, 'check', 'success');
    return pr;
  }

  it('用「引擎」squash 合：带头约束和显式的提交标题正文；合后回读合并人、删分支', async () => {
    const { gh, fake } = setup();
    const pr = ready(fake);
    const res = await gh.mergePr({ repo, prNumber: pr.number, expectedHead: A });
    expect(res).toMatchObject({
      merged: true,
      alreadyMerged: false,
      branchDeleted: true,
      mergedByEngine: true,
    });
    const put = fake.calls('PUT', /\/merge$/);
    expect(put.map((r) => r.as)).toEqual(['engine']);
    expect(put[0]?.body).toEqual({
      merge_method: 'squash',
      sha: A,
      commit_title: `登录页加验证码 (#${pr.number})`,
      commit_message: `由 fleet 引擎经合并队列 squash 合并（PR #${pr.number}）。`,
    });
    expect(fake.refs.has('task/1')).toBe(false);
    expect(fake.calls('DELETE', /\/git\/refs\/heads\/task\/1$/).map((r) => r.as)).toEqual(['engine']);
  });

  it('C21：合并记进幂等账（对账拿它核「是合并队列合的」）；合完回执丢了，重试补记、不再合', async () => {
    const first = setup();
    const pr = ready(first.fake);
    await first.gh.mergePr({ repo, prNumber: pr.number, expectedHead: A });
    const record = await first.ledger.idempotency.peek(mergeKey(repo, pr.number, A));
    expect(record?.result).toEqual({
      number: pr.number,
      head: A,
      mergeCommit: sha('c'),
      mergedBy: 'fleet-test-engine[bot]',
    });

    const lost = setup();
    const pr2 = ready(lost.fake);
    let dropped = false;
    lost.fake.dropAfter.push((req) => {
      if (req.method === 'PUT' && !dropped) {
        dropped = true;
        return true;
      }
      return false;
    });
    // PUT 断在回执上：客户端自己重试一次 PUT，GitHub 回「合不了」（已经合了），重读认下
    const res = await lost.gh.mergePr({ repo, prNumber: pr2.number, expectedHead: A });
    expect(res).toMatchObject({ merged: true });
    expect((await lost.ledger.idempotency.peek(mergeKey(repo, pr2.number, A)))?.completedAt).toBeTruthy();
  });

  it('C8：头不是审过的那个就不合（不发合并请求）', async () => {
    const { gh, fake } = setup();
    const pr = ready(fake, { head: { ref: 'task/1', sha: B } });
    expect(await gh.mergePr({ repo, prNumber: pr.number, expectedHead: A })).toMatchObject({
      merged: false,
      reason: 'head_moved',
    });
    expect(fake.calls('PUT', /\/merge$/)).toHaveLength(0);
  });

  it('落后主线不合：先同步、在新头上重测', async () => {
    const { gh, fake } = setup();
    const pr = ready(fake);
    fake.behindBy.set(A, 2);
    expect(await gh.mergePr({ repo, prNumber: pr.number, expectedHead: A })).toMatchObject({
      merged: false,
      reason: 'behind_main',
    });
  });

  it('合并前再确认一次 CI：红的、没跑完的、没出现的都不合', async () => {
    for (const conclusion of ['failure', null, 'none'] as const) {
      const { gh, fake } = setup();
      const pr = fake.addPull({ head: { ref: 'task/1', sha: A } });
      if (conclusion !== 'none') fake.addCheck(A, 'check', conclusion);
      const res = await gh.mergePr({ repo, prNumber: pr.number, expectedHead: A });
      expect(res).toMatchObject({ merged: false, reason: 'ci_not_green' });
    }
  });

  it('C10：mergeable 还没算出来就重读，算出来再合；一直算不出来就报可重试', async () => {
    const first = setup();
    const pr = ready(first.fake);
    pr.mergeable = null;
    pr.mergeable_state = 'unknown';
    const res = await first.gh.mergePr({ repo, prNumber: pr.number, expectedHead: A });
    expect(res.merged).toBe(true);

    const never = setup();
    const pr2 = ready(never.fake);
    pr2.mergeable = null;
    pr2.mergeable_state = 'computing';
    await expect(never.gh.mergePr({ repo, prNumber: pr2.number, expectedHead: A })).rejects.toMatchObject({
      code: 'MERGEABLE_UNKNOWN',
      retryable: true,
    });
  });

  it('C11：合并失败不看文案——只有重读到冲突才判冲突，其余可重试', async () => {
    const { gh, fake } = setup();
    const pr = ready(fake);
    fake.before.push((req) =>
      req.method === 'PUT'
        ? json(405, { message: 'Base branch was modified. Review and try the merge again.' })
        : undefined,
    );
    await expect(gh.mergePr({ repo, prNumber: pr.number, expectedHead: A })).rejects.toMatchObject({
      code: 'MERGE_NOT_ALLOWED',
      retryable: true,
    });

    const conflict = setup();
    const pr2 = ready(conflict.fake);
    conflict.fake.before.push((req) => {
      if (req.method !== 'PUT') return undefined;
      pr2.mergeable = false;
      pr2.mergeable_state = 'dirty';
      return json(405, { message: 'Pull Request is not mergeable' });
    });
    expect(await conflict.gh.mergePr({ repo, prNumber: pr2.number, expectedHead: A })).toMatchObject({
      merged: false,
      reason: 'conflict',
    });
  });

  it('合并时 409（头变了）：不合，交回重新排队', async () => {
    const { gh, fake } = setup();
    const pr = ready(fake);
    fake.before.push((req) => {
      if (req.method !== 'PUT') return undefined;
      pr.head.sha = B;
      return undefined;
    });
    expect(await gh.mergePr({ repo, prNumber: pr.number, expectedHead: A })).toMatchObject({
      merged: false,
      reason: 'head_moved',
    });
  });

  it('重试时发现已经合过（同一个头）：认下，不再合', async () => {
    const { gh, fake } = setup();
    const pr = ready(fake, {
      head: { ref: 'task/1', sha: A },
      state: 'closed',
      merged: true,
      merge_commit_sha: sha('c'),
      merged_by: fake.bots.engine,
    });
    expect(await gh.mergePr({ repo, prNumber: pr.number, expectedHead: A })).toMatchObject({
      merged: true,
      alreadyMerged: true,
    });
    expect(fake.calls('PUT', /\/merge$/)).toHaveLength(0);
  });

  it('C22：合并人不是「引擎」机器人要标出来', async () => {
    const { gh, fake } = setup();
    const pr = ready(fake, {
      head: { ref: 'task/1', sha: A },
      state: 'closed',
      merged: true,
      merge_commit_sha: sha('c'),
      merged_by: fake.bots.agent,
    });
    expect(await gh.mergePr({ repo, prNumber: pr.number, expectedHead: A })).toMatchObject({
      merged: true,
      mergedByEngine: false,
      mergedBy: 'fleet-test-agent[bot]',
    });
  });

  it('草稿先转正式再合', async () => {
    const { gh, fake } = setup();
    const pr = ready(fake, { head: { ref: 'task/1', sha: A }, draft: true });
    expect((await gh.mergePr({ repo, prNumber: pr.number, expectedHead: A })).merged).toBe(true);
    expect(fake.calls('POST', /^\/graphql$/).map((r) => r.as)).toEqual(['engine']);
  });

  it('C13：正文里的关单词合并前改掉', async () => {
    const { gh, fake } = setup();
    const pr = ready(fake, { head: { ref: 'task/1', sha: A }, body: 'Closes #5\n别的说明' });
    await gh.mergePr({ repo, prNumber: pr.number, expectedHead: A });
    expect(pr.body).toBe('关联 #5\n别的说明');
    const order = fake.requests
      .filter((r) => r.method === 'PATCH' || r.method === 'PUT')
      .map((r) => r.method);
    expect(order).toEqual(['PATCH', 'PUT']);
  });

  it('C13：squash 的提交正文一定非空（空串 GitHub 会换成默认正文，把分支提交里的 Fixes #N 带进主线）', async () => {
    for (const commitMessage of [undefined, '', '   ', 'Fixes #3，顺手修了登录']) {
      const { gh, fake } = setup();
      const pr = ready(fake);
      await gh.mergePr({ repo, prNumber: pr.number, expectedHead: A, commitMessage });
      const put = fake.calls('PUT', /\/merge$/);
      expect(put).toHaveLength(1);
      const sent = String((put[0]?.body as { commit_message?: unknown } | undefined)?.commit_message ?? '');
      expect(sent.trim(), String(commitMessage)).not.toBe('');
      expect(hasCloseKeywords(sent), sent).toBe(false);
    }
  });

  it('同一个仓的两张 PR 同时合：从核对主线到发合并请求按仓串行，不交错', async () => {
    const { gh, fake } = setup();
    const one = ready(fake, { head: { ref: 'task/1', sha: A } });
    const two = ready(fake, { head: { ref: 'task/2', sha: B } });
    await Promise.all([
      gh.mergePr({ repo, prNumber: one.number, expectedHead: A }),
      gh.mergePr({ repo, prNumber: two.number, expectedHead: B }),
    ]);
    const steps = fake.requests
      .filter((r) => r.path.includes('/compare/') || r.method === 'PUT')
      .map((r) => (r.method === 'PUT' ? 'merge' : 'compare'));
    expect(steps).toEqual(['compare', 'merge', 'compare', 'merge']);
  });

  it('分支上合并后又有了新提交：不删', async () => {
    const { gh, fake } = setup();
    const pr = ready(fake);
    fake.before.push((req) => {
      if (req.method === 'PUT') fake.refs.set('task/1', B);
      return undefined;
    });
    expect(await gh.mergePr({ repo, prNumber: pr.number, expectedHead: A })).toMatchObject({
      merged: true,
      branchDeleted: false,
    });
    expect(fake.refs.get('task/1')).toBe(B);
  });
});
