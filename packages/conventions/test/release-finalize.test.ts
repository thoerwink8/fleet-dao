// 发布收尾七步的编排（release-finalize.ts）：GitHub、飞书全换成内存里的假货，不打真 tag、不建真 Release、不推真飞书。
import { describe, expect, it } from 'vitest';
import type { GitHubRelease, MergedPull, MilestoneDetail } from '../src/github-api.ts';
import { feishuAttemptMark, feishuNotifiedMark } from '../src/publish-release-logic.ts';
import {
  type FinalizeGitHub,
  type FinalizeOptions,
  finalizeRelease,
  postFeishu,
  renderFinalizeReport,
} from '../src/release-finalize.ts';

const MERGE = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const MERGED_AT = '2026-10-05T02:00:00Z';
const SECTION = '### 新增\n\n- 发布 PR 合并之后自己收尾';
const CHANGELOG = `# Changelog\n\n## [Unreleased]\n\n还没有\n\n## [v3] - 2026-10-05\n\n${SECTION}\n`;

const ms = (number: number, title: string, closedAt: string | null = null): MilestoneDetail => ({
  number,
  title,
  state: closedAt === null ? 'open' : 'closed',
  description: '',
  closedAt,
});

/** 内存里的 GitHub：tag、Release、里程碑、文件都是可改的表；每次写都记进 calls；fail 里点名的方法抛错。 */
function fakeGitHub(
  init: {
    tags?: Record<string, string>;
    releases?: Record<string, GitHubRelease>;
    milestones?: MilestoneDetail[];
    pulls?: MergedPull[];
    files?: Record<string, string>;
    fail?: Partial<Record<keyof FinalizeGitHub, string>>;
    /** 建 Release 时 GitHub 实际存下的正文（模拟「建了但正文没存对」）。 */
    storeBody?: (body: string) => string;
  } = {},
) {
  const tags = { ...(init.tags ?? {}) };
  const releases = { ...(init.releases ?? {}) };
  let milestones = init.milestones ?? [
    ms(8, 'v1 Fusion 接活', '2026-10-01T14:58:46Z'),
    ms(10, 'v3 三段一条龙'),
  ];
  const files = init.files ?? { [`${MERGE}:CHANGELOG.md`]: CHANGELOG };
  const calls: string[] = [];
  let nextId = 100;
  const guard = (name: keyof FinalizeGitHub) => {
    const msg = init.fail?.[name];
    if (msg) throw new Error(msg);
  };
  const github: FinalizeGitHub = {
    async mergedPulls(head) {
      guard('mergedPulls');
      calls.push(`mergedPulls ${head}`);
      return init.pulls ?? [];
    },
    async milestones() {
      guard('milestones');
      return milestones;
    },
    async closeMilestone(n) {
      guard('closeMilestone');
      calls.push(`closeMilestone ${n}`);
      milestones = milestones.map((m) =>
        m.number === n ? { ...m, state: 'closed', closedAt: '2026-10-05T02:01:30Z' } : m,
      );
      const m = milestones.find((x) => x.number === n);
      if (!m) throw new Error(`没有里程碑 #${n}`);
      return m;
    },
    async tagCommit(tag) {
      guard('tagCommit');
      return tags[tag];
    },
    async createTag(tag, sha) {
      guard('createTag');
      calls.push(`createTag ${tag} ${sha.slice(0, 7)}`);
      tags[tag] = sha;
    },
    async release(tag) {
      guard('release');
      const r = releases[tag];
      return r ? { ...r } : undefined;
    },
    async createRelease(tag, _name, body) {
      guard('createRelease');
      calls.push(`createRelease ${tag}`);
      const r = { id: nextId++, tagName: tag, body: init.storeBody ? init.storeBody(body) : body };
      releases[tag] = r;
      return { ...r };
    },
    async updateReleaseBody(id, body) {
      guard('updateReleaseBody');
      calls.push(`updateReleaseBody ${id}`);
      const r = Object.values(releases).find((x) => x.id === id);
      if (!r) throw new Error(`没有 Release ${id}`);
      r.body = body;
      return { ...r };
    },
    async fileAt(path, ref) {
      guard('fileAt');
      return files[`${ref}:${path}`];
    },
  };
  return { github, calls, tags, releases, milestones: () => milestones };
}

function fakeFeishu(fail?: string) {
  const sent: string[] = [];
  return {
    sent,
    feishu: {
      async send(text: string) {
        if (fail) throw new Error(fail);
        sent.push(text);
      },
    },
  };
}

const PR = { kind: 'pull_request', mergeSha: MERGE, mergedAt: MERGED_AT } as const;
const URL_ = 'https://github.com/o/r/blob/v3/CHANGELOG.md';

function run(over: Partial<FinalizeOptions> & Pick<FinalizeOptions, 'github'>) {
  return finalizeRelease({ version: 'v3', trigger: PR, changelogUrl: URL_, ...over });
}

