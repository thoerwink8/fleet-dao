// 每道题的判分函数：拿造好的「对的产出」和「错的产出」各判一遍，前者过、后者不过。要改代码的题真在临时目录里跑测试。
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ARCHITECT_CASES, judgePrompt, parseJudgeAnswer } from '../src/cases/architect.ts';
import { PROMPT_LOG_EDITS } from '../src/cases/code-tasks.ts';
import { ALL_CASES } from '../src/cases/index.ts';
import { GRADING_ISSUES, type RealIssue, TWO_FAMILY_ISSUES } from '../src/cases/review.ts';
import { baseFiles, writeBase } from '../src/grade-util.ts';
import { REPO_ROOT, SKIPPED_SCENARIOS, UngradableError, type Verdict } from '../src/types.ts';
import { caseDirOf, prepareFixture } from '../src/workspace.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function find(id: string) {
  const c = ALL_CASES.find((x) => x.id === id);
  if (!c) throw new Error(`没有这道题：${id}`);
  return c;
}

/** 在临时目录里（夹具拷贝）判一次。 */
async function judge(
  id: string,
  answer: string,
  setup: (dir: string, caseDir: string) => void = () => {},
  askJudge: (p: string) => Promise<string> = async () => {
    throw new Error('这道题不该调裁判');
  },
): Promise<Verdict> {
  const c = find(id);
  let dir: string;
  if (c.source.kind === 'fixture') {
    const ws = prepareFixture(c);
    cleanups.push(ws.cleanup);
    dir = ws.dir;
  } else {
    dir = mkdtempSync(join(tmpdir(), 'agent-eval-test-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  }
  setup(dir, caseDirOf(c));
  return c.grade({ answer, workDir: dir, caseDir: caseDirOf(c), judge: askJudge });
}

const copyHiddenDir = (sub: string) => (dir: string, caseDir: string) =>
  cpSync(join(caseDir, 'hidden', sub), dir, { recursive: true });
const edit = (dir: string, rel: string, f: (s: string) => string) =>
  writeFileSync(join(dir, rel), f(readFileSync(join(dir, rel), 'utf8')));

describe('登记表', () => {
  it('每种场景至少 1 道，id 不重、目录在包里', () => {
    const scenarios = [
      'scout',
      'log-digest',
      'triage',
      'review-screen',
      'fixer',
      'brief-drafter',
      'builder',
      'ci-triager',
      'groomer',
      'researcher',
      'standard-editor',
      'architect',
      'debugger',
      'reviewer',
    ];
    for (const s of scenarios)
      expect(
        ALL_CASES.some((c) => c.scenario === s),
        s,
      ).toBe(true);
    expect(new Set(ALL_CASES.map((c) => c.id)).size).toBe(ALL_CASES.length);
    for (const c of ALL_CASES) {
      expect(c.id).toBe(`${c.scenario}/${c.name}`);
      expect(c.planted.length, `${c.id} 要写种了什么`).toBeGreaterThan(10);
      expect(c.why.length, `${c.id} 要写为什么能区分强弱`).toBeGreaterThan(10);
      if (c.source.kind === 'fixture') expect(existsSync(join(caseDirOf(c), 'workspace')), c.id).toBe(true);
    }
    expect(SKIPPED_SCENARIOS.map((s) => s.scenario)).toEqual(['ui-builder', 'ui-verifier']);
  });

  it('Opus 档 4 种场景各有 2 道以上真题：固定提交的仓快照，why 写明当时谁栽在哪（#1714）', () => {
    for (const s of ['standard-editor', 'architect', 'debugger', 'reviewer']) {
      const real = ALL_CASES.filter((c) => c.scenario === s && c.source.kind === 'repo');
      expect(real.length, s).toBeGreaterThanOrEqual(2);
      for (const c of real) {
        expect(
          c.source.kind === 'repo' && /^[0-9a-f]{40}$/.test(c.source.commit),
          `${c.id} 要写完整提交号`,
        ).toBe(true);
        expect(c.why, c.id).toMatch(/真事|当时/);
      }
    }
  });

  it('标准答案（hidden/）只在包里，题面和夹具目录里没有', () => {
    for (const c of ALL_CASES) {
      expect(existsSync(join(caseDirOf(c), 'workspace', 'hidden')), c.id).toBe(false);
      if (c.source.kind === 'fixture') {
        for (const f of ['accept.test.ts', 'extra.test.ts'])
          expect(existsSync(join(caseDirOf(c), 'workspace', f))).toBe(false);
      }
    }
  });
});

describe('scout', () => {
  const right = 'runRouteProbeJob — packages/engine/src/jobs/route-probe.ts:717';
  it('对的：文件对、行号差 3 以内', async () => {
    expect((await judge('scout/route-probe-entry', right)).pass).toBe(true);
    expect(
      (await judge('scout/route-probe-entry', 'x — packages/engine/src/jobs/route-probe.ts:720')).pass,
    ).toBe(true);
  });
  it('错的：干扰函数的行、别的文件、没引用', async () => {
    expect(
      (
        await judge(
          'scout/route-probe-entry',
          'planScheduledProbe — packages/engine/src/jobs/route-probe.ts:297',
        )
      ).pass,
    ).toBe(false);
    expect(
      (await judge('scout/route-probe-entry', 'x — packages/engine/src/jobs/route-probe.ts:721')).pass,
    ).toBe(false);
    expect((await judge('scout/route-probe-entry', 'x — packages/engine/src/jobs/canary.ts:717')).pass).toBe(
      false,
    );
    expect((await judge('scout/route-probe-entry', '找不到')).pass).toBe(false);
  });
  it('每小时对账那道', async () => {
    expect(
      (
        await judge(
          'scout/hourly-reconcile-entry',
          'runHourlyReconcileJob — packages/engine/src/jobs/hourly-reconcile.ts:184',
        )
      ).pass,
    ).toBe(true);
    expect(
      (
        await judge(
          'scout/hourly-reconcile-entry',
          'combineParts — packages/engine/src/jobs/hourly-reconcile.ts:84',
        )
      ).pass,
    ).toBe(false);
  });
});

describe('log-digest', () => {
  const three = [
    "- skips orgs on cooldown — AssertionError: expected [ 'org-b' ] to deeply equal []",
    '- clamps negative remaining to zero — AssertionError: expected -3 to be +0 // Object.is equality',
    "- rejects reversed range — AssertionError: expected function to throw an error, but it didn't",
  ];
  it('对的：三条失败的名字和断言行都在', async () => {
    expect((await judge('log-digest/three-failures', three.join('\n'))).pass).toBe(true);
  });
  it('错的：漏一条；断言行是编的', async () => {
    const miss = await judge('log-digest/three-failures', three.slice(0, 2).join('\n'));
    expect(miss.pass).toBe(false);
    expect(miss.reason).toContain('rejects reversed range');
    const fake = three.map((l) => l.replace('expected -3 to be +0', 'expected -3 to be 0'));
    expect((await judge('log-digest/three-failures', fake.join('\n'))).pass).toBe(false);
    const invented = [...three, 'AssertionError: expected 5 to be 6'];
    expect((await judge('log-digest/three-failures', invented.join('\n'))).reason).toContain('不在原文里');
  });
  it('证据行用反引号括起来、后面带出处（Haiku 2026-10-10 实答写法）：过；括起来的是编的照样不过', async () => {
    const cited = [
      "- schedule > skips orgs on cooldown：`AssertionError: expected [ 'org-b' ] to deeply equal []`（ci-output.txt:29）",
      '- quota > clamps negative remaining to zero：`AssertionError: expected -3 to be +0 // Object.is equality`（ci-output.txt:47）',
      "- parseWindow > rejects reversed range：`AssertionError: expected function to throw an error, but it didn't`（:56）",
    ];
    expect(await judge('log-digest/three-failures', cited.join('\n'))).toMatchObject({ pass: true });
    const fake = cited.map((l) => l.replace('expected -3 to be +0', 'expected -3 to be 0'));
    const v = await judge('log-digest/three-failures', fake.join('\n'));
    expect(v.pass).toBe(false);
  });
  const two = [
    "- evicts the least recently used entry — AssertionError: expected 'b' to be 'a' // Object.is equality",
    "- writes the header row first — AssertionError: expected 'id,name\\r\\n1,x' to be 'id,name\\n1,x' // Object.is equality",
  ];
  it('重试后通过的不算失败', async () => {
    expect((await judge('log-digest/retry-noise', two.join('\n'))).pass).toBe(true);
    expect(
      (
        await judge(
          'log-digest/retry-noise',
          [...two, '（answers within 50ms 重试后通过了，不算）'].join('\n'),
        )
      ).pass,
    ).toBe(true);
    const bad = await judge('log-digest/retry-noise', [...two, '- answers within 50ms 失败'].join('\n'));
    expect(bad.pass).toBe(false);
    expect(bad.reason).toContain('重试后通过');
  });
});

describe('triage（标准答案由 check-brief.mjs 现算）', () => {
  const lines = (v: string[]) => v.map((x, i) => `brief-${i + 1}.md: ${x}`).join('\n');
  it('a：过 FAIL 过 FAIL 过', async () => {
    expect(
      (await judge('triage/briefs-a', lines(['PASS', 'FAIL — 缺原话', 'PASS', 'FAIL — CI 绿', 'PASS']))).pass,
    ).toBe(true);
    const wrong = await judge('triage/briefs-a', lines(['PASS', 'FAIL', 'FAIL', 'FAIL', 'PASS']));
    expect(wrong.pass).toBe(false);
    expect(wrong.reason).toContain('brief-3');
  });
  it('b：FAIL FAIL 过 FAIL FAIL；没回的算错', async () => {
    expect((await judge('triage/briefs-b', lines(['FAIL', 'FAIL', 'PASS', 'FAIL', 'FAIL']))).pass).toBe(true);
    const missing = await judge('triage/briefs-b', lines(['FAIL', 'FAIL', 'PASS', 'FAIL']));
    expect(missing.pass).toBe(false);
    expect(missing.reason).toContain('没回');
  });
});

describe('review-screen（行号窗口从 diff 里现找）', () => {
  it('queue-change：4 个都报出过；漏一个不过；误报超过 1 个不过', async () => {
    const all =
      'change.diff:32 — 疑似令牌\nchange.diff:50 — 删了断言\nchange.diff:53 — skip\nchange.diff:64 — 碰 agents/';
    expect((await judge('review-screen/queue-change', all)).pass).toBe(true);
    expect((await judge('review-screen/queue-change', `${all}\nchange.diff:5 — 多报一个`)).pass).toBe(true);
    const fp = await judge('review-screen/queue-change', `${all}\nchange.diff:5 — a\nchange.diff:12 — b`);
    expect(fp.pass).toBe(false);
    expect(fp.reason).toContain('误报 2');
    const miss = await judge(
      'review-screen/queue-change',
      'change.diff:32 — 疑似令牌\nchange.diff:50 — 删了断言\nchange.diff:53 — skip',
    );
    expect(miss.pass).toBe(false);
    expect(miss.reason).toContain('碰标准路径');
  });
  it('scope-creep', async () => {
    const all =
      'change.diff:21 — 越范围\nchange.diff:34 — 标准路径\nchange.diff:53 — 调大超时\nchange.diff:58 — only';
    expect((await judge('review-screen/scope-creep', all)).pass).toBe(true);
    expect((await judge('review-screen/scope-creep', all.replace('change.diff:58 — only', ''))).pass).toBe(
      false,
    );
  });
});

describe('reviewer', () => {
  it('pagination：找到 2 个以上、不碰干扰项才过', async () => {
    expect(
      (
        await judge(
          'reviewer/pagination',
          'change.diff:17 — 页码\nchange.diff:23 — 排序反\nchange.diff:28 — 漏 await',
        )
      ).pass,
    ).toBe(true);
    expect(
      (await judge('reviewer/pagination', 'change.diff:17 — 页码\nchange.diff:28 — 漏 await')).pass,
    ).toBe(true);
    const decoy = await judge(
      'reviewer/pagination',
      'change.diff:17 — a\nchange.diff:23 — b\nchange.diff:28 — c\nchange.diff:34 — 干扰项',
    );
    expect(decoy.pass).toBe(false);
    expect(decoy.reason).toContain('干扰');
    expect((await judge('reviewer/pagination', 'change.diff:17 — 只找到一个')).pass).toBe(false);
  });
  it('rate-limit', async () => {
    expect(
      (
        await judge(
          'reviewer/rate-limit',
          'change.diff:24 — max\nchange.diff:34 — 竞态\nchange.diff:42 — 单位',
        )
      ).pass,
    ).toBe(true);
    expect(
      (
        await judge(
          'reviewer/rate-limit',
          'change.diff:24 — max\nchange.diff:42 — 单位\nchange.diff:54 — 吞错误',
        )
      ).pass,
    ).toBe(false);
  });
});

describe('ci-triager', () => {
  it('renamed-method', async () => {
    expect(
      (
        await judge(
          'ci-triager/renamed-method',
          '罪魁: e4f5a6b\n根因: pool.acquire 被改名 lease，runner 还在调 acquire',
        )
      ).pass,
    ).toBe(true);
    const wrong = await judge('ci-triager/renamed-method', '罪魁: 9c8d7e6\n根因: runner.ts 改坏了');
    expect(wrong.pass).toBe(false);
    expect(wrong.reason).toContain('指错');
    expect((await judge('ci-triager/renamed-method', '罪魁: e4f5a6b\n根因: 不知道')).pass).toBe(false);
    expect((await judge('ci-triager/renamed-method', '我觉得是 e4f5a6b')).pass).toBe(false);
  });
  it('retries-default', async () => {
    expect(
      (await judge('ci-triager/retries-default', '罪魁: 8e9f0a1\n根因: 默认 retries 从 3 改成了 2')).pass,
    ).toBe(true);
    expect((await judge('ci-triager/retries-default', '罪魁: 3b4c5d6\n根因: 改了测试的 retries')).pass).toBe(
      false,
    );
  });
});

describe('groomer', () => {
  it('a', async () => {
    const right = '#101: 做完 — x\n#102: 没做完 — 地址栏没做\n#103: 过期 — 已删\n#104: 没做完 — 没 PR';
    expect((await judge('groomer/four-issues-a', right)).pass).toBe(true);
    const wrong = await judge('groomer/four-issues-a', right.replace('#102: 没做完', '#102: 做完'));
    expect(wrong.pass).toBe(false);
    expect(wrong.reason).toContain('#102');
  });
  it('b', async () => {
    const right = '#201: 过期\n#202: 做完\n#203: 没做完（草稿 PR）\n#204: 做完';
    expect((await judge('groomer/four-issues-b', right)).pass).toBe(true);
    expect((await judge('groomer/four-issues-b', right.replace('#203: 没做完', '#203: 做完'))).pass).toBe(
      false,
    );
  });
});

describe('researcher', () => {
  const right =
    '`--agents` 在同名定义优先级里排第 2（托管设置第 1），高于项目 `.claude/agents/`。\n来源：https://code.claude.com/docs/en/sub-agents，2026-10-09 查，原文：「…」';
  it('对的：排第 2、高于项目级、官方链接、日期', async () => {
    expect((await judge('researcher/agents-priority', right)).pass).toBe(true);
  });
  it('错的：没链接；说项目级赢', async () => {
    const noLink = await judge('researcher/agents-priority', right.replace(/https\S+/, '某文档'));
    expect(noLink.pass).toBe(false);
    expect(noLink.reason).toContain('链接');
    expect(
      (
        await judge(
          'researcher/agents-priority',
          '项目 `.claude/agents/` 优先，排第 1。https://code.claude.com/x 2026-10-09',
        )
      ).pass,
    ).toBe(false);
  });
  const tail = '\n来源：https://code.claude.com/docs/en/sub-agents，查文档日期：2026-10-09';
  it('对的说法不止「高于」：赢过、> 排序、编号 2 对 3 都认（前两条是 Haiku、Opus 2026-10-10 的实答）', async () => {
    for (const a of [
      '托管设置(1) > `--agents` 命令行参数(2) > 项目 `.claude/agents/`(3) > 用户 `~/.claude/agents/`(4) > 插件 `agents/` 目录(5)。`--agents` 排第 2，所以同名时它赢过项目里的 `.claude/agents/` 定义，只输给托管设置。',
      '从高到低：①托管设置（组织级）> ②命令行 `--agents` > ③项目 `.claude/agents/` > ④用户 `~/.claude/agents/`。\n2. `--agents` 排第 2，只比托管设置低。\n3. 和项目 `.claude/agents/` 里的同名定义比，`--agents` 赢，因为它是 2、项目是 3。',
      '`--agents` 排第 2。\n托管设置 > `--agents` > 项目 `.claude/agents/`',
      '`--agents` 排第 2，只比托管设置低。\n编号：`--agents` 是 2、项目是 3。',
    ]) {
      expect((await judge('researcher/agents-priority', a + tail)).pass, a).toBe(true);
    }
  });
  it('错的：排第 2 但说输给项目、被项目覆盖、排序里项目在前，都不算「高于」', async () => {
    for (const a of [
      '`--agents` 排第 2，同名时输给项目 `.claude/agents/`。',
      '`--agents` 排第 2，同名时会被项目 `.claude/agents/` 覆盖。',
      '`--agents` 排第 2：托管设置 > 项目 `.claude/agents/` > `--agents` > 用户 `~/.claude/agents/`。',
    ]) {
      const v = await judge('researcher/agents-priority', a + tail);
      expect(v.pass, a).toBe(false);
      expect(v.reason).toContain('没说 --agents 高于项目');
    }
  });
});

describe('brief-drafter（调 check-brief.mjs）', () => {
  const draft = (quote: string, modules: string[], done: string[]) =>
    `## 场景\n某场景\n\n## 原话\n${quote}\n\n## 已知的模块\n${modules.map((m) => `- \`${m}\``).join('\n')}\n\n## 怎么算做完\n${done.join('\n')}\n`;
  const write = (content: string) => (dir: string) => {
    mkdirSync(join(dir, '_tmp', 'briefs'), { recursive: true });
    writeFileSync(join(dir, '_tmp', 'briefs', 'draft.md'), content);
  };
  const badgeQuote =
    '驾驶舱项目页上，没连上的项目现在是一片空白，我看不出是没连上还是没数据。没连上的显示一个灰色的「未连接」徽章。';
  const splitQuote = '任务列表接口要能按状态筛选，筛完要有截图给我看。';
  const web = ['packages/web/src/pages/projects.tsx', 'packages/web/src/components/status-badge.tsx'];

  it('project-badge：对的 PASS；原话改了字、跨模块、没写文件都不过', async () => {
    const done = ['1. 没连上的项目行渲染灰色「未连接」徽章。', '2. 新增测试覆盖这一行。'];
    expect((await judge('brief-drafter/project-badge', 'ok', write(draft(badgeQuote, web, done)))).pass).toBe(
      true,
    );
    expect(
      (
        await judge(
          'brief-drafter/project-badge',
          'ok',
          write(draft(badgeQuote.replace('灰色', '浅灰'), web, done)),
        )
      ).pass,
    ).toBe(false);
    expect(
      (
        await judge(
          'brief-drafter/project-badge',
          'ok',
          write(draft(badgeQuote, [...web, 'packages/api/src/x.ts'], done)),
        )
      ).pass,
    ).toBe(false);
    const none = await judge('brief-drafter/project-badge', 'ok');
    expect(none.pass).toBe(false);
    expect(none.reason).toContain('没有写出');
  });
  it('split-by-module：原话里的截图留在原话栏、验收条里不写', async () => {
    const api = ['packages/api/src/routes/tasks.ts', 'packages/api/test/tasks-route.test.ts'];
    expect(
      (
        await judge(
          'brief-drafter/split-by-module',
          'ok',
          write(draft(splitQuote, api, ['1. `GET /tasks?status=failed` 只返回失败的任务。'])),
        )
      ).pass,
    ).toBe(true);
    expect(
      (
        await judge(
          'brief-drafter/split-by-module',
          'ok',
          write(draft(splitQuote, api, ['1. 筛选结果截图贴 PR。'])),
        )
      ).pass,
    ).toBe(false);
    expect(
      (
        await judge(
          'brief-drafter/split-by-module',
          'ok',
          write(draft(splitQuote, [...api, 'packages/web/src/pages/tasks.tsx'], ['1. 接口筛选。'])),
        )
      ).pass,
    ).toBe(false);
  });
});

describe('architect（LLM 打分，裁判注入）', () => {
  const c = ARCHITECT_CASES[0];
  it('裁判提示词带题目、评分标准和待评的方案，要逐条得分', () => {
    const p = judgePrompt('我的方案');
    expect(p).toContain('我的方案');
    expect(p).toContain('评分标准');
    expect(p).toContain('只回一个 JSON');
    expect(p).toContain('"items": [<8 个数');
  });
  it('分数 ≥ 0.7 过，低于不过；以代码按分数判，不信裁判自己写的 pass', async () => {
    const high = await judge(
      'architect/engine-concurrency-limit',
      '方案',
      undefined,
      async () => '{"score": 0.85, "pass": false, "reason": "写得全"}',
    );
    expect(high).toMatchObject({ pass: true, score: 0.85 });
    const low = await judge(
      'architect/engine-concurrency-limit',
      '方案',
      undefined,
      async () => '```json\n{"score": 0.4, "pass": true, "reason": "漏了原子性"}\n```',
    );
    expect(low).toMatchObject({ pass: false, score: 0.4 });
    expect(c?.usesJudge).toBe(true);
  });
  it('裁判没回 JSON、分数不在 0–1：判不了', async () => {
    await expect(
      judge('architect/engine-concurrency-limit', '方案', undefined, async () => '写得不错'),
    ).rejects.toThrow(UngradableError);
    expect(() => parseJudgeAnswer('{"score": 7}')).toThrow(UngradableError);
    expect(() => parseJudgeAnswer('{score: 1}')).toThrow(UngradableError);
    expect(() => parseJudgeAnswer('{"items": [1, 1]}')).toThrow(UngradableError);
    expect(() => parseJudgeAnswer('{"items": [1, 1, 1, 1, 1, 1, 1, 0.7]}')).toThrow(UngradableError);
  });
  it('给了逐条得分：分数按逐条平均算，不信裁判自己写的 score', () => {
    expect(
      parseJudgeAnswer('{"items": [1, 1, 1, 1, 0.5, 0.5, 0, 1], "score": 1, "reason": "x"}'),
    ).toMatchObject({
      score: 0.75,
      items: [1, 1, 1, 1, 0.5, 0.5, 0, 1],
    });
  });
});

describe('architect 真题（必须满分的几条：当时真栽在那里）', () => {
  const allFull = '{"items": [1, 1, 1, 1, 1, 1, 1, 1], "reason": "齐"}';
  for (const id of ['architect/two-family-verify', 'architect/release-restore-switch']) {
    it(`${id}：逐条满分过；总分够线但必须那几条只拿一半不过；只给总分判不了`, async () => {
      const c = find(id);
      expect(c.usesJudge).toBe(true);
      let asked = '';
      const full = await judge(id, '方案', undefined, async (p) => {
        asked = p;
        return allFull;
      });
      expect(full).toMatchObject({ pass: true, score: 1 });
      expect(asked).toContain('必须写明');
      // 当时的错法：方案四平八稳，独独没想到返工补上的那两条（只泛泛提到，裁判给一半）
      const half = await judge(
        id,
        '方案',
        undefined,
        async () => '{"items": [1, 1, 0.5, 0.5, 1, 1, 1, 1], "reason": "第 3、4 条只泛泛提到"}',
      );
      expect(half.pass).toBe(false);
      expect(half.score).toBe(0.875);
      expect(half.reason).toContain('第 3、4 条没拿满');
      const scoreOnly = judge(id, '方案', undefined, async () => '{"score": 0.95, "reason": "好"}');
      await expect(scoreOnly).rejects.toThrow(UngradableError);
    });
  }
});

describe('fixer（真跑夹具里的测试）', () => {
  it('format-bytes：对的修法转绿；没动仍红；改测试、碰别的文件、打特例补丁都不过', async () => {
    const id = 'fixer/format-bytes';
    expect(await judge(id, '改了', copyHiddenDir('fix'))).toMatchObject({ pass: true });
    const red = await judge(id, '改了');
    expect(red.pass).toBe(false);
    expect(red.reason).toContain('测试没转绿');
    const t = await judge(id, '改了', (d, cd) => {
      copyHiddenDir('fix')(d, cd);
      edit(d, 'test/bytes.test.ts', (s) => s.replace("'1.0 MB'", "'1024.0 KB'"));
    });
    expect(t.reason).toContain('测试文件');
    const stray = await judge(id, '改了', (d, cd) => {
      copyHiddenDir('fix')(d, cd);
      writeFileSync(join(d, 'notes.md'), 'x');
    });
    expect(stray.reason).toContain('交代以外');
    const special = await judge(id, '改了', (d) =>
      edit(d, 'src/bytes.ts', (s) =>
        s.replace('let value = bytes;', "if (bytes === 1048575) return '1.0 MB';\n  let value = bytes;"),
      ),
    );
    expect(special.pass).toBe(false);
  });
  it('slugify', async () => {
    const id = 'fixer/slugify';
    expect((await judge(id, '改了', copyHiddenDir('fix'))).pass).toBe(true);
    expect((await judge(id, '改了')).pass).toBe(false);
    // 只改了合并连续分隔符，没去重音：visible 的重音测试仍红
    const half = await judge(id, '改了', (d) =>
      edit(d, 'src/slug.ts', (s) => s.replace('/[^a-z0-9]/g', '/[^a-z0-9]+/g')),
    );
    expect(half.pass).toBe(false);
  });
});

describe('builder（藏起来的验收测试）', () => {
  it('parse-duration：参考实现过；没实现不过；删了原有测试不过', async () => {
    const id = 'builder/parse-duration';
    expect((await judge(id, '做了', copyHiddenDir('solution'))).pass).toBe(true);
    expect((await judge(id, '做了')).pass).toBe(false);
    const del = await judge(id, '做了', (d, cd) => {
      copyHiddenDir('solution')(d, cd);
      rmSync(join(d, 'test', 'duration.test.ts'));
    });
    expect(del.reason).toContain('原有的测试');
  });
  it('parse-duration：把 ms 当成 m 加 s 的实现过不了', async () => {
    const naive = (d: string) =>
      writeFileSync(
        join(d, 'src', 'duration.ts'),
        `${readFileSync(join(d, 'src', 'duration.ts'), 'utf8')}\nexport function parseDuration(t: string): number {\n  let total = 0;\n  for (const m of t.matchAll(/(\\d+)([dhms])/g)) total += Number(m[1]) * ({ d: 86400000, h: 3600000, m: 60000, s: 1000 }[m[2] as 'd'] ?? 0);\n  return total;\n}\n`,
      );
    expect((await judge('builder/parse-duration', '做了', naive)).pass).toBe(false);
  });
  it('ttl-cache：参考实现过；没实现不过', async () => {
    expect((await judge('builder/ttl-cache', '做了', copyHiddenDir('solution'))).pass).toBe(true);
    expect((await judge('builder/ttl-cache', '做了')).pass).toBe(false);
  });
});

describe('debugger（先看根因再看 diff 大小）', () => {
  it('week-start-tz：根因修法过；打特例补丁不过；改得太大不过', async () => {
    const id = 'debugger/week-start-tz';
    expect((await judge(id, '根因', copyHiddenDir('fix'))).pass).toBe(true);
    expect((await judge(id, '根因')).pass).toBe(false);
    const patch = await judge(id, '特判', (d) =>
      edit(d, 'src/week.ts', (s) =>
        s.replace(
          'const back = (weekdayOf(at) + 6) % 7;',
          "const back = ((timeZone === 'Asia/Tokyo' ? 1 : weekdayOf(at)) + 6) % 7;",
        ),
      ),
    );
    expect(patch.pass).toBe(false);
    const big = await judge(id, '根因', (d, cd) => {
      copyHiddenDir('fix')(d, cd);
      edit(
        d,
        'src/week.ts',
        (s) => `${s}${Array.from({ length: 30 }, (_, i) => `// 多余的注释 ${i}`).join('\n')}\n`,
      );
    });
    expect(big.pass).toBe(false);
    expect(big.reason).toContain('超过上限');
  });
  it('week-start-tz：根因修法整份写回成 CRLF（Windows 上 Python 文本模式那样）照样过，换行符不算改动', async () => {
    const id = 'debugger/week-start-tz';
    const crlf = await judge(id, '根因', (d, cd) => {
      copyHiddenDir('fix')(d, cd);
      edit(d, 'src/week.ts', (s) => s.replace(/\r?\n/g, '\r\n'));
      edit(d, 'test/week.test.ts', (s) => s.replace(/\r?\n/g, '\r\n'));
    });
    expect(crlf).toMatchObject({ pass: true });
  });
  it('merge-config：改 mergeConfig 过；只在 loadConfig 里克隆（治症状）不过', async () => {
    const id = 'debugger/merge-config';
    expect((await judge(id, '根因', copyHiddenDir('fix'))).pass).toBe(true);
    const symptom = await judge(id, '根因', (d) =>
      edit(d, 'src/load.ts', (s) =>
        s.replace('mergeConfig(DEFAULTS, override)', 'mergeConfig(structuredClone(DEFAULTS), override)'),
      ),
    );
    expect(symptom.pass).toBe(false);
    expect(symptom.reason).toContain('没转绿');
  });
});

describe('standard-editor', () => {
  const id = 'standard-editor/pr-rounds';
  const fix = (d: string) => {
    edit(d, 'rules/pr-rules.md', (s) => s.replaceAll('3 轮', '2 轮'));
    edit(d, 'test/rules.test.ts', (s) => s.replaceAll('3 轮', '2 轮'));
  };
  it('规矩和钉它的测试一起改成 2 轮：过', async () => {
    expect(await judge(id, '改了', fix)).toMatchObject({ pass: true });
  });
  it('只改了文档：测试还钉着 3 轮；什么都没改；误改了 3 次；删断言；skip 都不过', async () => {
    expect(
      (await judge(id, '改了', (d) => edit(d, 'rules/pr-rules.md', (s) => s.replaceAll('3 轮', '2 轮'))))
        .pass,
    ).toBe(false);
    expect((await judge(id, '没改')).pass).toBe(false);
    const over = await judge(id, '改了', (d) => {
      fix(d);
      edit(d, 'rules/pr-rules.md', (s) => s.replace('不超过 3 次', '不超过 2 次'));
      edit(d, 'test/rules.test.ts', (s) => s.replace('不超过 3 次', '不超过 2 次'));
    });
    expect(over.reason).toContain('连续失败不超过 3 次');
    const fewer = await judge(id, '改了', (d) => {
      fix(d);
      edit(d, 'test/rules.test.ts', (s) => s.replace(/test\('交接要写清卡在哪'[\s\S]*?\n\}\);\n\n/, ''));
    });
    expect(fewer.reason).toContain('断言变少');
    const skipped = await judge(id, '改了', (d) => {
      fix(d);
      edit(d, 'test/rules.test.ts', (s) =>
        s.replace("test('交接要写清卡在哪'", "test.skip('交接要写清卡在哪'"),
      );
    });
    expect(skipped.reason).toContain('skip');
    const onlyOne = await judge(id, '改了', (d) => {
      fix(d);
      edit(d, 'rules/pr-rules.md', (s) => s.replace('超过 2 轮没合进去的 PR', '超过 5 次没合进去的 PR'));
    });
    expect(onlyOne.pass).toBe(false);
  });
  it('测试里加「旧说法不在了」的反向断言（Sonnet、Opus 2026-10-10 的实答写法）：过', async () => {
    const negated = await judge(id, '改了', (d) => {
      fix(d);
      edit(d, 'test/rules.test.ts', (s) =>
        s.replace(
          "assert.ok(rules.includes('一个 PR 最多 2 轮'));",
          "assert.ok(rules.includes('一个 PR 最多 2 轮'));\n  assert.ok(!rules.includes('一个 PR 最多 3 轮'));",
        ),
      );
    });
    expect(negated).toMatchObject({ pass: true });
    const noMatch = await judge(id, '改了', (d) => {
      fix(d);
      edit(
        d,
        'test/rules.test.ts',
        (s) =>
          `${s}\ntest('旧的 PR 轮数说法没有残留', () => {\n  assert.doesNotMatch(rules, /(?<![0-9])3 轮/);\n});\n`,
      );
    });
    expect(noMatch).toMatchObject({ pass: true });
  });
  it('新加测试的标题说「3 轮已经没了」不算残留（Sonnet、Opus 2026-10-10 重跑的实答标题）：过', async () => {
    for (const t of ['规矩里不再有 3 轮的旧说法', '旧的 3 轮说法已清干净', '旧的 3 轮说法已全部清掉']) {
      const v = await judge(id, '改了', (d) => {
        fix(d);
        edit(
          d,
          'test/rules.test.ts',
          (s) => `${s}\ntest('${t}', () => {\n  assert.ok(!rules.includes('最多 3 轮'));\n});\n`,
        );
      });
      expect(v, t).toMatchObject({ pass: true });
    }
  });
  it('标题还写着 3 轮；测试没钉住 2 轮（放回原来的规矩也过）：都不过', async () => {
    const title = await judge(id, '改了', (d) => {
      fix(d);
      edit(d, 'test/rules.test.ts', (s) =>
        s.replace("test('规矩写明一个 PR 最多 2 轮'", "test('规矩写明一个 PR 最多 3 轮'"),
      );
    });
    expect(title.pass).toBe(false);
    expect(title.reason).toContain('标题');
    const loose = await judge(id, '改了', (d) => {
      edit(d, 'rules/pr-rules.md', (s) => s.replaceAll('3 轮', '2 轮'));
      edit(d, 'test/rules.test.ts', (s) =>
        s
          .replace("test('规矩写明一个 PR 最多 3 轮'", "test('规矩写明一个 PR 最多几轮'")
          .replace("rules.includes('一个 PR 最多 3 轮')", "rules.includes('一个 PR 最多') /* 2 轮 */")
          .replace("test('超过 3 轮按交接处理'", "test('超过上限按交接处理'")
          .replace("rules.includes('超过 3 轮没合进去的 PR')", "rules.includes('没合进去的 PR')"),
      );
    });
    expect(loose.pass).toBe(false);
    expect(loose.reason).toContain('没钉住');
  });
});

