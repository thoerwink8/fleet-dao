// docs/PROGRESS.md 的骨架：进度和创始人引导记在 GitHub 置顶单 #1055，这个文件只剩「生效中的临时调整」表。
// 为什么要钉：开会话钩子（agents/hooks/session-start.mjs）只认这个文件里的「## 生效中的临时调整」标题——标题被改名、
// 被搬进归档页时它是**静默返回空**（等于「没有到期的」），不会红。所以这里把「这一节在原文件、正好一个、表读得出来」
// 「归档页里没有这个标题（否则钩子报「不止一张」）」「旧的引导清单标题不再出现在 PROGRESS 和归档页（引导记在 docs/directives/，两处记会分叉）」
// 「指向进度单的那一行还在」钉成测试；每一条都配一条故意造出失败的用例。
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runChildOk } from './child.ts';

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: (Error & { code?: string }) | undefined;
  timeoutMs?: number;
}
type Git = (cwd: string, args: string[]) => Result;
interface HookLib {
  TEMP_HEADING: string;
  gitRunner(timeoutMs?: number): Git;
  checkTemporary(cwd: string, git: Git, now?: number): string[];
  parseTempTable(text: string, headingLine: number, today: string): { broken?: string; missing?: string[] };
}

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const hook = (await import(pathToFileURL(join(ROOT, 'agents/hooks/session-start.mjs')).href)) as HookLib;
/** 旧的仓内引导清单标题：引导一条一个文件记在 docs/directives/，这个标题不该回来 */
const DIRECTIVE_HEADING = '## 创始人引导（待处理）';

const PROGRESS = 'docs/PROGRESS.md';
const ARCHIVE_DIR = 'docs/archive';
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const archiveFiles = () =>
  readdirSync(join(ROOT, ARCHIVE_DIR))
    .filter((f) => f.endsWith('.md'))
    .sort();
const archives = () => Object.fromEntries(archiveFiles().map((f) => [f, read(`${ARCHIVE_DIR}/${f}`)]));

const countLine = (text: string, line: string) => text.split('\n').filter((l) => l.trimEnd() === line).length;

/** 返回这份进度文件和归档页对不上的地方；空数组 = 骨架没坏 */
function problems(progress: string, arch: Record<string, string>): string[] {
  const out: string[] = [];
  const n = countLine(progress, hook.TEMP_HEADING);
  if (n !== 1) out.push(`${PROGRESS} 里「${hook.TEMP_HEADING}」出现 ${n} 次，要正好 1 次（开会话钩子读它）`);
  const lines = progress.split('\n');
  const at = lines.findIndex((l) => l.trimEnd() === hook.TEMP_HEADING);
  if (at >= 0) {
    const r = hook.parseTempTable(progress, at + 1, '2026-01-01');
    if (r.broken) out.push(`临时调整表认不出：${r.broken}`);
  }
  if (!progress.includes('#1055')) out.push(`${PROGRESS} 里没写进度单 #1055（接手的人找不到进度在哪）`);
  if (countLine(progress, DIRECTIVE_HEADING) > 0)
    out.push(`${PROGRESS} 里又有了「${DIRECTIVE_HEADING}」：引导记在进度单 #1055，不在这里`);
  for (const [f, t] of Object.entries(arch)) {
    if (countLine(t, hook.TEMP_HEADING) > 0)
      out.push(`${ARCHIVE_DIR}/${f} 里有「${hook.TEMP_HEADING}」：钩子会当成第二张表`);
    if (countLine(t, DIRECTIVE_HEADING) > 0)
      out.push(`${ARCHIVE_DIR}/${f} 里有「${DIRECTIVE_HEADING}」：引导记在 docs/directives/，不在这里`);
  }
  return out;
}

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const g = (cwd: string, ...a: string[]) =>
  runChildOk(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a],
    {
      cwd,
    },
  );

/** 把真文件（或改过的版本）放进一个临时 git 仓，让钩子用真 git grep 读 */
function repoWith(progress: string, arch: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'progress-structure-'));
  made.push(dir);
  g(dir, 'init', '-q', '-b', 'main');
  mkdirSync(join(dir, 'docs', 'archive'), { recursive: true });
  writeFileSync(join(dir, PROGRESS), progress);
  for (const [f, t] of Object.entries(arch)) writeFileSync(join(dir, ARCHIVE_DIR, f), t);
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '-m', 'x');
  return dir;
}
const GIT = hook.gitRunner(20_000);
/** 起临时 git 仓、跑钩子的 git grep：Windows 上起一个 git 要几秒，默认 5 秒的超时会误红（同 fresh-main 真进程测试） */
const SLOW = 60_000;
const NOW = Date.parse('2026-10-05T04:00:00Z');

describe('docs/PROGRESS.md 骨架：钩子读的临时调整表还在，进度记在 #1055', () => {
  const progress = read(PROGRESS);
  const arch = archives();

  it('真文件没问题', () => {
    expect(problems(progress, arch)).toEqual([]);
  });

  it(
    '开会话钩子对真文件读得出来：临时调整表认得出（用真 git grep，不是只看文字）',
    () => {
      const repo = repoWith(progress, arch);
      const temp = hook.checkTemporary(repo, GIT, NOW);
      expect(temp.filter((l) => /没查成|不止一张|缺列|认不出/.test(l))).toEqual([]);
    },
    SLOW,
  );

  it(
    '【故意造出失败】标题改名、被搬进归档页、引导节回到仓里、没指向进度单都被拦住',
    () => {
      const renamed = progress.replace(hook.TEMP_HEADING, '## 临时调整（改过名）');
      expect(problems(renamed, arch).join('\n')).toMatch(/「## 生效中的临时调整」出现 0 次/);
      // 钩子对改名的文件确实静默：这正是要靠这条测试兜的原因
      expect(hook.checkTemporary(repoWith(renamed, arch), GIT, NOW)).toEqual([]);

      const twice = {
        ...arch,
        'progress-extra.md': `# 另一页\n\n${hook.TEMP_HEADING}\n`,
      };
      expect(problems(progress, twice).join('\n')).toMatch(/progress-extra\.md 里有「## 生效中的临时调整」/);
      expect(hook.checkTemporary(repoWith(progress, twice), GIT, NOW).join('\n')).toMatch(/不止一张/);

      const inboxBack = `${progress.trimEnd()}\n\n${DIRECTIVE_HEADING}\n\n- x\n`;
      expect(problems(inboxBack, arch).join('\n')).toMatch(/引导记在进度单 #1055，不在这里/);
      const inboxMoved = {
        ...arch,
        'progress-extra.md': `# 另一页\n\n${DIRECTIVE_HEADING}\n`,
      };
      expect(problems(progress, inboxMoved).join('\n')).toMatch(
        /progress-extra\.md 里有「## 创始人引导（待处理）」/,
      );

      expect(problems(progress.replaceAll('#1055', '#0'), arch).join('\n')).toMatch(/没写进度单 #1055/);
    },
    SLOW,
  );

  it('【故意造出失败】临时调整表坏了（少了分隔行）被拦住', () => {
    const sep = progress.replace(/\n\|---\|---\|---\|---\|---\|/, '');
    expect(problems(sep, arch).join('\n')).toMatch(/临时调整表认不出/);
  });
});