const statuses = (r: Awaited<ReturnType<typeof finalizeRelease>>) =>
  Object.fromEntries(r.steps.map((s) => [s.id, s.status]));

describe('正常一轮', () => {
  it('发布 PR 合并：核里程碑 → 打 tag（指着本次合并）→ 建 Release → 关里程碑 → 推飞书，顺序固定', async () => {
    const g = fakeGitHub();
    const f = fakeFeishu();
    const r = await run({ github: g.github, feishu: f.feishu });
    expect(r.ok).toBe(true);
    expect(statuses(r)).toEqual({
      merge: 'done',
      changelog: 'done',
      'milestone-check': 'done',
      tag: 'done',
      release: 'done',
      'milestone-close': 'done',
      feishu: 'done',
    });
    expect(g.calls).toEqual([
      'createTag v3 aaaaaaa',
      'createRelease v3',
      'closeMilestone 10',
      'updateReleaseBody 100',
      'updateReleaseBody 100',
    ]);
    expect(g.tags.v3).toBe(MERGE);
    expect(g.releases.v3?.body).toBe(`${SECTION}\n\n${feishuNotifiedMark('v3')}\n`);
    expect(f.sent).toEqual([`v3 上线了。\n\n${SECTION}\n\n— ${URL_}`]);
  });

  it('补跑一遍（都做过了）：tag、Release、里程碑、飞书全跳，什么都不写、飞书不重发', async () => {
    const g = fakeGitHub();
    const f = fakeFeishu();
    await run({ github: g.github, feishu: f.feishu });
    g.calls.length = 0;
    const again = await run({ github: g.github, feishu: f.feishu });
    expect(again.ok).toBe(true);
    expect(statuses(again)).toMatchObject({
      'milestone-check': 'skipped',
      tag: 'skipped',
      release: 'skipped',
      'milestone-close': 'skipped',
      feishu: 'skipped',
    });
    expect(g.calls).toEqual([]);
    expect(f.sent).toHaveLength(1);
  });

  it('手动补跑（workflow_dispatch）：按 head=release/v3 查已合并的 PR，拿它的合并提交和时间', async () => {
    const g = fakeGitHub({ pulls: [{ number: 731, mergedAt: MERGED_AT, mergeCommitSha: MERGE }] });
    const r = await run({ github: g.github, trigger: { kind: 'dispatch' } });
    expect(r.ok).toBe(true);
    expect(g.calls[0]).toBe('mergedPulls release/v3');
    expect(g.tags.v3).toBe(MERGE);
  });

  it('没配飞书 → 这一步记「跳过：没配」，整轮不算红', async () => {
    const g = fakeGitHub();
    const r = await run({ github: g.github });
    expect(r.ok).toBe(true);
    expect(r.steps.at(-1)).toMatchObject({
      id: 'feishu',
      status: 'skipped',
      note: expect.stringMatching(/没配飞书/),
    });
  });
});

