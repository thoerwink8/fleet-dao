// 考题：九个接入点都有、每道题都够数、标准答案对得上题库、证据能直接喂进去；公开仓，不许带能认出人、账号、机器的东西。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { ALLOWLIST, applyAllowlist, findHits } from '@fleet-dao/hygiene';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BANK, questionsOfSite } from '../src/bank.ts';
import { checkExam, EXAMS_DIR, loadExam, pickSamples, runExam } from '../src/exam.ts';
import { createJev } from '../src/jev.ts';
import { DEFAULT_POLICY } from '../src/policy.ts';
import { SITES, type SiteId } from '../src/questions.ts';
import { fakeBackend, ok } from './helpers.ts';

/** 每道题至少这么多道考题。 */
const MIN_PER_QUESTION = 5;
const SITE_IDS = Object.keys(SITES) as SiteId[];

/** 审官自己写的定级、处置：留在考题的意见原文里，模型照抄就能答对，考不出东西。 */
const SELF_GRADE = /不阻塞|非阻塞|不计入红项|不挡|不追|顺手改|随后续|不在本单|可选改进|blocking|\bP[0-3]\b/i;

/**
 * 能认出人、账号、机器的东西：规则、白名单都用全仓卫生检查那一份（packages/hygiene），这里不另写一套。
 * 只报文件和规则名，不打命中的值。path 给白名单用（考题里原样收的上游请求号按那边的约定放行）。
 */
export function findLeaks(text: string, path = 'packages/jev/test/samples'): string[] {
  const hits = findHits(text).map((h) => ({ ...h, path }));
  return applyAllowlist(hits, ALLOWLIST, new Set()).map((h) => h.label);
}

/** JSON 里的反斜杠是转义过的，要解析后逐个字符串查，才查得到 C:\Users\… 这种。 */
function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringsIn);
  return [];
}

describe('考题文件', () => {
  it('每个接入点一份，没有多余的', () => {
    const files = readdirSync(EXAMS_DIR).filter((f) => f.endsWith('.json'));
    expect(files.sort()).toEqual(SITE_IDS.map((s) => `${s}.json`).sort());
  });

  for (const site of SITE_IDS) {
    it(`${site}：标准答案对得上题库，每道题至少 ${MIN_PER_QUESTION} 道，答案里既有放过的也有拦的`, () => {
      const samples = loadExam(site);
      expect(checkExam(site, samples)).toEqual([]);
      for (const q of questionsOfSite(site)) {
        const answers = samples.map((s) => s.expect[q.id]).filter((a): a is string => a !== undefined);
        expect(answers.length, `${q.id} 的考题数`).toBeGreaterThanOrEqual(MIN_PER_QUESTION);
        const effects = new Set(answers.map((a) => q.options.find((o) => o.id === a)?.effect));
        expect(effects.has('none'), `${q.id} 要有「不改流程」的考题`).toBe(true);
        expect(effects.size, `${q.id} 要有会拦的考题`).toBeGreaterThan(1);
      }
    });
  }

  it('巡检考试的每日次数默认够一天四轮满卷（每 6 小时一轮，设计「已定」第 15 条）', () => {
    const fullExam = SITE_IDS.reduce(
      (n, site) => n + loadExam(site).reduce((m, s) => m + Object.keys(s.expect).length, 0),
      0,
    );
    expect(DEFAULT_POLICY.examDailyCallLimit).toBeGreaterThanOrEqual(4 * fullExam);
  });

  it('脱敏：不许有邮箱、IP、令牌、家目录用户名、飞书编号', () => {
    const leaks = SITE_IDS.flatMap((site) => {
      const parsed: unknown = JSON.parse(readFileSync(join(EXAMS_DIR, `${site}.json`), 'utf8'));
      const path = `packages/jev/exams/${site}.json`;
      return stringsIn(parsed).flatMap((s) => findLeaks(s, path).map((l) => `${site} ${l}`));
    });
    expect(leaks).toEqual([]);
  });

  it('审查意见分级：意见原文里不许留审官自己的定级或处置（不阻塞、不在本单做……），那等于把答案写进了题里', () => {
    const hits = loadExam('review-grade').flatMap((s) => {
      const m = s.evidence.finding?.match(SELF_GRADE);
      return m ? [`${s.id}：${m[0]}`] : [];
    });
    expect(hits).toEqual([]);
    const planted = [
      '属非阻塞格式提示',
      '顺手改指针即可，不阻塞',
      '不在本单做',
      '随后续提交清理',
      '[P1] 路径逃逸',
    ];
    for (const bad of planted) expect(SELF_GRADE.test(bad), bad).toBe(true);
  });

  it('故意放进去的违规样本都拦得住', () => {
    // 样本在运行时拼起来：整段写在源码里，全仓卫生检查会拦这个文件自己。值是随手编的、不指向任何人。
    const samples = [
      `mail me: ${['zhangsan', 'corp-mail.co'].join('@')}`,
      `host ${[51, 38, 4, 17].join('.')}`,
      `"cwd":"${['', 'home', 'zhangsan', '.claude', 'projects', 'x'].join('/')}"`,
      ['C:', 'Users', 'zhangsan', 'x'].join('\\'),
      ['D:', 'zhangsan', 'windsurf-dao'].join('/'),
      `token ${['ghs', 'q7Rz2LmX9vKp4TnB8wYc1HdF6jGs3NaE'].join('_')}`,
      `Authorization: ${['Bearer', 'Q9vKp4TnB8wYc1HdF6jGs3NaEq7Rz2LmX'].join(' ')}`,
      `from ${['ou', '5e1d9a40c82f97b13c57af599cdc6e0d'].join('_')}`,
    ];
    for (const s of samples) expect(findLeaks(s).length, s).toBeGreaterThan(0);
    expect(
      findLeaks(
        '127.0.0.1 · /home/agent · /home/a,/home/b · C:/Users/alice · C:\\Users\\bob · D:/agent · Bearer <令牌> · ou_xxx · jev-1.13.0',
      ),
    ).toEqual([]);
  });
});