// —— 真题（#1714）：仓快照题在测试里不 git archive（CI 是浅克隆，固定提交不在），拿 hidden/base 存的原件搭一个小快照判 ——

/** 搭小快照：hidden/base 的原件写进去，再按 setup 改。 */
const fromBase = (setup: (dir: string) => void) => (dir: string, caseDir: string) => {
  writeBase(caseDir, dir);
  setup(dir);
};

/** 照当时合进去的修法改一处原文：找不到要改的原文就是测试自己写错了。 */
const swap = (dir: string, rel: string, from: string, to: string) =>
  edit(dir, rel, (s) => {
    if (!s.includes(from)) throw new Error(`${rel} 里找不到要换的原文：${from}`);
    return s.replace(from, to);
  });

describe('debugger 真题（仓快照：藏起来的验收在原件上跑）', () => {
  const E2E = 'packages/conventions/src/ci-plan.ts';
  const STRICT = '  if (n.changes?.outputs?.e2e !== e2eOutput(plan.e2e))';
  it('e2e-output-omitted：#1207 的一行修法过；当时 #1200 的原样不过；删掉核对、让空清单输出占位值、碰别的文件都不过', async () => {
    const id = 'debugger/e2e-output-omitted';
    const fixed = await judge(
      id,
      '根因',
      fromBase((d) => swap(d, E2E, STRICT, "  if ((n.changes?.outputs?.e2e ?? '') !== e2eOutput(plan.e2e))")),
    );
    expect(fixed).toMatchObject({ pass: true });
    // 当时的错法：#1200 合进去的严格比较，GitHub 不给空串输出就判红
    const asShipped = await judge(
      id,
      '根因',
      fromBase(() => {}),
    );
    expect(asShipped.pass).toBe(false);
    expect(asShipped.reason).toContain('验收没过');
    // 顺着症状把核对删掉：plan 要跑 e2e 而开关缺了也放过
    const dropped = await judge(
      id,
      '根因',
      fromBase((d) => swap(d, E2E, STRICT, '  if (false)')),
    );
    expect(dropped.pass).toBe(false);
    // 让空清单输出个占位值：ci.yml 的 e2e job 靠空串跳过，题面说了不改 ci.yml
    const placeholder = await judge(
      id,
      '根因',
      fromBase((d) =>
        swap(
          d,
          E2E,
          "  return e === 'all' ? 'all' :",
          "  if (e !== 'all' && e.length === 0) return 'none';\n  return e === 'all' ? 'all' :",
        ),
      ),
    );
    expect(placeholder.pass).toBe(false);
    const stray = await judge(
      id,
      '根因',
      fromBase((d) => {
        swap(d, E2E, STRICT, "  if ((n.changes?.outputs?.e2e ?? '') !== e2eOutput(plan.e2e))");
        edit(d, 'packages/conventions/src/repo.ts', (s) => `${s}\n// 顺手改一下\n`);
      }),
    );
    expect(stray.reason).toContain('交代以外');
  });

  it('pr-fields-heading：#66 两处一起修过；只修正则、只截小标题、放宽存在性检查都不过', async () => {
    const id = 'debugger/pr-fields-heading';
    const PF = 'packages/conventions/src/pr-fields.ts';
    const LOOP = "  for (const line of stripComments(body.replace(/\\r\\n?/g, '\\n')).split('\\n')) {";
    const heading = (d: string) =>
      swap(
        d,
        PF,
        LOOP,
        `${LOOP}\n    if (/^\\s{0,3}#{1,6}(?:\\s|$)/.test(line)) {\n      flush();\n      current = undefined;\n      buf = [];\n      continue;\n    }`,
      );
    const colon = (d: string) =>
      swap(d, PF, '[^\\s、，,；;()（）[\\]「」]+/g', '[^\\s、，,；;：:。()（）[\\]「」]+/g');
    expect(
      await judge(
        id,
        '根因',
        fromBase((d) => {
          heading(d);
          colon(d);
        }),
      ),
    ).toMatchObject({ pass: true });
    // 当时的样子：两回都判红
    expect(
      (
        await judge(
          id,
          '根因',
          fromBase(() => {}),
        )
      ).pass,
    ).toBe(false);
    // 只修看得见的那一处：另一种写法照样红
    expect((await judge(id, '根因', fromBase(colon))).pass).toBe(false);
    expect((await judge(id, '根因', fromBase(heading))).pass).toBe(false);
    // 放宽存在性检查：报错没了，写错的目录也不报了
    const loose = await judge(
      id,
      '根因',
      fromBase((d) => swap(d, PF, "|| !repo.exists(p.replace(/\\/+$/, ''))", '|| false')),
    );
    expect(loose.pass).toBe(false);
  });
});

