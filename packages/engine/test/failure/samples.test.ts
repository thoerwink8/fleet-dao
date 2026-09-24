// 真实报错样本逐条过一遍规则表：每条样本都要分到对的下一步动作；每条规则都要有样本撑着；公开仓里的东西要干净。
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  classifyFailure,
  type FailureEvidence,
  type FailureVerdict,
  RULES,
} from '../../src/failure/index.ts';

interface Sample {
  id: string;
  provenance: 'production' | 'observed' | 'test-only' | 'format' | 'synthetic';
  origin: string;
  evidence: FailureEvidence;
  expect: {
    action: FailureVerdict['action'];
    rule: string;
    avoid?: 'route' | 'pool' | 'model';
    until?: string;
    alert?: boolean;
    routeOutcome?: FailureVerdict['routeOutcome'];
    counter?: FailureVerdict['counter'];
    delaySeconds?: number;
    missingReason?: boolean;
  };
}

interface Fixture {
  provenance: Record<Sample['provenance'], string>;
  samples: Sample[];
  skipped: { ids: string[]; why: string }[];
}

const FILE = new URL('./fixtures/failure-samples.json', import.meta.url);
const RAW = readFileSync(FILE, 'utf8');
const FIXTURE = JSON.parse(RAW) as Fixture;
const NOW = '2026-09-25T00:00:00.000Z';

const run = (s: Sample) =>
  classifyFailure({ source: 'session:execute', routeId: 'route-a', now: NOW, ...s.evidence });

describe('真实样本逐条分对', () => {
  for (const s of FIXTURE.samples) {
    it(`${s.id}（${s.provenance}）→ ${s.expect.rule} ${s.expect.action}`, () => {
      const v = run(s);
      expect({ rule: v.rule, action: v.action }).toEqual({ rule: s.expect.rule, action: s.expect.action });
      if (s.expect.avoid !== undefined) expect(v.avoid?.scope).toBe(s.expect.avoid);
      if (s.expect.until !== undefined) expect(v.avoid?.until).toBe(s.expect.until);
      if (s.expect.alert !== undefined) expect(v.alert).toBe(s.expect.alert);
      if (s.expect.routeOutcome !== undefined) expect(v.routeOutcome).toBe(s.expect.routeOutcome);
      if (s.expect.counter !== undefined) expect(v.counter).toBe(s.expect.counter);
      if (s.expect.delaySeconds !== undefined) expect(v.delaySeconds).toBe(s.expect.delaySeconds);
      if (s.expect.missingReason !== undefined) expect(v.missingReason === true).toBe(s.expect.missingReason);
      // 每个结果一句白话、带规则编号。
      expect(v.reason).toMatch(/^[^\n]+$/);
      expect(v.reason).toContain(v.title);
    });
  }
});

describe('规则表和夹具对得上', () => {
  it('样本编号不重复，来源都是约定的几种', () => {
    const ids = FIXTURE.samples.map((s) => s.id);
    expect(ids.length).toBeGreaterThan(80);
    expect(new Set(ids).size).toBe(ids.length);
    const kinds = Object.keys(FIXTURE.provenance);
    expect(FIXTURE.samples.filter((s) => !kinds.includes(s.provenance)).map((s) => s.id)).toEqual([]);
    expect(FIXTURE.samples.filter((s) => !s.origin.trim()).map((s) => s.id)).toEqual([]);
  });

  it('每条规则至少有一条样本；只有合成样本撑着的规则点名在这里', () => {
    const byRule = new Map<string, Sample[]>();
    for (const s of FIXTURE.samples) byRule.set(s.expect.rule, [...(byRule.get(s.expect.rule) ?? []), s]);
    const ruleIds = RULES.map((r) => r.id);
    expect(ruleIds.filter((id) => !byRule.has(id))).toEqual([]);
    expect(ruleIds.filter((id) => byRule.get(id)?.every((s) => s.provenance === 'synthetic'))).toEqual([
      'KL2',
    ]);
    // 夹具里期望的规则都真实存在（FB = 认不出走兜底梯）。
    const known = new Set([...ruleIds, 'FB']);
    expect([...byRule.keys()].filter((id) => !known.has(id))).toEqual([]);
  });

  it('规则编号不重复，梯子都以挂起收尾', () => {
    const ids = RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(RULES.filter((r) => r.ladder.at(-1) !== 'park').map((r) => r.id)).toEqual([]);
  });

  it('跳过的样本写明了为什么，而且没有混进样本表', () => {
    const skipped = FIXTURE.skipped.flatMap((g) => g.ids);
    expect(FIXTURE.skipped.filter((g) => !g.why.trim())).toEqual([]);
    expect(FIXTURE.samples.filter((s) => skipped.includes(s.id)).map((s) => s.id)).toEqual([]);
  });

  it('同一条原文不管从哪一步、哪个执行方式进来，都认成同一条规则', () => {
    const drift = FIXTURE.samples
      .filter((s) => {
        const elsewhere = classifyFailure({
          ...s.evidence,
          source: 'session:review',
          hostId: 'api-shell',
          routeId: 'route-b',
          now: NOW,
        });
        return elsewhere.rule !== run(s).rule;
      })
      .map((s) => s.id);
    expect(drift).toEqual([]);
  });
});