describe('故意造出的失败：半截时后面的步骤一律不走', () => {
  it('打 tag 已存在（指着本次合并）→ 跳 tag、其余照走', async () => {
    const g = fakeGitHub({ tags: { v3: MERGE } });
    const f = fakeFeishu();
    const r = await run({ github: g.github, feishu: f.feishu });
    expect(r.ok).toBe(true);
    expect(statuses(r)).toMatchObject({
      tag: 'skipped',
      release: 'done',
      'milestone-close': 'done',
      feishu: 'done',
    });
    expect(g.calls).not.toContain('createTag v3 aaaaaaa');
    expect(f.sent).toHaveLength(1);
  });

  it('建 Release 失败 → 不关里程碑、不推飞书；报告写清停在哪', async () => {
    const g = fakeGitHub({ fail: { createRelease: '在建 v3 的 Release 时，GitHub 回了 502' } });
    const f = fakeFeishu();
    const r = await run({ github: g.github, feishu: f.feishu });
    expect(r.ok).toBe(false);
    expect(statuses(r)).toMatchObject({
      tag: 'done',
      release: 'failed',
      'milestone-close': 'not-run',
      feishu: 'not-run',
    });
    expect(g.calls).not.toContain('closeMilestone 10');
    expect(g.milestones().find((m) => m.number === 10)?.state).toBe('open');
    expect(f.sent).toEqual([]);
    const report = renderFinalizeReport('v3', r);
    expect(report).toMatch(/停在半截/);
    expect(report).toMatch(
      /\| 建 GitHub Release \| \*\*红了\*\* \| 在建 v3 的 Release 时，GitHub 回了 502 \|/,
    );
    expect(report).toMatch(/\| 关版本里程碑 \| 没走 \|/);
  });

  it('Release 建了但读回正文对不上 CHANGELOG.md → 红，不关里程碑、不推飞书', async () => {
    const g = fakeGitHub({ storeBody: () => '被截断的正文' });
    const f = fakeFeishu();
    const r = await run({ github: g.github, feishu: f.feishu });
    expect(statuses(r)).toMatchObject({ release: 'failed', 'milestone-close': 'not-run', feishu: 'not-run' });
    expect(r.steps.find((s) => s.id === 'release')?.note).toMatch(/读回对不上/);
    expect(f.sent).toEqual([]);
  });

  it('tag 已存在但指着别的提交 → 红，不建 Release、不关里程碑、不推飞书', async () => {
    const g = fakeGitHub({ tags: { v3: OTHER } });
    const f = fakeFeishu();
    const r = await run({ github: g.github, feishu: f.feishu });
    expect(statuses(r)).toMatchObject({
      tag: 'failed',
      release: 'not-run',
      'milestone-close': 'not-run',
      feishu: 'not-run',
    });
    expect(g.calls).toEqual([]);
    expect(g.tags.v3).toBe(OTHER);
  });

  it('打完 tag 读回指的不是本次合并 → 红，不建 Release', async () => {
    const g = fakeGitHub();
    g.github.createTag = async (tag) => {
      g.tags[tag] = OTHER;
    };
    const r = await run({ github: g.github });
    expect(statuses(r)).toMatchObject({ tag: 'failed', release: 'not-run' });
    expect(r.steps.find((s) => s.id === 'tag')?.note).toMatch(/读回指的是/);
  });

  it('版本号对不上版本里程碑（开着的是 v3、这次发成 v1）→ 打 tag 之前就红，tag、Release 一样都不动', async () => {
    const files = { [`${MERGE}:CHANGELOG.md`]: CHANGELOG.replace('## [v3]', '## [v1]') };
    const g = fakeGitHub({ files });
    const r = await run({ github: g.github, version: 'v1' });
    expect(statuses(r)).toMatchObject({ 'milestone-check': 'failed', tag: 'not-run', release: 'not-run' });
    expect(g.calls).toEqual([]);
  });

  it('更新日志里没有这一版的标题 → 红，什么都不写', async () => {
    const files = { [`${MERGE}:CHANGELOG.md`]: '# Changelog\n\n## [Unreleased]\n\n- 还在 Unreleased 里\n' };
    const g = fakeGitHub({ files });
    const r = await run({ github: g.github });
    expect(statuses(r)).toMatchObject({ changelog: 'failed', 'milestone-check': 'not-run', tag: 'not-run' });
    expect(g.calls).toEqual([]);
  });

  it('本次合并的提交上没有 CHANGELOG.md、或读文件 GitHub 报错 → 红，不当成空正文', async () => {
    const none = await run({ github: fakeGitHub({ files: {} }).github });
    expect(none.steps.find((s) => s.id === 'changelog')).toMatchObject({
      status: 'failed',
      note: expect.stringMatching(/没有 CHANGELOG.md/),
    });
    const broken = await run({
      github: fakeGitHub({ fail: { fileAt: '读 CHANGELOG.md，GitHub 回了 502' } }).github,
    });
    expect(broken.steps.find((s) => s.id === 'changelog')).toMatchObject({
      status: 'failed',
      note: expect.stringMatching(/502/),
    });
  });

  it('事件里的 merge_commit_sha 是空的、或合并时间认不出 → 第一步就红', async () => {
    const g = fakeGitHub();
    const noSha = await run({
      github: g.github,
      trigger: { kind: 'pull_request', mergeSha: '', mergedAt: MERGED_AT },
    });
    expect(statuses(noSha)).toMatchObject({ merge: 'failed', changelog: 'not-run' });
    const badTime = await run({
      github: g.github,
      trigger: { kind: 'pull_request', mergeSha: MERGE, mergedAt: '昨天' },
    });
    expect(badTime.steps[0]).toMatchObject({
      status: 'failed',
      note: expect.stringMatching(/merged_at 认不出/),
    });
    expect(g.calls).toEqual([]);
  });

  it('版本号不是 v<N> → 第一步就红', async () => {
    const r = await run({ github: fakeGitHub().github, version: 'vNext' });
    expect(r.steps[0]).toMatchObject({ status: 'failed', note: expect.stringMatching(/不是 v<N>/) });
  });

  it('手动补跑：没找到 head=release/vN 已合并的 PR、或查的时候 GitHub 报错 → 第一步就红', async () => {
    const none = await run({ github: fakeGitHub({ pulls: [] }).github, trigger: { kind: 'dispatch' } });
    expect(none.steps[0]).toMatchObject({
      status: 'failed',
      note: expect.stringMatching(/没找到 head=release\/v3/),
    });
    const broken = await run({
      github: fakeGitHub({ fail: { mergedPulls: '连不上 GitHub（fetch failed）' } }).github,
      trigger: { kind: 'dispatch' },
    });
    expect(broken.steps[0]).toMatchObject({ status: 'failed', note: expect.stringMatching(/fetch failed/) });
  });

  it('关里程碑 GitHub 报错 → 红，不推飞书（tag、Release 留着，补跑跳过它们）', async () => {
    const g = fakeGitHub({ fail: { closeMilestone: '在关里程碑 #10 时，GitHub 回了 403' } });
    const f = fakeFeishu();
    const r = await run({ github: g.github, feishu: f.feishu });
    expect(statuses(r)).toMatchObject({ release: 'done', 'milestone-close': 'failed', feishu: 'not-run' });
    expect(f.sent).toEqual([]);
  });

  it('飞书没发成 → 红，Release 正文留着「试过」标记、没有「已发」；修好再补跑会发一次、只发一次', async () => {
    const g = fakeGitHub();
    const broken = fakeFeishu('飞书回的业务码不是 0（code=19024，msg=Key Words Not Found）');
    const r = await run({ github: g.github, feishu: broken.feishu });
    expect(statuses(r)).toMatchObject({ 'milestone-close': 'done', feishu: 'failed' });
    expect(g.releases.v3?.body).toContain(feishuAttemptMark('v3'));
    expect(g.releases.v3?.body).not.toContain(feishuNotifiedMark('v3'));

    const fixed = fakeFeishu();
    const again = await run({ github: g.github, feishu: fixed.feishu });
    expect(again.ok).toBe(true);
    expect(statuses(again)).toMatchObject({
      release: 'skipped',
      'milestone-close': 'skipped',
      feishu: 'done',
    });
    expect(fixed.sent).toHaveLength(1);
    expect(g.releases.v3?.body).toBe(`${SECTION}\n\n${feishuNotifiedMark('v3')}\n`);
  });

  it('「试过」标记写不进 Release 正文 → 红，飞书不发（不变成没标就发）', async () => {
    const g = fakeGitHub();
    await run({ github: g.github });
    g.github.updateReleaseBody = async () => {
      throw new Error('在改 Release #100 的正文时，GitHub 回了 502');
    };
    const f = fakeFeishu();
    const r = await run({ github: g.github, feishu: f.feishu });
    expect(r.steps.at(-1)).toMatchObject({
      status: 'failed',
      note: expect.stringMatching(/「试过」标记写不进/),
    });
    expect(f.sent).toEqual([]);
  });

  it('Release 正文被人手改过（末尾有已发标记）→ 改回 CHANGELOG.md 那段、标记留着，飞书不重发', async () => {
    const g = fakeGitHub({
      tags: { v3: MERGE },
      releases: { v3: { id: 7, tagName: 'v3', body: `人手改的\n\n${feishuNotifiedMark('v3')}\n` } },
    });
    const f = fakeFeishu();
    const r = await run({ github: g.github, feishu: f.feishu });
    expect(r.ok).toBe(true);
    expect(statuses(r)).toMatchObject({ release: 'done', feishu: 'skipped' });
    expect(g.releases.v3?.body).toBe(`${SECTION}\n\n${feishuNotifiedMark('v3')}\n`);
    expect(f.sent).toEqual([]);
  });
});