describe('standard-editor 真题', () => {
  const OLD = '不用 Fable（出比 5.1 更高的版本之前）';
  const NEW = '不用 Fable（创始人定）';
  /** 小快照里 bans.ts 等是原件；candidates.test.ts、AGENTS.md 只放钉文案的那几行（够判分读）。 */
  const fable = (opts: {
    demo: boolean;
    tests?: boolean;
    agents?: boolean;
    scan?: boolean;
    reason?: string;
  }) =>
    fromBase((d) => {
      const reason = opts.reason ?? NEW;
      mkdirSync(join(d, 'packages/db/test'), { recursive: true });
      const r = opts.tests === false ? OLD : reason;
      writeFileSync(
        join(d, 'packages/db/test/candidates.test.ts'),
        `      ['fable51', ['banned'], ['${r}']],\n      ['fable52', ['banned'], ['${r}']],\n`,
      );
      writeFileSync(
        join(d, 'AGENTS.md'),
        opts.agents === false
          ? '- GPT 系不做界面类的活（包括审界面）；Fable 不用，出比 5.1 更高的版本前也别推荐。\n'
          : '- GPT 系不做界面类的活（包括审界面）；Fable 不用（创始人 2026-10-03 拍，永久，不挂版本号）。\n',
      );
      swap(d, 'packages/shared/src/bans.ts', `reason: '${OLD}'`, `reason: '${reason}'`);
      if (opts.demo)
        swap(
          d,
          'packages/web/src/build/demo-renames.ts',
          '/不用 Fable（出比 5\\.1 更高的版本之前）/g',
          `/${reason.replace(/\./g, '\\.')}/g`,
        );
      if (opts.scan) edit(d, 'packages/web/src/build/scan.ts', (s) => s.replace("  '不用 Fable',\n", ''));
    });
  it('fable-ban-permanent：#669 合进去的四处都改过；当时漏 demo-renames.ts 的那版不过；没改测试、没改通用段、删扫描词都不过', async () => {
    const id = 'standard-editor/fable-ban-permanent';
    expect(await judge(id, '改了', fable({ demo: true }))).toMatchObject({ pass: true });
    // 真跑时 Sonnet、Opus 写的理由：「不看版本」正是永久的意思，不算挂版本号（#1714 先前把它判错了）
    const anyVersion = fable({ demo: true, reason: '不用 Fable（整个模型族，不看版本）' });
    expect(await judge(id, '改了', anyVersion)).toMatchObject({ pass: true });
    // 只把版本号换成另一个：撤回条件还在
    const bumped = await judge(id, '改了', fable({ demo: true, reason: '不用 Fable（出 6.0 之前）' }));
    expect(bumped.pass).toBe(false);
    expect(bumped.reason).toContain('理由里不再挂版本号');
    // 当时的错法：#669 第一个提交改了 bans.ts、AGENTS.md、candidates.test.ts，漏了 demo-renames.ts（CI 的 web、test rest 红）
    const missedDemo = await judge(id, '改了', fable({ demo: false }));
    expect(missedDemo.pass).toBe(false);
    expect(missedDemo.reason).toContain('样例说法');
    expect((await judge(id, '改了', fable({ demo: true, tests: false }))).pass).toBe(false);
    expect((await judge(id, '改了', fable({ demo: true, agents: false }))).pass).toBe(false);
    const scan = await judge(id, '改了', fable({ demo: false, scan: true }));
    expect(scan.reason).toContain('不该动');
  });

  /** 小快照里只放判分读的几行：每处给「当时的原样」或「补齐之后」。 */
  const promptLog = (fixed: ReadonlySet<string>) => (dir: string, caseDir: string) => {
    writeBase(caseDir, dir);
    const put = (rel: string, before: string, after: string) => {
      mkdirSync(join(dir, rel, '..'), { recursive: true });
      writeFileSync(join(dir, rel), fixed.has(rel) ? after : before);
    };
    put(
      'packages/agents-sync/src/targets.ts',
      "      { event: 'Stop', script: 'stop.mjs', timeout: 10 },\n",
      "      { event: 'Stop', script: 'stop.mjs', timeout: 10 },\n      { event: 'UserPromptSubmit', script: 'prompt-log.mjs', timeout: 30000 },\n",
    );
    put(
      'packages/agents-sync/test/helpers.ts',
      "  'stop.mjs': '// 假的收尾提醒钩子\\n',\n",
      "  'stop.mjs': '// 假的收尾提醒钩子\\n',\n  'prompt-log.mjs': '// 假的落盘钩子\\n',\n",
    );
    for (const rel of ['packages/agents-sync/test/cli.test.ts', 'packages/agents-sync/test/hooks.test.ts'])
      put(
        rel,
        "    expect(Object.keys(s.hooks)).toEqual(['PreToolUse', 'Stop']);\n",
        "    expect(Object.keys(s.hooks)).toEqual(['PreToolUse', 'Stop', 'UserPromptSubmit']);\n",
      );
    put(
      'deploy/test/agents-sync.test.sh',
      'printf \'// 假的收尾提醒钩子\\n\' >"$R/agents/hooks/stop.mjs"\n  PreToolUse,Stop\n',
      'printf \'// 假的收尾提醒钩子\\n\' >"$R/agents/hooks/stop.mjs"\nprintf \'// 假的落盘钩子\\n\' >"$R/agents/hooks/prompt-log.mjs"\n  PreToolUse,Stop,UserPromptSubmit\n',
    );
    put(
      'packages/conventions/src/ci-plan.ts',
      "  db: ['core'],\n  [AGENTS_UNIT]: ['db'],\n",
      "  db: ['core'],\n  [AGENTS_UNIT]: ['db', 'agents-sync'],\n",
    );
    put(
      'packages/conventions/test/ci-cache.test.ts',
      "    expect(sourceClosure(GRAPH, ['agents'])).toEqual(['db', 'shared']);\n",
      "    expect(sourceClosure(GRAPH, ['agents'])).toEqual(['agents-sync', 'db', 'shared']);\n",
    );
  };
  const ALL = new Set(PROMPT_LOG_EDITS.map((e) => e.file));
  it('prompt-log-hook：七处都改齐过；当时第一版只改 targets.ts 不过；补了两回、还差 CI 判法那两处也不过', async () => {
    const id = 'standard-editor/prompt-log-hook';
    expect(await judge(id, '改了', promptLog(ALL))).toMatchObject({ pass: true });
    // 当时的错法：#823 第一版只登记了 targets.ts，CI 红了三回才补齐
    const first = await judge(id, '改了', promptLog(new Set(['packages/agents-sync/src/targets.ts'])));
    expect(first.pass).toBe(false);
    expect(first.reason).toContain('漏了 6/7 处');
    const almost = new Set([...ALL].filter((f) => !f.startsWith('packages/conventions/')));
    const second = await judge(id, '改了', promptLog(almost));
    expect(second.reason).toContain('漏了 2/7 处');
    expect(second.reason).toContain('TEST_READS');
    // 登记写了 matcher、超时按秒写：规矩测试钉着的两条
    const matcher = await judge(id, '改了', (d, cd) => {
      promptLog(ALL)(d, cd);
      edit(d, 'packages/agents-sync/src/targets.ts', (s) =>
        s.replace(
          "script: 'prompt-log.mjs', timeout: 30000",
          "matcher: '*', script: 'prompt-log.mjs', timeout: 30",
        ),
      );
    });
    expect(matcher.pass).toBe(false);
    // 改了已经写好的规矩测试
    const rules = await judge(id, '改了', (d, cd) => {
      promptLog(ALL)(d, cd);
      edit(d, 'agents/test/rules/prompt-log.rules.test.ts', (s) =>
        s.replace('timeout:\\s*30000', 'timeout:\\s*\\d+'),
      );
    });
    expect(rules.reason).toContain('已经写好');
  });
  it('prompt-log-hook 的原件就是 #823 合进去的那两份（钩子脚本和规矩测试），夹具里的和原件一样', () => {
    const c = find('standard-editor/prompt-log-hook');
    const base = baseFiles(caseDirOf(c));
    expect([...base.keys()].sort()).toEqual([
      'agents/hooks/prompt-log.mjs',
      'agents/test/rules/prompt-log.rules.test.ts',
    ]);
    for (const [rel, text] of base)
      expect(readFileSync(join(caseDirOf(c), 'workspace', rel), 'utf8'), rel).toBe(text);
  });
});

