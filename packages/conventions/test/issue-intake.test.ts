import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  INTAKE_TOKEN_HEADER,
  INTAKE_URL_PATH,
  type IntakeBody,
  idempotencyKeyOf,
  liveIntakePost,
} from '../src/issue-intake.ts';
import { type GhResult, issueNew } from '../src/issue-new.ts';

const BODY = [
  '## 场景',
  '',
  '登录页现在只有密码，被撞库；先加一道验证码。',
  '',
  '## 原话',
  '',
  '「登录页加验证码。」（创始人 2026-09-26）',
  '',
  '## 已知的模块',
  '',
  '- packages/web 的登录页。',
  '',
  '## 怎么算做完',
  '',
  '- 测试：过期的验证码被拒。',
  '',
].join('\n');

const ok = (stdout: string): GhResult => ({ code: 0, stdout, stderr: '' });
const GH_URL = 'https://github.com/o/r/issues/36';
const TOKEN = 'fake-node-pass-123';

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: IntakeBody;
}

/** 假法国：reply 给 status+json，或抛网络错；记下每次请求。 */
function fakeFrance(reply: { status: number; json?: unknown; text?: string } | Error) {
  const sent: Sent[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(input),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)) as IntakeBody,
    });
    if (reply instanceof Error) throw reply;
    return new Response(reply.text ?? JSON.stringify(reply.json ?? {}), { status: reply.status });
  }) as typeof fetch;
  return { sent, post: liveIntakePost(() => ({ url: 'https://france.test/', token: TOKEN }), fakeFetch) };
}

function setup(reply: Parameters<typeof fakeFrance>[0], withSimilar = true) {
  const root = mkdtempSync(join(tmpdir(), 'fleet-issue-intake-'));
  writeFileSync(join(root, 'body.md'), BODY);
  const france = fakeFrance(reply);
  const calls: string[][] = [];
  const warns: string[] = [];
  const similarCalls: unknown[] = [];
  const gh = async (args: string[]): Promise<GhResult> => {
    if (args[0] === 'label') return ok('');
    calls.push(args);
    return ok(`${GH_URL}\n`);
  };
  const run = (...extra: string[]) =>
    issueNew(
      [
        '--kind',
        '需求',
        '--domain',
        'engine',
        '--nature',
        'process',
        '--milestone',
        '未排期',
        '--title',
        '加验证码',
        '--body-file',
        'body.md',
        ...extra,
      ],
      {
        gh,
        cwd: root,
        france: { repo: 'o/r', ref: 'sess-1', post: france.post },
        warn: (l) => warns.push(l),
        similar: withSimilar
          ? async (q) => {
              similarCalls.push(q);
              return { candidates: [], unchecked: [] } as never;
            }
          : undefined,
      },
    );
  return { france, calls, warns, similarCalls, run };
}

const created = (n = 77) => ({
  status: 200,
  json: { number: n, url: `https://github.com/o/r/issues/${n}`, created: true },
});

