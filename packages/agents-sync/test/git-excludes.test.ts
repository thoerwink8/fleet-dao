// 全局 git 忽略（src/git-excludes.ts）：把 _tmp/ 加进这台的 core.excludesFile。真 git（假家目录，--file 指定死，
// 不碰真机器的 ~/.gitconfig——这也是本模块自己要保证的事，这里顺带验一遍：传假的 ctx.home，读写都只发生在那下面）。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Backups } from '../src/backup.ts';
import { applyGitExcludes, checkGitExcludes, readExcludesFile, WANT } from '../src/git-excludes.ts';
import { cleanup, ctxFor, PLATFORM, tempDir } from './helpers.ts';

afterEach(cleanup);
// 每条测试至少真 spawn 一次 git（有的两三次：写、再读、再查）；默认 5 秒在这台机器同时跑很多会话时不够，
// 和 cli.test.ts 里「检出落后主线」那条一样，重 git 操作的测试都给足一点
vi.setConfig({ testTimeout: 15_000 });

const NOW = new Date('2026-09-27T06:00:00Z');
const CONFIG_KEY = '~/.gitconfig#core.excludesFile';

function machine() {
  const home = tempDir('home');
  mkdirSync(home, { recursive: true });
  const ctx = ctxFor(home, ['claude']);
  return {
    home,
    ctx,
    check: () => checkGitExcludes(ctx),
    apply: () => applyGitExcludes(ctx, new Backups(home, PLATFORM, NOW)),
    gitconfig: () => join(home, '.gitconfig'),
  };
}

function kindOf(lines: readonly { kind: string; key: string }[], key: string): string[] {
  return lines.filter((l) => l.key === key).map((l) => l.kind);
}

/** 直接用真 git 写一份 .gitconfig，不经过本模块——用来搭「用户已经设过」的场景 */
function seedGitconfig(home: string, body: string): void {
  writeFileSync(join(home, '.gitconfig'), body);
}

describe('全新机器：没有 .gitconfig', () => {
  it('查：缺失；写：新建 ~/.fleet-dao/gitignore_global，core.excludesFile 指过去；再查一致、再写零改动', () => {
    const m = machine();
    expect(kindOf(m.check(), CONFIG_KEY)).toEqual(['missing']);
    const lines = m.apply();
    expect(kindOf(lines, CONFIG_KEY)).toEqual(['changed']);
    const excludesPath = join(m.home, '.fleet-dao', 'gitignore_global');
    expect(kindOf(lines, '~/.fleet-dao/gitignore_global')).toEqual(['changed']);
    expect(readFileSync(excludesPath, 'utf8')).toBe(`${WANT}\n`);
    const read = readExcludesFile(m.home);
    expect(read).toEqual({ kind: 'set', value: excludesPath });
    expect(kindOf(m.check(), '~/.fleet-dao/gitignore_global')).toEqual(['ok']);
    expect(m.apply().filter((l) => l.kind === 'changed')).toEqual([]);
  });
});

describe('已经有 .gitconfig，但没设过 core.excludesFile', () => {
  it('别的设置（user.name 之类）原样留着，只加 core.excludesFile 这一项', () => {
    const m = machine();
    seedGitconfig(m.home, '[user]\n\tname = t\n\temail = t@example.invalid\n');
    expect(kindOf(m.check(), CONFIG_KEY)).toEqual(['missing']);
    m.apply();
    const text = readFileSync(m.gitconfig(), 'utf8');
    expect(text).toContain('name = t');
    expect(text).toContain('excludesFile');
  });
});

