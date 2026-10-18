// 钉住「对外仓的提交和 PR/MR 不带 AI 署名」（通用段「对外仓和对外内容怎么写」，agents/hooks/ai-attribution.mjs，经 pretool.mjs 的 decide 拦）：
// 对外仓里 git commit 的说明（-m、heredoc、-F 文件）、gh pr / glab mr 的正文带 AI 署名就拦；git push 时要推的提交里带就拦；
// 人名的 Co-Authored-By 放行；自用仓（fleet-dao 靠 Haiku 署名统计、打了自用仓标记的）放行；git 跑不起来放行并说没查成。
// 仓是哪一种的判法本身钉在 agents/test/repo-kind.test.ts。
// 用真的临时 git 仓跑。命令里的 git 子命令拆开拼，免得本机护栏认错。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { runChildOk } from '../child.ts';

interface Verdict {
  code: number;
  message?: string;
  context?: string;
}
interface PretoolLib {
  decide(raw: string, fallbackCwd?: string, opts?: { claudeRunning?: () => number }): Verdict;
}
interface AttrLib {
  hasAiAttribution(text: string): boolean;
  attributionVerdict(
    command: string,
    outer: string,
    cwd: string,
    deps?: {
      git?: (
        dir: string,
        args: string[],
      ) => { status: number | null; stdout: string; stderr: string; error?: Error };
    },
  ): Verdict | null;
}

const HOOKS = fileURLToPath(new URL('../../hooks/', import.meta.url));
const pretool = (await import(pathToFileURL(join(HOOKS, 'pretool.mjs')).href)) as PretoolLib;
const attr = (await import(pathToFileURL(join(HOOKS, 'ai-attribution.mjs')).href)) as AttrLib;

const COMMIT = ['git', 'commit'].join(' ');
const PUSH = ['git', 'push'].join(' ');
const CLAUDE = 'Co-Authored-By: Claude Opus <noreply@anthropic.com>';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]) {
  runChildOk('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
}

/** 一个带一条已推提交的仓（远端是旁边的裸仓）；files 是仓根额外放的文件 */
function repo(files: Record<string, string> = {}): string {
  const base = mkdtempSync(join(tmpdir(), 'ai-attr-'));
  dirs.push(base);
  const remote = join(base, 'remote.git');
  const work = join(base, 'work');
  runChildOk('git', ['init', '-q', '--bare', remote]);
  mkdirSync(work);
  git(work, 'init', '-q');
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(work, rel, '..'), { recursive: true });
    writeFileSync(join(work, rel), text);
  }
  writeFileSync(join(work, 'a.txt'), '1\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', '初始');
  git(work, 'remote', 'add', 'origin', remote);
  git(work, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  return work;
}

function localCommit(work: string, message: string) {
  writeFileSync(join(work, 'a.txt'), `${Math.random()}\n`);
  git(work, 'commit', '-q', '-am', message);
}

const bash = (command: string, cwd: string) =>
  pretool.decide(JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }), cwd, {
    claudeRunning: () => 0,
  });

describe('认 AI 署名', () => {
  it('AI 的 Co-Authored-By、Generated with、🤖 Generated 算；人名的 Co-Authored-By 不算', () => {
    expect(attr.hasAiAttribution(`修 bug\n\n${CLAUDE}`)).toBe(true);
    expect(attr.hasAiAttribution('co-authored-by: GPT-5 <x@openai.com>')).toBe(true);
    expect(attr.hasAiAttribution('🤖 Generated with [Claude Code](https://claude.com/claude-code)')).toBe(
      true,
    );
    expect(attr.hasAiAttribution('Generated with Cursor')).toBe(true);
    expect(attr.hasAiAttribution('修 bug\n\nCo-Authored-By: 张三 <zhang@corp.com>')).toBe(false);
    expect(attr.hasAiAttribution('改了导入页的校验')).toBe(false);
  });
});

