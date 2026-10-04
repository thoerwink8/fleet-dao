import { describe, expect, it } from 'vitest';
import { type Finding, findingMarker, reportFindings } from '../src/findings.ts';
import type { GitHubCommenter } from '../src/github-api.ts';

const HEADER = '某某检查查出来的，挂在这张单上：';

describe('定时任务查出来的留言到单上，同一条只留一次', () => {
  function fakeCommenter(existing: Record<number, string[]>, failOn?: number) {
    const posted: { n: number; body: string }[] = [];
    const gh: GitHubCommenter = {
      async comments(n) {
        if (n === failOn) throw new Error('GitHub 回了 502');
        return existing[n] ?? [];
      },
      async comment(n, body) {
        posted.push({ n, body });
      },
    };
    return { gh, posted };
  }
  const a: Finding = { issue: 29, key: 'ref:a', text: '甲' };
  const b: Finding = { issue: 29, key: 'ref:b', text: '乙' };
  const c: Finding = { issue: 40, key: 'ref:d', text: '丙' };
  const loose: Finding = { issue: undefined, key: 'ref:c', text: '丁' };

  it('一张单一条留言，带开头一句和记号；以前留过的不再留；没处留言的交回', async () => {
    const { gh, posted } = fakeCommenter({ 40: [`以前的留言${findingMarker('ref:d')}`] });
    const r = await reportFindings([a, b, c, loose], gh, HEADER);
    expect(r).toEqual({ posted: [29], already: 1, unattached: [loose], errors: [] });
    expect(posted).toHaveLength(1);
    expect(posted[0]?.n).toBe(29);
    expect(posted[0]?.body.startsWith(`${HEADER}\n`)).toBe(true);
    expect(posted[0]?.body).toContain(`- 甲${findingMarker('ref:a')}`);
    expect(posted[0]?.body).toContain(`- 乙${findingMarker('ref:b')}`);
  });

  it('【故意造出的失败】读留言失败：记进 errors，不当成留过了', async () => {
    const { gh, posted } = fakeCommenter({}, 29);
    const r = await reportFindings([a, c], gh, HEADER);
    expect(r.errors).toEqual(['#29 上留言没留成（GitHub 回了 502）']);
    expect(r.posted).toEqual([40]);
    expect(posted.map((p) => p.n)).toEqual([40]);
  });

  it('【故意造出的失败】写留言失败：同样记进 errors', async () => {
    const gh: GitHubCommenter = {
      async comments() {
        return [];
      },
      async comment() {
        throw new Error('GitHub 回了 403');
      },
    };
    const r = await reportFindings([a], gh, HEADER);
    expect(r.posted).toEqual([]);
    expect(r.errors).toEqual(['#29 上留言没留成（GitHub 回了 403）']);
  });
});