describe('core.excludesFile 已经指到用户自己的文件', () => {
  const KEY = '~/my-global-ignore';

  it('那份文件已经有内容：追加受管块，原有的忽略规则一行不动，不改 core.excludesFile 指到哪', () => {
    const m = machine();
    const mine = join(m.home, 'my-global-ignore');
    writeFileSync(mine, 'node_modules/\n.DS_Store\n');
    execFileSync('git', ['config', '--file', m.gitconfig(), 'core.excludesFile', mine]);
    expect(kindOf(m.check(), KEY)).toEqual(['missing']);
    const lines = m.apply();
    // core.excludesFile 这一项没变，不该出现在这次改动里
    expect(kindOf(lines, CONFIG_KEY)).toEqual([]);
    expect(kindOf(lines, KEY)).toEqual(['changed']);
    const text = readFileSync(mine, 'utf8');
    expect(text.startsWith('node_modules/\n.DS_Store\n')).toBe(true);
    expect(text).toContain('_tmp/');
    expect(kindOf(m.check(), KEY)).toEqual(['ok']);
  });

  it('那份文件已经有受管块、内容却不对（被人手改过）：查判漂移，写只换那一块、备份原文件', () => {
    const m = machine();
    const mine = join(m.home, 'my-global-ignore');
    writeFileSync(mine, `before\n${WANT.replace('_tmp/', '_temp_改过了/')}\nafter\n`);
    execFileSync('git', ['config', '--file', m.gitconfig(), 'core.excludesFile', mine]);
    expect(kindOf(m.check(), KEY)).toEqual(['drift']);
    expect(m.check().find((l) => l.key === KEY)?.text).toContain('漂移');
    const lines = m.apply();
    expect(kindOf(lines, KEY)).toEqual(['changed']);
    const text = readFileSync(mine, 'utf8');
    expect(text).toBe(`before\n${WANT}\nafter\n`);
    expect(kindOf(m.check(), KEY)).toEqual(['ok']);
  });

  it('core.excludesFile 指到的文件不存在（悬空指针）：查判缺失，写照原路径建出来，不改指到哪', () => {
    const m = machine();
    const mine = join(m.home, 'gone', 'my-global-ignore');
    // gone/ 目录建出来，但 my-global-ignore 这个文件故意不建：模拟「设过、文件却没了」
    mkdirSync(join(m.home, 'gone'), { recursive: true });
    execFileSync('git', ['config', '--file', m.gitconfig(), 'core.excludesFile', mine]);
    expect(existsSync(mine)).toBe(false);
    expect(kindOf(m.check(), '~/gone/my-global-ignore')).toEqual(['missing']);
    m.apply();
    expect(existsSync(mine)).toBe(true);
    expect(readFileSync(mine, 'utf8')).toBe(`${WANT}\n`);
  });
});

describe('标记本身坏了：不猜，报出来，不动文件', () => {
  const KEY = '~/my-global-ignore';

  it('两个开始标记：查判漂移「标记不成对」，写判没做成、文件不动', () => {
    const m = machine();
    const mine = join(m.home, 'my-global-ignore');
    const begin = WANT.split('\n')[0] as string;
    writeFileSync(mine, `${begin}\n${begin}\n_tmp/\n${WANT.split('\n')[2]}\n`);
    execFileSync('git', ['config', '--file', m.gitconfig(), 'core.excludesFile', mine]);
    const before = readFileSync(mine, 'utf8');
    expect(m.check().find((l) => l.key === KEY)?.text).toContain('标记不成对');
    const lines = m.apply();
    expect(kindOf(lines, KEY)).toEqual(['failed']);
    expect(readFileSync(mine, 'utf8')).toBe(before);
  });
});

describe('CRLF 的文件：追加、换行都跟着文件走', () => {
  it('原文件是 \\r\\n，追加的受管块也是 \\r\\n', () => {
    const m = machine();
    const mine = join(m.home, 'my-global-ignore');
    writeFileSync(mine, 'node_modules/\r\n');
    execFileSync('git', ['config', '--file', m.gitconfig(), 'core.excludesFile', mine]);
    m.apply();
    const text = readFileSync(mine, 'utf8');
    expect(text).toContain('\r\n');
    expect(text.split('\n').every((l) => l === '' || !l.endsWith('\r') || text.includes('\r\n'))).toBe(true);
    expect(text.replaceAll('\r\n', '\n')).toBe(`node_modules/\n${WANT}\n`);
  });
});

describe('故意造出「查不成」：.gitconfig 语法本身是坏的', () => {
  it('查：没查成，不当成「没设过」——不能因为读不准就去覆盖用户的选择', () => {
    const m = machine();
    writeFileSync(m.gitconfig(), 'this is not [valid');
    const lines = m.check();
    expect(kindOf(lines, CONFIG_KEY)).toEqual(['unknown']);
  });

  it('写：也是没查成（读不准，不敢动），.gitconfig 一个字不动——和 sync.ts 里「读原目标文件出错」用的是同一个判法', () => {
    const m = machine();
    writeFileSync(m.gitconfig(), 'this is not [valid');
    const before = readFileSync(m.gitconfig(), 'utf8');
    const lines = m.apply();
    expect(kindOf(lines, CONFIG_KEY)).toEqual(['unknown']);
    expect(readFileSync(m.gitconfig(), 'utf8')).toBe(before);
  });
});

describe('readExcludesFile：按 ctx.home 走，不摸真机器', () => {
  it('两台假机器互不影响：各自的 .gitconfig 各自读', () => {
    const a = machine();
    const b = machine();
    execFileSync('git', ['config', '--file', a.gitconfig(), 'core.excludesFile', '/a/only']);
    expect(readExcludesFile(a.home)).toEqual({ kind: 'set', value: '/a/only' });
    expect(readExcludesFile(b.home)).toEqual({ kind: 'unset' });
  });
});
