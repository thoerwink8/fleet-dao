// 本机双写（#3741 片 2b）：pnpm progress note / 护栏库存周报先写法国账本，再照旧贴 #1055；账本写失败只警告。
import { describe, expect, it } from 'vitest';
import type { GhResult } from '../src/issue-new.ts';
import {
  type LedgerNoteBody,
  type LedgerNotePost,
  liveLedgerNotePost,
  noteIdempotencyKey,
  postLedgerNote,
  progressNoteWithLedger,
} from '../src/ledger-note.ts';

const NOW = new Date('2026-10-05T10:30:00Z');

function fakeGh() {
  const bodies: string[] = [];
  const gh = async (args: string[]): Promise<GhResult> => {
    const body = args.find((a) => a.startsWith('body='))?.slice(5) ?? '';
    bodies.push(body);
    return {
      code: 0,
      stdout: JSON.stringify({
        id: 1,
        body,
        html_url: 'https://github.com/o/r/issues/1055#c1',
        created_at: '2026-10-05T10:30:00Z',
      }),
      stderr: '',
    };
  };
  return { gh, bodies };
}

const okPost =
  (sent: LedgerNoteBody[]): LedgerNotePost =>
  async (b) => {
    sent.push(b);
    return { status: 200, text: JSON.stringify({ id: 7, created: true }) };
  };

describe('progressNoteWithLedger', () => {
  it('账本写一次，#1055 照旧贴一条', async () => {
    const sent: LedgerNoteBody[] = [];
    const w = fakeGh();
    const key = noteIdempotencyKey('progress-note', '合了 #12', NOW);
    await progressNoteWithLedger(
      '合了 #12',
      { gh: w.gh, now: () => NOW },
      { repo: 'o/r', kind: 'progress.note', idempotencyKey: key, post: okPost(sent) },
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      kind: 'progress.note',
      repo: 'o/r',
      text: '合了 #12',
      idempotencyKey: key,
    });
    expect(sent[0]?.source.kind).toBe('local-session');
    expect(w.bodies).toHaveLength(1);
    expect(w.bodies[0]).toContain('合了 #12');
  });

  it('【故意造出的失败】账本写失败（连不上 / 401 / 回包认不出）：警告并照写 #1055', async () => {
    const posts: LedgerNotePost[] = [
      async () => {
        throw new Error('ECONNREFUSED');
      },
      async () => ({ status: 401, text: '{"error":"no"}' }),
      async () => ({ status: 200, text: 'not json' }),
    ];
    for (const post of posts) {
      const w = fakeGh();
      const warns: string[] = [];
      await progressNoteWithLedger(
        '进度',
        { gh: w.gh, now: () => NOW },
        {
          repo: 'o/r',
          kind: 'report.guards',
          idempotencyKey: 'guard-inventory:2026-10-05',
          post,
          warn: (l) => warns.push(l),
        },
      );
      expect(w.bodies).toHaveLength(1);
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain('report.guards 没写进法国账本');
    }
  });

  it('认不出本仓：账本跳过并警告，#1055 照写', async () => {
    const w = fakeGh();
    const warns: string[] = [];
    await progressNoteWithLedger(
      '进度',
      { gh: w.gh },
      { repo: undefined, kind: 'progress.note', idempotencyKey: 'k-0000001', warn: (l) => warns.push(l) },
    );
    expect(w.bodies).toHaveLength(1);
    expect(warns[0]).toContain('认不出本仓');
  });

  it('空正文不写账本，照旧由 progressNote 拒绝', async () => {
    const sent: LedgerNoteBody[] = [];
    const w = fakeGh();
    await expect(
      progressNoteWithLedger(
        '  ',
        { gh: w.gh },
        { repo: 'o/r', kind: 'progress.note', idempotencyKey: 'k-0000001', post: okPost(sent) },
      ),
    ).rejects.toThrow('空');
    expect(sent).toHaveLength(0);
  });
});

describe('postLedgerNote / 幂等键 / 真发', () => {
  const body: LedgerNoteBody = {
    kind: 'progress.note',
    repo: 'o/r',
    text: 'x',
    source: { kind: 'local-session', ref: 's' },
    idempotencyKey: 'k-0000001',
  };

  it('同一句话同一分钟键一样，换一分钟或换一句就变；键合 shared 的字符集', () => {
    const a = noteIdempotencyKey('progress-note', '合了', NOW);
    expect(noteIdempotencyKey('progress-note', '合了 ', new Date(NOW.getTime() + 20_000))).toBe(a);
    expect(noteIdempotencyKey('progress-note', '合了', new Date(NOW.getTime() + 60_000))).not.toBe(a);
    expect(noteIdempotencyKey('progress-note', '没合', NOW)).not.toBe(a);
    expect(a).toMatch(/^[\w.:-]{8,128}$/);
  });

  it('回 200 且 id/created 对才算成', async () => {
    expect(
      await postLedgerNote(async () => ({ status: 200, text: '{"id":3,"created":false}' }), body),
    ).toEqual({ ok: true, id: 3, created: false });
  });

  it('真发带通行证头、不把通行证写进错误', async () => {
    let header = '';
    const post = liveLedgerNotePost(
      () => ({ url: 'https://fr.example/', token: 'sekret' }),
      (async (_u: unknown, init: RequestInit) => {
        header = (init.headers as Record<string, string>)['X-Fleet-Node-Token'] ?? '';
        throw new Error('boom sekret');
      }) as unknown as typeof fetch,
    );
    const r = await postLedgerNote(post, body);
    expect(header).toBe('sekret');
    expect(r).toEqual({ ok: false, why: 'boom ***' });
  });
});
