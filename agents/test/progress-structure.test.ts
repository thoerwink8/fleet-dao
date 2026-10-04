// docs/PROGRESS.md 的骨架（#901 瘦身：历史节归档进 docs/archive/，这个文件只留现在状态）。
// 为什么要钉：开会话钩子（agents/hooks/session-start.mjs）只认这个文件里两个标题——「## 生效中的临时调整」的表（到期复查）、
// 「## 创始人引导（待处理）」的条目；标题被改名、被搬进归档页，钩子找不到时是**静默返回空**（等于「没有到期的、没有待办的」），
// 不会红。所以这里把「两节还在原文件、各一个、钩子读得出来」「归档页里没有这两个标题（否则钩子报「不止一张」）」
// 「归档目录和归档页对得上（搬走的节找得到）」钉成测试；每一条都配一条故意造出失败的用例。
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

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
  DIRECTIVE_HEADING: string;
  gitRunner(timeoutMs?: number): Git;
  checkTemporary(cwd: string, git: Git, now?: number): string[];
  checkDirectives(cwd: string, git: Git): string[];
  parseTempTable(text: string, headingLine: number, today: string): { broken?: string; missing?: string[] };
}

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const hook = (await import(pathToFileURL(join(ROOT, 'agents/hooks/session-start.mjs')).href)) as HookLib;

const PROGRESS = 'docs/PROGRESS.md';
const ARCHIVE_DIR = 'docs/archive';
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const archiveFiles = () =>
  readdirSync(join(ROOT, ARCHIVE_DIR))
    .filter((f) => f.endsWith('.md'))
    .sort();
const archives = () => Object.fromEntries(archiveFiles().map((f) => [f, read(`${ARCHIVE_DIR}/${f}`)]));

const countLine = (text: string, line: string) => text.split('\n').filter((l) => l.trimEnd() === line).length;
/** 归档页里的节标题（`## ` 开头），不含标题前缀 */
const archivedHeadings = (arch: Record<string, string>) =>
  Object.entries(arch)
    .filter(([f]) => /^progress-2026-\d\d-\d\d\.md$/.test(f))
    .flatMap(([f, t]) =>
      t
        .split('\n')
        .filter((l) => l.startsWith('## '))
        .map((l) => ({ file: f, title: l.slice(3).trimEnd() })),
    );

