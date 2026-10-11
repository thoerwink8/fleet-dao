// 两种探测（#1798 片 5）：probeKindFor、pong 判法、身份题三种结果、题库覆盖 identityCheck 渠道开着的模型。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  expectedNewAnswers,
  hasIdentityQuestions,
  IDENTITY_QUESTIONS,
  type IdentityQuestion,
  identityPrompt,
  matchIdentityAnswer,
  NO_IDENTITY_QUESTION,
  parseProbeReply,
  pickIdentityQuestion,
  pingPrompt,
  probeKindFor,
} from '../../src/real/probe-identity.ts';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../../../..');

describe('probeKindFor', () => {
  const gpt = { identityCheck: true, modelId: 'gpt-6-sol' };
  const claudeRelay = { identityCheck: true, modelId: 'sonnet-5.5' };
  const noCheck = { identityCheck: false, modelId: 'gpt-6-sol' };

  it('identityCheck + active + 题库有题 → identity', () => {
    expect(probeKindFor(gpt, 'active')).toBe('identity');
  });

  it('identityCheck 为假 → ping', () => {
    expect(probeKindFor(noCheck, 'active')).toBe('ping');
  });

  it('不活跃 → ping', () => {
    expect(probeKindFor(gpt, 'idle')).toBe('ping');
    expect(probeKindFor(gpt, 'unused')).toBe('ping');
  });

  it('Claude 走中转但没备题 → ping', () => {
    expect(hasIdentityQuestions('sonnet-5.5')).toBe(false);
    expect(probeKindFor(claudeRelay, 'active')).toBe('ping');
  });
});

describe('连通 pong', () => {
  it('提示词只要求回 pong', () => {
    const p = pingPrompt();
    expect(p).toContain('不要调用任何工具');
    expect(p).toContain('不要解释');
    expect(p).toContain('只回一个词：pong');
    expect(p).not.toContain('答案：');
  });

  it('第一行整行等于 pong（不分大小写）才算通；Not pong、pong. 都算认不出', () => {
    expect(parseProbeReply('pong').pong).toBe(true);
    expect(parseProbeReply('PONG').pong).toBe(true);
    expect(parseProbeReply('**pong**').pong).toBe(true);
    expect(parseProbeReply('Not pong').pong).toBe(false);
    expect(parseProbeReply('pong.').pong).toBe(false);
    expect(parseProbeReply('pong\n多余').pong).toBe(true);
    expect(parseProbeReply('好的\npong').pong).toBe(false);
    expect(parseProbeReply('').pong).toBe(false);
  });
});

describe('身份题三种结果', () => {
  const q: IdentityQuestion = {
    id: 't',
    text: '现任日本首相是谁？',
    short: '日本首相',
    newAnswers: ['高市早苗', 'Takaichi'],
    oldAnswers: ['石破茂', 'Ishiba', '岸田文雄'],
    changedAt: '2025-10',
  };

  it('答出新答案算通过', () => {
    expect(matchIdentityAnswer(q, '高市早苗')).toBe('new');
    expect(matchIdentityAnswer(q, 'Takaichi')).toBe('new');
    expect(matchIdentityAnswer(q, '高市早苗。')).toBe('new');
  });

  it('说出旧答案判疑似换模型', () => {
    expect(matchIdentityAnswer(q, '石破茂')).toBe('old');
    expect(matchIdentityAnswer(q, 'Ishiba')).toBe('old');
    expect(matchIdentityAnswer(q, '岸田文雄')).toBe('old');
  });

  it('认不出', () => {
    expect(matchIdentityAnswer(q, '我不确定')).toBe('unknown');
    expect(matchIdentityAnswer(q, null)).toBe('unknown');
    expect(matchIdentityAnswer(q, '')).toBe('unknown');
  });

  it('身份提示词要三行，带题', () => {
    const p = identityPrompt(q);
    expect(p).toContain('第一行只写 pong');
    expect(p).toContain('「答案：」');
    expect(p).toContain('「模型：」');
    expect(p).toContain(q.text);
  });

  it('解析三行：pong、答案、自报身份', () => {
    expect(parseProbeReply('pong\n答案：高市早苗\n模型：gpt-6-sol')).toEqual({
      pong: true,
      answer: '高市早苗',
      identity: 'gpt-6-sol',
    });
  });

  it('expectedNewAnswers 用 / 拼', () => {
    expect(expectedNewAnswers(q)).toBe('高市早苗/Takaichi');
  });
});

describe('题库轮换与覆盖', () => {
  it('按天轮换，同一天同一道', () => {
    const day0 = new Date(0);
    const day1 = new Date(86_400_000);
    const a = pickIdentityQuestion('gpt-6-sol', day0);
    const b = pickIdentityQuestion('gpt-6-sol', day0);
    const c = pickIdentityQuestion('gpt-6-sol', day1);
    expect(a?.id).toBe(b?.id);
    expect(a?.id).not.toBe(c?.id);
  });

  it('每个有题的模型至少 2 道', () => {
    for (const [modelId, bank] of Object.entries(IDENTITY_QUESTIONS)) {
      expect(bank.length, modelId).toBeGreaterThanOrEqual(2);
      expect(bank.length, modelId).toBeLessThanOrEqual(3);
    }
  });

  it('deploy/catalog.json 里 identityCheck 渠道下开着的每个模型，要么题库有题，要么在 NO_IDENTITY_QUESTION 里写了理由', () => {
    const catalog = JSON.parse(readFileSync(join(ROOT, 'deploy/catalog.json'), 'utf8')) as {
      channels: Array<{ id: string; identityCheck?: boolean }>;
      routes: Array<{ id: string; poolId: string; modelId: string; hostId: string }>;
      pools: Array<{ id: string; channelId: string }>;
    };
    const routing = JSON.parse(readFileSync(join(ROOT, 'packages/db/routing.default.json'), 'utf8')) as {
      models: Record<string, Array<{ routeId: string; enabled: boolean }>>;
    };
    const identityChannels = new Set(
      catalog.channels.filter((c) => c.identityCheck === true).map((c) => c.id),
    );
    expect(identityChannels.size).toBeGreaterThan(0);
    const poolChannel = new Map(catalog.pools.map((p) => [p.id, p.channelId]));
    const enabledRouteIds = new Set<string>();
    for (const rows of Object.values(routing.models)) {
      for (const row of rows) {
        if (row.enabled) enabledRouteIds.add(row.routeId);
      }
    }
    const openModels = new Set<string>();
    for (const route of catalog.routes) {
      const channelId = poolChannel.get(route.poolId);
      if (!channelId || !identityChannels.has(channelId)) continue;
      if (!enabledRouteIds.has(route.id)) continue;
      openModels.add(route.modelId);
    }
    expect(openModels.size).toBeGreaterThan(0);
    for (const modelId of openModels) {
      const hasQ = hasIdentityQuestions(modelId);
      const reason = NO_IDENTITY_QUESTION[modelId];
      expect(hasQ || !!reason, `${modelId}：题库没题，也没写进 NO_IDENTITY_QUESTION`).toBe(true);
      if (!hasQ) expect(reason?.length, modelId).toBeGreaterThan(0);
    }
  });
});