describe('reviewer 真题（行号窗口写死：快照、change.diff 都是固定的）', () => {
  const commitOf = (id: string) => {
    const c = find(id);
    if (c.source.kind !== 'repo') throw new Error(`${id} 不是仓快照题`);
    return c.source.commit;
  };
  /** 读快照里的一个文件：本地有这个提交才读（CI 是浅克隆，读不到就只核 change.diff 那一侧）。 */
  const atCommit = (commit: string, rel: string): string | undefined => {
    const r = spawnSync('git', ['-C', REPO_ROOT, 'show', `${commit}:${rel}`], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return r.status === 0 ? r.stdout : undefined;
  };
  const cases: [string, readonly RealIssue[], RegExp[]][] = [
    [
      'reviewer/two-family-verify',
      TWO_FAMILY_ISSUES,
      [
        /verdicts\.push\(r\)|只派得出/,
        /[cC]hooseModelForFamily|m === undefined|两家都验|avoid\.has|route === undefined|没有能派的验收路由|没讨论成/,
        /sessions\.enter|ticket|runId/,
      ],
    ],
    [
      'reviewer/agent-eval-grading',
      GRADING_ISSUES,
      [
        /readFileSync\(join\(orig|split\('\\n'\)|changedLineCount/,
        /count\(test, '3 轮'\)/,
        /runNodeTests|includes\('2 轮'\)|assert\./,
        /mkdtempSync/,
      ],
    ],
  ];
  for (const [id, issues, mustSee] of cases) {
    it(`${id}：每个窗口里真是那一处的代码`, () => {
      const c = find(id);
      const diff = readFileSync(join(caseDirOf(c), 'workspace', 'change.diff'), 'utf8').split('\n');
      issues.forEach((issue, i) => {
        for (const spot of issue.spots) {
          const text = spot.file === 'change.diff' ? diff.join('\n') : atCommit(commitOf(id), spot.file);
          if (text === undefined) continue;
          const lines = text
            .split('\n')
            .slice(spot.from - 1, spot.to)
            .join('\n');
          expect(lines, `${issue.kind} @ ${spot.file}:${spot.from}-${spot.to}`).toMatch(mustSee[i] as RegExp);
        }
      });
    });
  }

  it('two-family-verify：返工改掉的两处都报出过；当时评审只挑局部写法的不过；误报超过 2 条不过', async () => {
    const id = 'reviewer/two-family-verify';
    const right = [
      'packages/engine/src/verifier-invoke.ts:779 — 两家都验挑到一家就起会话，凑不齐第二家时白跑，下次重来又整个跑一遍',
      'packages/engine/src/real/task-verify.ts:423 — 选路在等额度时也回 undefined，和派不出分不开，落到第 5 步把作者族拉进来互验',
    ].join('\n');
    expect(await judge(id, right)).toMatchObject({ pass: true });
    // 按 change.diff 的行号报一样认
    expect(
      await judge(id, 'change.diff:399 — 挑到一家就跑了\nchange.diff:230 — 在等和派不出不分'),
    ).toMatchObject({ pass: true });
    // 当时的错法：CI 绿、评审只挑了局部（session 只留第二家的、notes 拼接），两处都没看出来
    const local = await judge(
      id,
      'packages/engine/src/verifier-invoke.ts:797 — 只记了第二家的 session\npackages/engine/src/verifier-invoke.ts:794 — notes 去掉了第一条',
    );
    expect(local.pass).toBe(false);
    expect(local.reason).toContain('没找到');
    const onlyOne = await judge(id, 'packages/engine/src/verifier-invoke.ts:782 — 挑到一家就起会话');
    expect(onlyOne.pass).toBe(false);
    const noisy = await judge(
      id,
      [
        right,
        'packages/engine/src/verifier-invoke.ts:85 — x',
        'packages/engine/src/verifier-invoke.ts:90 — y',
        'packages/engine/src/routing/filter.ts:85 — z',
      ].join('\n'),
    );
    expect(noisy.pass).toBe(false);
    expect(noisy.reason).toContain('误报 3 条');
  });

  it('agent-eval-grading：CRLF 和数字面「3 轮」两处都报出过；只报了 8.3 短路径那类的不过', async () => {
    const id = 'reviewer/agent-eval-grading';
    const right = [
      'packages/agent-eval/src/grade-util.ts:64 — 比内容不管换行符，Windows 上整份写回 CRLF 就算改了',
      'packages/agent-eval/src/cases/code-tasks.ts:101 — 数测试里的「3 轮」，反向断言会被判成还钉着',
    ].join('\n');
    expect(await judge(id, right)).toMatchObject({ pass: true });
    const withExtra = await judge(id, `${right}\npackages/agent-eval/src/workspace.ts:19 — 8.3 短名`);
    expect(withExtra).toMatchObject({ pass: true });
    expect(withExtra.reason).toContain('另找到');
    // 当时的错法：单测全绿就合了，判分里这两处谁也没看出来
    expect((await judge(id, 'packages/agent-eval/src/workspace.ts:19 — 8.3 短名')).pass).toBe(false);
    expect((await judge(id, '没问题')).pass).toBe(false);
  });
});