describe('issue:new 先走法国开单', () => {
  it('走法国开成功：请求头、路径、字段都对，不碰 gh 开单，也不在本机查相似单', async () => {
    const t = setup(created());
    const r = await t.run();
    expect(r).toMatchObject({ number: 77, viaFrance: true, milestone: '未排期' });
    expect(t.france.sent).toHaveLength(1);
    const s = t.france.sent[0] as Sent;
    expect(s.url).toBe(`https://france.test${INTAKE_URL_PATH}`);
    expect(s.headers[INTAKE_TOKEN_HEADER]).toBe(TOKEN);
    expect(s.body).toMatchObject({
      repo: 'o/r',
      kind: '需求',
      domain: 'engine',
      nature: 'process',
      milestone: '未排期',
      title: '加验证码',
      local: false,
      source: { kind: 'local-session', ref: 'sess-1' },
      idempotencyKey: idempotencyKeyOf('加验证码', BODY),
    });
    expect(s.body).not.toHaveProperty('force');
    expect(s.body).not.toHaveProperty('mergeInto');
    expect(t.calls.find((c) => c[0] === 'issue' && c[1] === 'create')).toBeUndefined();
    expect(t.similarCalls).toHaveLength(0);
    expect(t.warns).toEqual([]);
  });

  it('同一份标题加正文的幂等键不变，标题或正文一变就变', () => {
    expect(idempotencyKeyOf('a', 'b')).toBe(idempotencyKeyOf('a', 'b'));
    expect(idempotencyKeyOf('a', 'b')).not.toBe(idempotencyKeyOf('a', 'c'));
  });

  it('法国连不上：退回 gh 开单，打一行原因，退回时才查相似单', async () => {
    const t = setup(new Error('connect ECONNREFUSED'));
    const r = await t.run();
    expect(r.number).toBe(36);
    expect(r.viaFrance).toBeUndefined();
    expect(t.warns).toHaveLength(1);
    expect(t.warns[0]).toContain('连不上法国开单接口');
    expect(t.calls.find((c) => c[0] === 'issue' && c[1] === 'create')).toBeDefined();
    expect(t.similarCalls).toHaveLength(1);
  });

  it('通行证不会出现在错误信息里', async () => {
    const t = setup(new Error(`bad header ${TOKEN}`));
    await t.run();
    expect(t.warns.join('')).not.toContain(TOKEN);
  });

  it('401：退回 gh，提示去配机器通行证', async () => {
    const t = setup({ status: 401, json: { error: { code: 'unauthorized', message: 'bad token' } } });
    const r = await t.run();
    expect(r.number).toBe(36);
    expect(t.warns[0]).toContain('401');
    expect(t.warns[0]).toContain('local-sessions install');
    expect(t.calls.find((c) => c[0] === 'issue' && c[1] === 'create')).toBeDefined();
  });

  it('503：退回 gh', async () => {
    const t = setup({ status: 503, json: { error: { code: 'github_unavailable', message: '没接上' } } });
    const r = await t.run();
    expect(r.number).toBe(36);
    expect(t.warns[0]).toContain('503');
  });

  it('409：打印候选、不退回、不开单', async () => {
    const t = setup({
      status: 409,
      // api 的 errorBody 形状：{ error: { code, message, details } }
      json: {
        error: {
          code: 'duplicate_suspected',
          message: '和开着的 #12 太像，单没开',
          details: {
            candidates: [{ number: 12, title: '给登录加验证码', score: 0.93, why: '标题几乎一样' }],
          },
        },
      },
    });
    const err = await t.run().then(
      () => undefined,
      (e: Error) => e,
    );
    expect(err?.message).toContain('#12');
    expect(err?.message).toContain('给登录加验证码');
    expect(err?.message).toContain('0.93');
    expect(err?.message).toContain('标题几乎一样');
    expect(err?.message).toContain('--force');
    expect(err?.message).toContain('--merge-into');
    expect(t.warns).toEqual([]);
    expect(t.calls.find((c) => c[0] === 'issue' && c[1] === 'create')).toBeUndefined();
  });

  it('--force 透传', async () => {
    const t = setup(created());
    await t.run('--force');
    expect(t.france.sent[0]?.body.force).toBe(true);
  });

  it('--merge-into 透传；回 merged:true 就不开新单、跳过后续', async () => {
    const t = setup({
      status: 200,
      json: { number: 12, url: 'https://github.com/o/r/issues/12', created: false, merged: true },
    });
    const r = await t.run('--merge-into', '#12');
    expect(t.france.sent[0]?.body.mergeInto).toBe(12);
    expect(r).toMatchObject({ number: 12, merged: true });
    expect(r.order).toBeUndefined();
    expect(r.parent).toBeUndefined();
    expect(t.calls).toEqual([]);
  });

  it('--merge-into 碰上法国没接上：不退回 gh、不开单', async () => {
    const t = setup(new Error('timeout'));
    await expect(t.run('--merge-into', '12')).rejects.toThrow(/只有法国能做/);
    expect(t.calls.find((c) => c[0] === 'issue' && c[1] === 'create')).toBeUndefined();
  });

  it('--force 和 --merge-into 不能一起用', async () => {
    const t = setup(created());
    await expect(t.run('--force', '--merge-into', '12')).rejects.toThrow(/不能一起用/);
    expect(t.france.sent).toHaveLength(0);
  });

  it('422：打印正文问题、不退回', async () => {
    const t = setup({
      status: 422,
      json: {
        error: {
          code: 'body_incomplete',
          message: '正文有 2 处不合格',
          details: {
            problems: [
              { field: '怎么算做完', why: '「怎么算做完」没写字' },
              { field: '正文', why: '正文太长' },
            ],
          },
        },
      },
    });
    const err = await t.run().then(
      () => undefined,
      (e: Error) => e,
    );
    expect(err?.message).toContain('怎么算做完');
    expect(err?.message).toContain('正文太长');
    expect(t.warns).toEqual([]);
    expect(t.calls.find((c) => c[0] === 'issue' && c[1] === 'create')).toBeUndefined();
  });

  it('200 但回包认不出：抛错、不退回（单可能已开）', async () => {
    const t = setup({ status: 200, text: 'oops' });
    await expect(t.run()).rejects.toThrow(/认不出单号/);
    expect(t.calls.find((c) => c[0] === 'issue' && c[1] === 'create')).toBeUndefined();
  });

  it('母单直接走 gh，不发法国', async () => {
    const t = setup(created());
    await t.run('--mother').catch(() => undefined);
    expect(t.france.sent).toHaveLength(0);
  });
});