// 公开仓：引擎包的代码、测试、夹具里都不许有能认出人、账号、机器、组织的东西。
const LEAKS: [string, RegExp][] = [
  ['邮箱', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g],
  ['IP', /\b(?!(?:127\.0\.0\.1|0\.0\.0\.0)\b)(?:\d{1,3}\.){3}\d{1,3}\b/g],
  ['家目录里的用户名', /\/home\/(?!agent\b)[A-Za-z0-9_.-]+/g],
  ['Windows 用户目录', /[A-Za-z]:\\\\?Users\\\\?[^\\\s"]+/g],
  ['令牌', /\b(?:ghp_|gho_|ghs_|ghu_|github_pat_|sk-ant-|xai-)[A-Za-z0-9_-]{8,}/g],
  ['请求编号', /\breq_[A-Za-z0-9]{8,}/g],
  ['组织编号', /(?:\borg(?:anization)?(?:[ _-]?id)?(?:\s+use)?|组织(?:编号)?)\s*[:=：]?\s*\d{3,}/gi],
];

function findLeaks(text: string): string[] {
  return LEAKS.flatMap(([label, re]) => [...text.matchAll(re)].map((m) => `${label}：${m[0].slice(0, 60)}`));
}

const ENGINE = fileURLToPath(new URL('../../', import.meta.url));

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? filesUnder(join(dir, d.name)) : [join(dir, d.name)],
  );
}

describe('脱敏', () => {
  it('引擎包 src/ 和 test/ 下每个文件都干净（代码、测试、夹具）', () => {
    const files = ['src', 'test'].flatMap((d) => filesUnder(join(ENGINE, d)));
    expect(files.some((f) => f.endsWith('failure-samples.json'))).toBe(true);
    expect(files.some((f) => f.endsWith('rules.ts'))).toBe(true);
    const leaks = files.flatMap((f) =>
      findLeaks(readFileSync(f, 'utf8')).map((l) => `${relative(ENGINE, f)} ${l}`),
    );
    expect(leaks).toEqual([]);
  });

  it('故意放进去的违规样本都拦得住', () => {
    // 全是假值，而且拼起来用：源码里不出现整段，上面那道扫描就不会扫到这个文件自己。
    const planted = [
      ['mail me: someone', 'example.com'].join('@'),
      `host ${['10', '0', '0', '1'].join('.')}`,
      `"auto":"${['', 'home', 'someone', '.claude'].join('/')}"`,
      ['C:', 'Users', 'someone', 'AppData'].join('\\'),
      `token ${['ghs', 'abcdefghijklmnop'].join('_')}`,
      `（请求 ID: ${['req', 'AAAAAAAAAAAAAAAA'].join('_')}）`,
      `reclaude org use ${'9'.repeat(4)}`,
      `切到组织 ${'1'.repeat(3)}`,
    ];
    expect(planted.map((s) => findLeaks(s).length)).toEqual(planted.map(() => 1));
    expect(findLeaks('127.0.0.1 · /home/agent · <请求ID> · gpt-5.6-terra · reclaude org use:')).toEqual([]);
  });
});
