// 考题：九个接入点都有、每道题都够数、标准答案对得上题库、证据能直接喂进去；公开仓，不许带能认出人、账号、机器的东西。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BANK, questionsOfSite } from '../src/bank.ts';
import { checkExam, EXAMS_DIR, loadExam, runExam } from '../src/exam.ts';
import { createJev } from '../src/jev.ts';
import { DEFAULT_POLICY } from '../src/policy.ts';
import { SITES, type SiteId } from '../src/questions.ts';
import { fakeBackend, ok } from './helpers.ts';

/** 每道题至少这么多道考题。 */
const MIN_PER_QUESTION = 5;
const SITE_IDS = Object.keys(SITES) as SiteId[];

/** 占位用的名字：agent 是约定的占位，alice / bob 和单个字母是旧仓测试夹具里的示例。 */
const PLACEHOLDER = String.raw`(?:agent|alice|bob|[a-z])\b`;

const RULES: [string, RegExp][] = [
  ['邮箱', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g],
  ['IP', /\b(?!(?:127\.0\.0\.1|0\.0\.0\.0)\b)(?:\d{1,3}\.){3}\d{1,3}\b/g],
  ['家目录里的用户名', new RegExp(`/home/(?!${PLACEHOLDER})[A-Za-z0-9_.-]+`, 'g')],
  // 盘符前面不能紧挨着路径字符：/home/a:/home/b 里的 a: 不是盘符。
  [
    'Windows 用户目录',
    new RegExp(String.raw`(?<![\w/\\])[A-Za-z]:[\\/]Users[\\/](?!${PLACEHOLDER})[A-Za-z0-9_.-]+`, 'gi'),
  ],
  [
    '盘符下的个人目录',
    new RegExp(String.raw`(?<![\w/\\])[A-Za-z]:[\\/](?!${PLACEHOLDER}|Users\b)[A-Za-z0-9_.-]+`, 'g'),
  ],
  ['令牌', /\b(?:ghp_|gho_|ghs_|ghu_|github_pat_|sk-ant-|sk-|xai-|tvly-)[A-Za-z0-9_-]{8,}/g],
  ['带值的 Bearer', /Bearer\s+(?!<)[A-Za-z0-9._-]{12,}/g],
  ['飞书编号', /\b(?:ou|oc|om|on|cli)_[0-9a-f]{12,}\b/g],
];

export function findLeaks(text: string): string[] {
  return RULES.flatMap(([label, re]) => [...text.matchAll(re)].map((m) => `${label}：${m[0].slice(0, 60)}`));
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

  it('脱敏：不许有邮箱、IP、令牌、家目录用户名、飞书编号', () => {
    const leaks = SITE_IDS.flatMap((site) => {
      const parsed: unknown = JSON.parse(readFileSync(join(EXAMS_DIR, `${site}.json`), 'utf8'));
      return stringsIn(parsed).flatMap((s) => findLeaks(s).map((l) => `${site} ${l}`));
    });
    expect(leaks).toEqual([]);
  });

  it('故意放进去的违规样本都拦得住', () => {
    const samples = [
      'mail me: someone@example.com',
      'host 10.2.3.4',
      '"cwd":"/home/someone/.claude/projects/x"',
      'C:\\Users\\Administrator\\x',
      'C:/Users/someone/x',
      'D:/someone/windsurf-dao',
      'token ghs_abcdefghijklmnop',
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
      'from ou_56e1940982ad97f11c57cf599cdc600c',
    ];
    for (const s of samples) expect(findLeaks(s), s).toHaveLength(1);
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

  it('逐题记分：答对、答错、把握不够、答了题面外的选项分开数；limit 按文件顺序取前几道', async () => {
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
    expect(backend.calls).toHaveLength(0);
  });
});