describe('对外仓（没有自用仓标记）：带 AI 署名的提交、推送、PR/MR 拦下', () => {
  it('git commit -m 带署名：拦，说明规矩出处', () => {
    const work = repo();
    const v = bash(`${COMMIT} -am "修 bug\n\n${CLAUDE}"`, work);
    expect(v.code).toBe(2);
    expect(v.message).toContain('对外仓和对外内容怎么写');
  });

  it('heredoc 正文里带署名：拦', () => {
    const work = repo();
    const v = bash(`${COMMIT} -F - <<'EOF'\n修 bug\n\n${CLAUDE}\nEOF`, work);
    expect(v.code).toBe(2);
  });

  it('-F 文件里带署名：读文件判，拦', () => {
    const work = repo();
    writeFileSync(join(work, 'msg.txt'), `修 bug\n\n${CLAUDE}\n`);
    expect(bash(`${COMMIT} -F msg.txt`, work).code).toBe(2);
  });

  it('人名的 Co-Authored-By、干净的说明：放行', () => {
    const work = repo();
    expect(bash(`${COMMIT} -am "修 bug\n\nCo-Authored-By: 张三 <z@corp.com>"`, work).code).toBe(0);
    expect(bash(`${COMMIT} -am "修 bug"`, work).code).toBe(0);
  });

  it('git push：要推的提交里有带署名的就拦，列出哪个提交；干净的放行', () => {
    const work = repo();
    localCommit(work, `导入页校验\n\n${CLAUDE}`);
    const v = bash(`${PUSH} origin HEAD`, work);
    expect(v.code).toBe(2);
    expect(v.message).toContain('导入页校验');
    expect(v.message).toContain('rebase');
    const clean = repo();
    localCommit(clean, '导入页校验');
    expect(bash(`${PUSH} origin HEAD`, clean).code).toBe(0);
  });

  it('git -C 路径 push：按 -C 指的仓查', () => {
    const work = repo();
    localCommit(work, `x\n\n${CLAUDE}`);
    expect(bash(`git -C ${work} push origin HEAD`, tmpdir()).code).toBe(2);
  });

  it('gh pr create --body、glab mr create --description 带 Generated with Claude Code：拦', () => {
    const work = repo();
    expect(
      bash(
        'gh pr create --title x --body "改了 x\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)"',
        work,
      ).code,
    ).toBe(2);
    expect(bash('glab mr create --title x --description "Generated with Claude Code"', work).code).toBe(2);
    writeFileSync(join(work, 'body.md'), `改了 x\n\n${CLAUDE}\n`);
    expect(bash('gh pr create --title x --body-file body.md', work).code).toBe(2);
    expect(bash('gh pr create --title x --body "改了 x"', work).code).toBe(0);
  });

  it('命令里别处写到 push、commit 字样不算（grep、echo）', () => {
    const work = repo();
    localCommit(work, `x\n\n${CLAUDE}`);
    expect(bash('grep -rn push src', work).code).toBe(0);
  });
});

describe('自用仓放行：fleet-dao、打了自用仓标记的（旧的私人仓写法照认）', () => {
  it('fleet-dao 形态的仓：带 Claude 署名的提交和推送都放行', () => {
    const work = repo({ 'agents/shared-rules.md': 'x', 'packages/conventions/standard-paths.json': '{}' });
    expect(bash(`${COMMIT} -am "x\n\n${CLAUDE}"`, work).code).toBe(0);
    localCommit(work, `x\n\n${CLAUDE}`);
    expect(bash(`${PUSH} origin HEAD`, work).code).toBe(0);
  });

  it('标了自用仓的、旧写法标了私人仓的：放行', () => {
    for (const mark of ['<!-- repo-kind: 自用仓 -->', '<!-- repo-kind: 私人仓 -->']) {
      const work = repo({ 'AGENTS.md': `# x\n\n${mark}\n` });
      localCommit(work, `x\n\n${CLAUDE}`);
      expect(bash(`${PUSH} origin HEAD`, work).code).toBe(0);
    }
  });
});

describe('没查成不拦', () => {
  it('【故意造出的失败】git 跑不起来：放行，给一句没查成', () => {
    const dead = () => ({
      status: null,
      stdout: '',
      stderr: '',
      error: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }),
    });
    const v = attr.attributionVerdict(`${PUSH} origin HEAD`, `${PUSH} origin HEAD`, tmpdir(), { git: dead });
    expect(v?.code).toBe(0);
    expect(v?.context).toMatch(/没查成/);
  });

  it('不是 git 仓：不管', () => {
    const plain = mkdtempSync(join(tmpdir(), 'ai-attr-plain-'));
    dirs.push(plain);
    expect(bash(`${COMMIT} -m "x\n\n${CLAUDE}"`, plain).code).toBe(0);
  });
});
