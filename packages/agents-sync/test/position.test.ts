// 同步位置：记下这台同步到哪个提交（~/.fleet-dao/synced.json），--check 按本机的 origin/main 算落后几个。
// 真 git：假仓提交一次，建个裸仓当 origin。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyPosition, checkPosition, readPosition, samePath } from '../src/position.ts';
import { line } from '../src/report.ts';
import { cleanup, expectKind, git, gitify, makeRepo, PLATFORM, pushAhead, put, tempDir } from './helpers.ts';

afterEach(cleanup);

const KEY = '~/.fleet-dao/synced.json';
const NOW = new Date('2026-09-26T08:00:00Z');
const LATER = new Date('2026-09-26T09:00:00Z');
/** 每条都要起不少次 git，Windows 上一条要几秒 */
const SLOW = { timeout: 60_000 };

function setup() {
  const repo = makeRepo({});
  const origin = gitify(repo);
  const home = tempDir('home');
  const read = () => readPosition(repo, home, PLATFORM);
  const record = () => JSON.parse(readFileSync(join(home, '.fleet-dao', 'synced.json'), 'utf8'));
  return { repo, origin, home, read, record, head: () => git(repo, 'rev-parse', 'HEAD') };
}

describe('同步位置', SLOW, () => {
  it('不是 git 检出：不记、不查，写明为什么（不算错）', () => {
    const home = tempDir('home');
    const pos = readPosition(makeRepo({}), home, PLATFORM);
    expectKind(checkPosition(pos), KEY, 'skip');
    expectKind(applyPosition(pos, [], NOW), KEY, 'skip');
    expect(existsSync(join(home, '.fleet-dao', 'synced.json'))).toBe(false);
  });

  it('从检出同步成功：记下检出和提交；再写零改动；查判主线最新', () => {
    const s = setup();
    const first = applyPosition(s.read(), [], NOW);
    expectKind(first, KEY, 'changed');
    expect(first[0]?.text).toContain(`这台同步到 ${s.head().slice(0, 7)}，就是主线最新`);
    const rec = s.record();
    expect(samePath(rec.repo, s.repo, PLATFORM)).toBe(true);
    expect(rec.synced).toEqual({ commit: s.head(), dirty: false, at: NOW.toISOString() });
    const text = readFileSync(join(s.home, '.fleet-dao', 'synced.json'), 'utf8');
    expectKind(applyPosition(s.read(), [], LATER), KEY, 'ok');
    expect(readFileSync(join(s.home, '.fleet-dao', 'synced.json'), 'utf8')).toBe(text);
    const checked = checkPosition(s.read());
    expectKind(checked, KEY, 'ok');
    expect(checked[0]?.text).toContain('就是主线最新');
  });

  it('还没记过：查判缺失', () => {
    const s = setup();
    expectKind(checkPosition(s.read()), KEY, 'missing');
  });

  it('主线往前走了：查判落后几个；从落后的检出写，另报一行检出本身落后', () => {
    const s = setup();
    applyPosition(s.read(), [], NOW);
    pushAhead(s.origin, 'AGENTS.md', '# 新的规矩\n');
    // 还没取远端：本机不知道主线走了，照实按本机上次取到的算
    expectKind(checkPosition(s.read()), KEY, 'ok');
    git(s.repo, 'fetch', '-q', 'origin');
    const checked = checkPosition(s.read());
    expectKind(checked, KEY, 'drift');
    expect(checked[0]?.text).toContain('落后主线 1 个提交');
    const applied = applyPosition(s.read(), [], LATER);
    expectKind(applied, KEY, 'ok');
    expectKind(applied, `${KEY}#主线`, 'drift');
    expect(applied.find((l) => l.key === `${KEY}#主线`)?.text).toContain('先把检出更新到主线');
  });

  it('这次有没做成、没查成的：同步到的提交不记（留着上次的），检出照记', () => {
    const s = setup();
    applyPosition(s.read(), [], NOW);
    const before = s.record().synced;
    put(s.repo, 'agents/skills/x/SKILL.md', '新 skill\n');
    git(s.repo, 'add', '-A');
    git(s.repo, 'commit', '-q', '-m', '新 skill');
    const lines = applyPosition(s.read(), [line('failed', '~/.codex/AGENTS.md', '没做成——EACCES')], LATER);
    expect(lines[0]?.text).toContain('同步到的提交不记');
    expect(s.record().synced).toEqual(before);
    applyPosition(s.read(), [line('unknown', '~/.claude/skills', '没查成——EIO')], LATER);
    expect(s.record().synced).toEqual(before);
  });

  it('记录坏了：查判没查成；写的时候重写', () => {
    const s = setup();
    put(s.home, '.fleet-dao/synced.json', '{ 坏了');
    expectKind(checkPosition(s.read()), KEY, 'unknown');
    const lines = applyPosition(s.read(), [], NOW);
    expectKind(lines, KEY, 'changed');
    expect(lines[0]?.text).toContain('原来那份记录不是 JSON，重写了');
    expectKind(checkPosition(s.read()), KEY, 'ok');
  });

  it('从没合进主线的分支同步：记下，但判它不在主线上', () => {
    const s = setup();
    git(s.repo, 'checkout', '-q', '-b', 'feature');
    put(s.repo, 'AGENTS.md', '分支上的规矩\n');
    git(s.repo, 'commit', '-q', '-am', '分支');
    const applied = applyPosition(s.read(), [], NOW);
    expect(applied.find((l) => l.key === `${KEY}#主线`)?.text).toContain('不在主线上');
    const checked = checkPosition(s.read());
    expectKind(checked, KEY, 'drift');
    expect(checked[0]?.text).toContain('不在主线上（带着没合进主线的改动）');
  });

  it('从工作树同步：记的是主工作树（开会话钩子要在那里快进）', () => {
    const s = setup();
    const tree = join(tempDir('wt'), 'tree');
    git(s.repo, 'worktree', 'add', '-q', '-b', 'w', tree);
    const pos = readPosition(tree, s.home, PLATFORM);
    applyPosition(pos, [], NOW);
    expect(samePath(s.record().repo, s.repo, PLATFORM)).toBe(true);
  });

  it('没有 origin/main：落后几个查不了，报没查成', () => {
    const s = setup();
    applyPosition(s.read(), [], NOW);
    git(s.repo, 'remote', 'remove', 'origin');
    const checked = checkPosition(s.read());
    expectKind(checked, KEY, 'unknown');
    expect(checked[0]?.text).toContain('仓里没有 origin/main');
  });
});