/** 返回这份进度文件和归档页对不上的地方；空数组 = 骨架没坏 */
function problems(progress: string, arch: Record<string, string>): string[] {
  const out: string[] = [];
  for (const h of [hook.TEMP_HEADING, hook.DIRECTIVE_HEADING]) {
    const n = countLine(progress, h);
    if (n !== 1) out.push(`${PROGRESS} 里「${h}」出现 ${n} 次，要正好 1 次（开会话钩子读它）`);
  }
  const lines = progress.split('\n');
  const at = lines.findIndex((l) => l.trimEnd() === hook.TEMP_HEADING);
  if (at >= 0) {
    const r = hook.parseTempTable(progress, at + 1, '2026-01-01');
    if (r.broken) out.push(`临时调整表认不出：${r.broken}`);
  }
  const firstH2 = lines.find((l) => l.startsWith('## '));
  if (!firstH2?.startsWith('## 现在状态'))
    out.push(`${PROGRESS} 的第一个「## 」节要是「现在状态」索引，现在是「${firstH2 ?? '没有'}」`);
  for (const [f, t] of Object.entries(arch)) {
    for (const h of [hook.TEMP_HEADING, hook.DIRECTIVE_HEADING])
      if (countLine(t, h) > 0)
        out.push(`${ARCHIVE_DIR}/${f} 里有「${h}」：钩子会当成第二张表 / 第二个引导节`);
    if (!progress.includes(`docs/archive/${f}`)) out.push(`${PROGRESS} 的归档目录没列 ${ARCHIVE_DIR}/${f}`);
  }
  const catalog = new Set(
    progress
      .split('\n')
      .filter((l) => l.startsWith('- '))
      .map((l) => l.slice(2).trimEnd()),
  );
  const archived = archivedHeadings(arch);
  for (const { file, title } of archived)
    if (!catalog.has(title)) out.push(`归档目录里找不到 ${file} 的节「${title}」`);
  const titles = new Set(archived.map((a) => a.title));
  const afterCatalog = progress.split('\n## 归档目录')[1];
  if (afterCatalog === undefined) out.push(`${PROGRESS} 没有「## 归档目录」一节`);
  else
    for (const l of afterCatalog.split('\n'))
      if (l.startsWith('- ') && /^- 20\d\d-\d\d-\d\d/.test(l) && !titles.has(l.slice(2).trimEnd()))
        out.push(`归档目录列了「${l.slice(2).trimEnd()}」，但归档页里没有这一节`);
  return out;
}

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const g = (cwd: string, ...a: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();

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

describe('docs/PROGRESS.md 骨架：钩子读的两节还在、归档对得上', () => {
  const progress = read(PROGRESS);
  const arch = archives();

  it('真文件没问题', () => {
    expect(problems(progress, arch)).toEqual([]);
  });

  it('归档页真有东西（不是空目录蒙混）：至少四页按日期、一页已处理的引导', () => {
    expect(
      archiveFiles().filter((f) => /^progress-2026-\d\d-\d\d\.md$/.test(f)).length,
    ).toBeGreaterThanOrEqual(4);
    expect(archiveFiles()).toContain('progress-inbox-2026-10.md');
    expect(archivedHeadings(arch).length).toBeGreaterThanOrEqual(30);
  });

  it(
    '开会话钩子对真文件读得出来：临时调整表认得出、引导节认得出（用真 git grep，不是只看文字）',
    () => {
      const repo = repoWith(progress, arch);
      const temp = hook.checkTemporary(repo, GIT, NOW);
      expect(temp.filter((l) => /没查成|不止一张|缺列|认不出/.test(l))).toEqual([]);
      const dir = hook.checkDirectives(repo, GIT);
      expect(dir.filter((l) => /没查成/.test(l))).toEqual([]);
      // 引导节真被钩子读到了：有没标「已处理」的条时它会报条数，位置在 docs/PROGRESS.md
      expect(dir.join('\n')).toMatch(/创始人引导还有 \d+ 条没处理（docs\/PROGRESS\.md:\d+）/);
    },
    SLOW,
  );

  it(
    '【故意造出失败】标题改名、被搬走、搬进归档页都被拦住（钩子自己遇到这些只会静默返回空）',
    () => {
      const renamed = progress.replace(hook.TEMP_HEADING, '## 临时调整（改过名）');
      expect(problems(renamed, arch).join('\n')).toMatch(/「## 生效中的临时调整」出现 0 次/);
      // 钩子对改名的文件确实静默：这正是要靠这条测试兜的原因
      expect(hook.checkTemporary(repoWith(renamed, arch), GIT, NOW)).toEqual([]);

      const noInbox = progress.replace(hook.DIRECTIVE_HEADING, '## 创始人引导');
      expect(problems(noInbox, arch).join('\n')).toMatch(/「## 创始人引导（待处理）」出现 0 次/);

      const twice = {
        ...arch,
        'progress-2026-10-01.md': `${arch['progress-2026-10-01.md']}\n${hook.TEMP_HEADING}\n`,
      };
      expect(problems(progress, twice).join('\n')).toMatch(
        /progress-2026-10-01\.md 里有「## 生效中的临时调整」/,
      );
      expect(hook.checkTemporary(repoWith(progress, twice), GIT, NOW).join('\n')).toMatch(/不止一张/);

      const inboxMoved = {
        ...arch,
        'progress-2026-10-03.md': `${arch['progress-2026-10-03.md']}\n${hook.DIRECTIVE_HEADING}\n`,
      };
      expect(problems(progress, inboxMoved).join('\n')).toMatch(/第二个引导节/);
    },
    SLOW,
  );

  it('【故意造出失败】临时调整表坏了（少了分隔行）、索引不在第一节、归档目录漏列或多列都被拦住', () => {
    const sep = progress.replace(/\n\|---\|---\|---\|---\|---\|/, '');
    expect(problems(sep, arch).join('\n')).toMatch(/临时调整表认不出/);

    const noIndex = progress.replace('## 现在状态', '## 别的');
    expect(problems(noIndex, arch).join('\n')).toMatch(/第一个「## 」节要是「现在状态」/);

    const first = archivedHeadings(arch)[0];
    if (!first) throw new Error('归档页里一个节标题都没有');
    const dropped = progress.replace(`- ${first.title}\n`, '');
    expect(problems(dropped, arch).join('\n')).toContain(
      `归档目录里找不到 ${first.file} 的节「${first.title}」`,
    );

    const ghost = `${progress.trimEnd()}\n- 2026-01-01 不存在的节\n`;
    expect(problems(ghost, arch).join('\n')).toMatch(/归档页里没有这一节/);

    const unlisted = { ...arch, 'progress-2026-12-31.md': '# x\n\n## 2026-12-31 新页\n' };
    expect(problems(progress, unlisted).join('\n')).toMatch(
      /归档目录没列 docs\/archive\/progress-2026-12-31\.md/,
    );
  });
});
