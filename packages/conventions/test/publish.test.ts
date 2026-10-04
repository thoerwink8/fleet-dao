import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { classifyPullRequestClosed, RELEASE_BRANCH_RE } from '../src/publish.ts';

describe('classifyPullRequestClosed：release.yml 的入口过滤', () => {
  it('合到 main、head 分支是 release/v<N> → proceed，版本号从分支名里提出来', () => {
    const r = classifyPullRequestClosed({ merged: true, headRef: 'release/v7', baseRef: 'main' });
    expect(r).toEqual({ kind: 'proceed', headBranch: 'release/v7', version: 'v7' });
  });

  it('没合（merged=false）→ noop：发布 PR 关上了不算发一版，不算错', () => {
    const r = classifyPullRequestClosed({ merged: false, headRef: 'release/v7', baseRef: 'main' });
    expect(r.kind).toBe('noop');
    if (r.kind === 'noop') expect(r.why).toMatch(/没合/);
  });

  it('普通 feat/… 分支合进 main → noop：不是这条工作流的活，安安静静不动作（第二意见 2026-10-02 不把日常合并当红）', () => {
    const r = classifyPullRequestClosed({ merged: true, headRef: 'feat/fix-something', baseRef: 'main' });
    expect(r.kind).toBe('noop');
    if (r.kind === 'noop') expect(r.why).toMatch(/普通 PR/);
  });

  it('head 是 release/ 但版本号模样不对 → error：想走发布这条线但贴错版本号', () => {
    const r = classifyPullRequestClosed({ merged: true, headRef: 'release/vNext', baseRef: 'main' });
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toMatch(/不是 release\/v<N>/);
  });

  it('base 不是 main（合到了别处）→ error：发布一律合到 main', () => {
    const r = classifyPullRequestClosed({ merged: true, headRef: 'release/v7', baseRef: 'develop' });
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toMatch(/base 不是 main/);
  });

  it('RELEASE_BRANCH_RE 只认刚好 v<数字>：release/v1、release/v123 通；release-v1、release/v1-beta、release/v 不通', () => {
    expect(RELEASE_BRANCH_RE.test('release/v1')).toBe(true);
    expect(RELEASE_BRANCH_RE.test('release/v123')).toBe(true);
    expect(RELEASE_BRANCH_RE.test('release-v1')).toBe(false);
    expect(RELEASE_BRANCH_RE.test('release/v1-beta')).toBe(false);
    expect(RELEASE_BRANCH_RE.test('release/v')).toBe(false);
    expect(RELEASE_BRANCH_RE.test('release/v1/extra')).toBe(false);
  });
});

describe('release.yml 的 job 级 if：只挡 classify 本来就判 noop 的，别的照样起（不遮住 error、不遮住手动补跑）', () => {
  const yml = readFileSync(
    fileURLToPath(new URL('../../../.github/workflows/release.yml', import.meta.url)),
    'utf8',
  );
  const IF =
    "github.event_name != 'pull_request' || (github.event.pull_request.merged == true && startsWith(github.event.pull_request.head.ref, 'release/'))";

  /** finalize job 的 job 级 if；没有就抛（不当成「没限制」）。 */
  function jobIf(text: string): string {
    const at = text.indexOf('\n  finalize:\n');
    if (at < 0) throw new Error('release.yml 里找不到 finalize job：写法换了，这条测试跟着改');
    const m = /^ {4}if: (.+)$/m.exec(text.slice(at));
    if (m === null || (m.index ?? 0) > text.slice(at).indexOf('runs-on:'))
      throw new Error('finalize 没有 job 级 if');
    return (m[1] ?? '').trim();
  }
  /** 把上面那句 if 用 JS 照写一遍（事件名、merged、head.ref 三个输入），和 classify 的结论逐个对。 */
  const runs = (e: { event: string; merged?: boolean; headRef?: string }) =>
    e.event !== 'pull_request' || (e.merged === true && (e.headRef ?? '').startsWith('release/'));

  it('写法就是约定的那一句', () => {
    expect(jobIf(yml)).toBe(IF);
  });

  it('classify 判 noop 的（没合并、普通分支）job 不起；proceed、error（带 release/ 前缀）都起；手动补跑照起', () => {
    for (const merged of [true, false]) {
      for (const headRef of [
        'release/v7',
        'release/vNext',
        'release/',
        'feat/x',
        'fix/release/v1',
        'releases/v1',
      ]) {
        const kind = classifyPullRequestClosed({ merged, headRef, baseRef: 'main' }).kind;
        const start = runs({ event: 'pull_request', merged, headRef });
        // 要起 job 的必须是 classify 不判 noop 的；classify 判 noop 的里，没合并的 release/ 分支也不起（它什么都不动作）
        if (kind !== 'noop') expect(start, `${merged} ${headRef}`).toBe(true);
        if (kind === 'noop' && !merged) expect(start, `${merged} ${headRef}`).toBe(false);
        if (kind === 'noop' && merged) expect(start, `${merged} ${headRef}`).toBe(false);
      }
    }
    expect(runs({ event: 'workflow_dispatch' })).toBe(true);
  });

  it('【故意造出的失败】if 被摘掉、或没有 finalize：抛错，不当成「没限制」；把 startsWith 去掉（普通 PR 也起）和约定的那句对不上', () => {
    expect(() => jobIf(yml.replace(/^ {4}if: .+\n/m, ''))).toThrow('没有 job 级 if');
    expect(() => jobIf(yml.replace('\n  finalize:\n', '\n  finalise:\n'))).toThrow('找不到 finalize');
    const loosened = yml.replace(" && startsWith(github.event.pull_request.head.ref, 'release/')", '');
    expect(loosened).not.toBe(yml);
    expect(jobIf(loosened)).not.toBe(IF);
  });
});
