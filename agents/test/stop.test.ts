// Stop 钩子（agents/hooks/stop.mjs）：会话收尾时仓根有没有没跟踪、没被忽略、看着像临时文件的，提醒「挪进 _tmp/」。
// 真 git（临时目录里真 init 一个仓），不拿假字符串顶 git 的输出——untracked-files 的收纳规则（目录收成一条、忽略的不出现）
// 是 git 自己的行为，拿假输出测只会测出「我以为 git 会这样」。命令行外壳、「决不拦不接着聊」由
// agents/test/rules/stop.rules.test.ts 钉住；这里测的是纯逻辑。
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: (Error & { code?: string }) | undefined;
}
type Git = (cwd: string, args: string[]) => Result;
interface HookLib {
  gitRunner(timeoutMs?: number): Git;
  repoRoot(cwd: string, git: Git): string | null;
  tempFilesAtRoot(root: string, git: Git): string[] | null;
  stopCheck(o: { cwd: string; git: Git }): { systemMessage: string } | null;
  pickCwd(input: unknown): string;
}

const HOOK = fileURLToPath(new URL('../hooks/stop.mjs', import.meta.url));
const hook = (await import(pathToFileURL(HOOK).href)) as HookLib;

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `stop-hook-${name}-`));
  made.push(dir);
  return dir;
}

const g = (cwd: string, ...a: string[]) =>
  execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** 真 git 仓：不用提交——git status、rev-parse --show-toplevel 在 init 完就能用 */
function repo(): string {
  const dir = temp('repo');
  g(dir, 'init', '-q', '-b', 'main');
  return dir;
}

/** win32 上路径不分大小写，盘符大小写、8.3 短名都可能和 mkdtempSync 给的原样不同 */
const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);

describe('repoRoot', () => {
  it('真仓：给根目录，也给它下面的子目录，都能查到根', () => {
    const dir = repo();
    mkdirSync(join(dir, 'sub'));
    const git = hook.gitRunner();
    const fromRoot = hook.repoRoot(dir, git);
    const fromSub = hook.repoRoot(join(dir, 'sub'), git);
    expect(fromRoot).not.toBeNull();
    expect(norm(fromSub as string)).toBe(norm(fromRoot as string));
  });

  it('不是 git 仓：返回 null，不当错误抛出来', () => {
    const dir = temp('not-a-repo');
    expect(hook.repoRoot(dir, hook.gitRunner())).toBeNull();
  });

  it('目录本身不存在：查不成，返回 null', () => {
    const dir = join(temp('gone'), 'nope');
    expect(hook.repoRoot(dir, hook.gitRunner())).toBeNull();
  });
});

describe('tempFilesAtRoot', () => {
  it('仓根的截图、导出、日志：没跟踪的都报出来', () => {
    const dir = repo();
    writeFileSync(join(dir, 'shot.png'), 'x');
    writeFileSync(join(dir, 'export.json'), '{}');
    writeFileSync(join(dir, 'run.log'), 'x');
    writeFileSync(join(dir, 'notes.txt'), 'x');
    const names = hook.tempFilesAtRoot(dir, hook.gitRunner());
    expect(names?.sort()).toEqual(['export.json', 'notes.txt', 'run.log', 'shot.png']);
  });

  it('已经跟踪的（提交过、或已 git add）不报：不是「没跟踪」', () => {
    const dir = repo();
    writeFileSync(join(dir, 'tracked.png'), 'x');
    g(dir, 'add', 'tracked.png');
    expect(hook.tempFilesAtRoot(dir, hook.gitRunner())).toEqual([]);
  });

  it('被 .gitignore 忽略的不报：仓根这条规矩本来就是靠 .gitignore 兜底', () => {
    const dir = repo();
    writeFileSync(join(dir, '.gitignore'), '*.png\n');
    writeFileSync(join(dir, 'shot.png'), 'x');
    writeFileSync(join(dir, 'export.json'), '{}');
    expect(hook.tempFilesAtRoot(dir, hook.gitRunner())).toEqual(['export.json']);
  });

  it('子目录里的不报：只看仓根这一层，不进 _tmp/ 之外的目录深挖', () => {
    const dir = repo();
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'deep.png'), 'x');
    expect(hook.tempFilesAtRoot(dir, hook.gitRunner())).toEqual([]);
  });

  it('未跟踪的目录被 git 收成一条「dirname/」：带斜杠的那条不当文件报出来', () => {
    const dir = repo();
    mkdirSync(join(dir, 'newdir'));
    writeFileSync(join(dir, 'newdir', 'x.png'), 'x');
    // newdir 本身未跟踪，git status 只给「?? newdir/」一条，不会展开成里面的文件
    expect(hook.tempFilesAtRoot(dir, hook.gitRunner())).toEqual([]);
  });

  it('不像临时文件的扩展名（.ts、.md）不报', () => {
    const dir = repo();
    writeFileSync(join(dir, 'notes.md'), 'x');
    writeFileSync(join(dir, 'index.ts'), 'x');
    expect(hook.tempFilesAtRoot(dir, hook.gitRunner())).toEqual([]);
  });

  it('干净的仓：空数组，不是 null（查成了、就是没有，和「没查成」分开）', () => {
    const dir = repo();
    expect(hook.tempFilesAtRoot(dir, hook.gitRunner())).toEqual([]);
  });

  it('故意造出「查不成」：git 命令本身不在，返回 null 而不是假装「没有」', () => {
    const dir = repo();
    writeFileSync(join(dir, 'shot.png'), 'x');
    const brokenGit: Git = () => ({
      status: null,
      stdout: '',
      stderr: '',
      error: new Error('spawn git ENOENT'),
    });
    expect(hook.tempFilesAtRoot(dir, brokenGit)).toBeNull();
  });
});

describe('stopCheck', () => {
  it('有像临时文件的：给 systemMessage，列出文件名（用顿号），不掺别的字段', () => {
    const dir = repo();
    writeFileSync(join(dir, 'a.png'), 'x');
    const out = hook.stopCheck({ cwd: dir, git: hook.gitRunner() });
    expect(out).toEqual({ systemMessage: '挪进 _tmp/：a.png' });
  });

  it('仓根干净：null，不提醒', () => {
    const dir = repo();
    expect(hook.stopCheck({ cwd: dir, git: hook.gitRunner() })).toBeNull();
  });

  it('不是 git 仓：null，不提醒（不是「干净」，是「不适用」，结果一样但缘由不同）', () => {
    const dir = temp('plain');
    expect(hook.stopCheck({ cwd: dir, git: hook.gitRunner() })).toBeNull();
  });

  it('故意造出「查不成」：git status 那步失败，也是 null，不把「查不成」误报成「有问题」', () => {
    const dir = repo();
    const git: Git = (_cwd, args) =>
      args[0] === 'rev-parse'
        ? { status: 0, stdout: `${dir}\n`, stderr: '', error: undefined }
        : { status: 1, stdout: '', stderr: 'fatal: boom', error: undefined };
    expect(hook.stopCheck({ cwd: dir, git })).toBeNull();
  });
});

describe('pickCwd', () => {
  it('输入里有 cwd 就用它', () => {
    expect(hook.pickCwd({ cwd: '/somewhere' })).toBe('/somewhere');
  });

  it('没有、或不是字符串：退回钩子自己的工作目录', () => {
    expect(hook.pickCwd({})).toBe(process.cwd());
    expect(hook.pickCwd({ cwd: 123 })).toBe(process.cwd());
    expect(hook.pickCwd(null)).toBe(process.cwd());
  });
});