describe('postFeishu：往飞书 webhook 发一条', () => {
  // 假地址（.invalid 不会解析）：长得像真飞书 webhook 的会被推前卫生检查当成密钥拦下。
  const HOOK = 'https://hook.invalid/bot/secret-token-xyz';
  const reply = (body: unknown, status = 200) =>
    (async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
      })) as unknown as typeof fetch;

  it('发 text 消息；回 { code: 0 } 算发成', async () => {
    let sent = '';
    const impl = (async (_url: string, init?: RequestInit) => {
      sent = String(init?.body);
      return new Response('{"code":0,"msg":"success","data":{}}');
    }) as unknown as typeof fetch;
    await postFeishu(HOOK, 'v3 上线了。', impl);
    expect(JSON.parse(sent)).toEqual({ msg_type: 'text', content: { text: 'v3 上线了。' } });
  });

  it.each([
    ['HTTP 500', reply({}, 500), /飞书回了 HTTP 500/],
    ['HTTP 200 但业务码不是 0', reply({ code: 19024, msg: 'Key Words Not Found' }), /code=19024/],
    ['回包不是 JSON', reply('<html>'), /不是 JSON/],
    [
      '连不上',
      (async () => {
        throw new Error('fetch failed');
      }) as unknown as typeof fetch,
      /连不上飞书（fetch failed）/,
    ],
  ])('故意造出的失败：%s → 抛，报错里不带 webhook 地址（它是密钥）', async (_name, impl, re) => {
    const err = await postFeishu(HOOK, 'x', impl).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(re);
    expect((err as Error).message).not.toContain('secret-token-xyz');
  });
});