describe('考题能直接喂进去', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  }, TEST_DB_TIMEOUT_MS);
  afterAll(() => t.close());

  it('每道考题都能问出去（证据字段齐、没有不认识的字段），照标准答案作答就判得出来', async () => {
    const policy = { ...DEFAULT_POLICY, dailyCallLimit: 100_000 };
    for (const site of SITE_IDS) {
      for (const s of loadExam(site)) {
        // 假后端照这道考题的标准答案答，不出网。
        const backend = fakeBackend((req) =>
          ok(Object.fromEntries(req.questions.map((q) => [q.id, [s.expect[q.id] ?? '', 0.99]]))),
        );
        const jev = createJev({ db: t.db, backend, policy });
        const verdicts = await jev.exam(questionsOfSite(site), s.evidence, {
          runId: 'check',
          sampleId: s.id,
          expect: s.expect,
        });
        expect(verdicts.map((v) => v.questionId).sort(), `${site}/${s.id}`).toEqual(
          Object.keys(s.expect).sort(),
        );
        for (const v of verdicts) {
          expect(v, `${site}/${s.id}/${v.questionId}`).toMatchObject({
            judged: true,
            option: s.expect[v.questionId],
          });
        }
      }
    }
  });
});

describe('考一个接入点', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  }, TEST_DB_TIMEOUT_MS);
  afterAll(() => t.close());

  it('逐题记分：答对、答错、把握不够、答了题面外的选项分开数；标准答案都一样时 limit 按文件顺序取', async () => {
    const samples = [1, 2, 3, 4, 5].map((i) => ({
      id: `e${i}`,
      source: '测试',
      evidence: { step: 'runTests', message: `第 ${i} 条报错` },
      expect: { 'error-next': 'retry' },
      why: { 'error-next': '测试' },
    }));
    const replies: [string, number][] = [
      ['retry', 0.9],
      ['park', 0.9],
      ['retry', 0.4],
      ['later', 0.9],
      ['retry', 0.95],
    ];
    let i = 0;
    const backend = fakeBackend(() => ok({ 'error-next': replies[i++] ?? ['retry', 0.9] }));
    const jev = createJev({ db: t.db, backend, policy: { ...DEFAULT_POLICY, dailyCallLimit: 100 } });
    const report = await runExam(jev, 'error-route', { samples, limit: 4, runId: 'run-x' });
    expect(report.questions).toHaveLength(1);
    expect(report.questions[0]).toMatchObject({
      questionId: 'error-next',
      runId: 'run-x',
      asked: 4,
      answered: 3,
      sure: 2,
      correct: 1,
      badOption: 1,
      reasons: { unsure: 1, bad_option: 1 },
    });
    expect(report.questions[0]?.misses.map((m) => m.sampleId)).toEqual(['e2', 'e3', 'e4']);
    expect(BANK.some((q) => q.id === 'error-next')).toBe(true);
  });

  it('考题写坏了或一道都没有：不考，报错（坏考题算出来的准确率会被当真）', async () => {
    const backend = fakeBackend();
    const jev = createJev({ db: t.db, backend, policy: { ...DEFAULT_POLICY, dailyCallLimit: 100 } });
    const broken = [
      {
        id: 'bad',
        source: '测试',
        evidence: { step: 'runTests' },
        expect: { 'error-next': 'later' },
        why: {},
      },
    ];
    await expect(runExam(jev, 'error-route', { samples: broken })).rejects.toThrow(/没有选项 later/);
    await expect(runExam(jev, 'error-route', { samples: [] })).rejects.toThrow(/一道考题都没有/);
    await expect(runExam(jev, 'error-route', { limit: 0 })).rejects.toThrow(/正整数/);
    await expect(runExam(jev, 'error-route', { limit: Number.NaN })).rejects.toThrow(/正整数/);
    expect(backend.calls).toHaveLength(0);
  });
});

describe('只考一部分时挑哪几道', () => {
  it('考题文件按答案排：前几道全是同一个答案，挑的时候按标准答案轮着取', () => {
    const review = loadExam('review-grade');
    expect(review.slice(0, 2).map((s) => s.expect['review-severity'])).toEqual(['must_fix', 'must_fix']);
    expect(pickSamples(review, 2).map((s) => s.expect['review-severity'])).toEqual(['must_fix', 'minor']);
    const errors = pickSamples(loadExam('error-route'), 4).map((s) => s.expect['error-next']);
    expect(errors).toEqual(['retry', 'swap_route', 'swap_model', 'park']);
  });

  it('一道考好几题（分诊）：先把每道题的每个标准答案都考到', () => {
    const triage = loadExam('triage');
    const answers = (samples: typeof triage) =>
      new Set(samples.flatMap((s) => Object.entries(s.expect).map(([q, o]) => `${q}=${o}`)));
    const everything = answers(triage);
    const picked = pickSamples(triage, triage.length);
    const upTo = picked.findIndex((_, i) => answers(picked.slice(0, i + 1)).size === everything.size);
    expect(upTo).toBeGreaterThanOrEqual(0);
    expect(upTo + 1).toBeLessThanOrEqual(8);
    expect(new Set(picked.map((s) => s.id)).size).toBe(triage.length);
  });
});
