// 钉住「创始人消息一到就落盘」那条的测试（改标准：改这个文件要创始人同意，packages/conventions/standard-paths.json）。
// 2026-10-04 的断链：创始人问「丢失我的回复，查到原因和解决了没有」。查下来分两种丢法——
// ① 在途丢（主因）：我前台等一次长工具调用时，他的消息只在两次工具调用之间的间隙被送进来，会话一断那条就跟着断；
// ② 到了没落盘：消息到了、那一轮用了，但只活在对话里，被总结/换机器之后接手的新会话看不到。
// 「引导必须落盘」那条（directive-inbox.rules.test.ts）管的是 ② 里 AI 主动记下来的那部分，
// 管不了 ①——AI 根本没见到的那条，谁也没法记。
// 这个钩子（agents/hooks/prompt-log.mjs）堵的就是 ①：消息提交那一刻由钩子自己写进持久文件，不经过模型。
//
// 命令行外壳：真 spawn 这个文件、喂 stdin，看退出码、stdout 和落下来的文件——测的是钩子实际接到
// Claude Code 输入时的样子，不是内部函数（照 stop.rules.test.ts 的做法）。
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runChild } from '../child.ts';

const HOOK = fileURLToPath(new URL('../../hooks/prompt-log.mjs', import.meta.url));
const SRC = readFileSync(HOOK, 'utf8');
// 同步工具的清单按文本核对，不跨包 import（agents 那个 tsconfig 不含 packages/ 下的文件，
// 照 subagent-model.rules.test.ts 读 permissions.json、pretool.rules.test.ts 提 targets.ts 的做法）。
const TARGETS = readFileSync(
  fileURLToPath(new URL('../../../packages/agents-sync/src/targets.ts', import.meta.url)),
  'utf8',
);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prompt-log-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 像 Claude Code 那样喂一条消息进去，收回退出码和 stdout。子进程没跑完（起不来、卡死被杀）runChild 直接抛。 */
function feed(input: string, env: Record<string, string> = {}) {
  const r = runChild(process.execPath, [HOOK], {
    input,
    env: { ...process.env, FLEET_PROMPT_LOG_DIR: dir, FLEET_UNATTENDED_DIR: join(dir, 'unattended'), ...env },
  });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

/** 这次落下来的那些文件里的行。 */
function logged(): string[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  const lines: string[] = [];
  for (const f of files) {
    lines.push(...readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean));
  }
  return lines;
}

/** 取第 n 行解析出来的那条；取不到就当场失败（不拿 undefined 冒充「没有」）。 */
function lineAt(lines: string[], n: number): Record<string, string> {
  const line = lines[n];
  if (line === undefined) throw new Error(`第 ${n} 行不存在，这次一共落了 ${lines.length} 行`);
  return JSON.parse(line);
}

/** 北京时间的今天，形如 2026-10-04（和钩子里算的是同一个东西，独立算一遍核对）。 */
function beijingDay(ms: number) {
  return new Date(ms + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// 同步起子进程：卡死由 runChild 给子进程的上限管，不靠 vitest 的超时（它打断不了同步用例，机器一忙又把慢报成红，#264）
describe('规矩：创始人每条消息一到就落盘（2026-10-04 补）', { timeout: 0 }, () => {
  it('挂在 UserPromptSubmit 上，且在同步工具的清单里', () => {
    // 这一条得在清单里登记，不然本机/别家机器上根本不会装、也就不会触发。
    expect(TARGETS).toMatch(/event:\s*'UserPromptSubmit'[^}]*script:\s*'prompt-log\.mjs'/);
    // UserPromptSubmit 不吃 matcher：登记时不要写 matcher，写了也被忽略，容易让人以为它按工具挑。
    const spec = TARGETS.match(/\{[^}]*script:\s*'prompt-log\.mjs'[^}]*\}/)?.[0] ?? '';
    expect(spec).not.toMatch(/matcher/);
    // 超时按毫秒理解（exe 里 UserPromptSubmit 默认 30000ms）。写 10 就是 10 毫秒，等于钩子从没跑成。
    expect(spec).toMatch(/timeout:\s*30000/);
  });

  it('绝不拦、绝不插话：正常路径 exit 0 且不往 stdout 打东西', () => {
    const got = feed(JSON.stringify({ prompt: '你好', prompt_id: 'p-1', session_id: 's-1' }));
    expect(got.code).toBe(0);
    expect(got.out).toBe('');
    expect(logged()).toHaveLength(1);
  });

  it('源码里不出现会把他刚打的字抹掉的那几种写法', () => {
    // UserPromptSubmit 上 exit 2 / decision:block / 输出 additionalContext，都会把消息从上下文里抹掉，
    // 那等于「防丢的钩子自己制造丢失」。注释里为解释原因提到这些名字不算用过它们。
    const code = SRC.replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/process\.exit\((?!0\))/);
    expect(code).not.toMatch(/decision:\s*['"]block['"]/);
    expect(code).not.toMatch(/additionalContext/);
    expect(code).not.toMatch(/process\.stdout\.write/);
    expect(code).toMatch(/process\.exit\(0\)/);
  });

  it('原文一字不改地存进去（不截断、不改写）', () => {
    const raw = '【引导】丢失我的回复，查到原因和解决了没有'.repeat(50);
    feed(JSON.stringify({ prompt: raw, prompt_id: 'p-len', session_id: 's-1', cwd: 'D:\\frank\\fleet-dao' }));
    const got = lineAt(logged(), 0);
    expect(got.prompt).toBe(raw);
    expect(got.sessionId).toBe('s-1');
    expect(got.promptId).toBe('p-len');
    expect(got.cwd).toBe('D:\\frank\\fleet-dao');
  });

  it('一天一个文件、追加写：同一天两条都在，文件名是北京日期', () => {
    feed(JSON.stringify({ prompt: '第一条', prompt_id: 'p-1' }));
    feed(JSON.stringify({ prompt: '第二条', prompt_id: 'p-2' }));
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    expect(files).toEqual([`${beijingDay(Date.now())}.jsonl`]);
    const lines = logged();
    expect(lines).toHaveLength(2);
    expect(lineAt(lines, 0).prompt).toBe('第一条');
    expect(lineAt(lines, 1).prompt).toBe('第二条');
  });

  it('同一个 prompt_id 再来一次不重复写（钩子被重放、开会话补捞都可能撞上）', () => {
    const one = JSON.stringify({ prompt: '同一条', prompt_id: 'p-x' });
    feed(one);
    const again = feed(one);
    expect(again.code).toBe(0);
    expect(logged()).toHaveLength(1);
  });

  it('【故意造出的失败】入参没有 prompt：不收，也不编一条空的进去', () => {
    const got = feed(JSON.stringify({ session_id: 's-1' }));
    expect(got.code).toBe(0);
    expect(got.out).toBe('');
    expect(logged()).toHaveLength(0);
  });

  it('【故意造出的失败】入参不是 JSON：钩子不抛、不当成成功落盘', () => {
    const got = feed('这不是 JSON{{{');
    expect(got.code).toBe(0);
    expect(got.out).toBe('');
    expect(logged()).toHaveLength(0);
  });

  it('【故意造出的失败】stdin 是空的：照旧 exit 0，不留痕迹', () => {
    const got = feed('');
    expect(got.code).toBe(0);
    expect(logged()).toHaveLength(0);
  });

  it('【故意造出的失败】落盘目录写不进去：照旧 exit 0（兜底不是新的故障点），但确实一条没落', () => {
    // 拿一个「文件」当目录用：mkdirSync 必失败，且是干净失败（不靠 null 字节这种平台不允许的输入）。
    const asFile = join(dir, 'i-am-a-file');
    writeFileSync(asFile, '');
    const got = feed(JSON.stringify({ prompt: '写不进去的', prompt_id: 'p-bad' }), {
      FLEET_PROMPT_LOG_DIR: join(asFile, 'sub'),
    });
    expect(got.code).toBe(0);
    expect(got.out).toBe('');
    expect(logged()).toHaveLength(0);
  });

  it('默认落在 ~/.fleet-dao/prompt-log（不给覆盖变量时）', () => {
    // 只在源码上核对：真跑会往家目录写东西，测试不碰那里。
    expect(SRC).toMatch(/join\(home, '\.fleet-dao', 'prompt-log'\)/);
    expect(SRC).toMatch(/FLEET_PROMPT_LOG_DIR/);
    // 用绝对路径，别跟着钩子的 cwd 走（钩子的 cwd 是用户当时的目录）。
    expect(SRC).toMatch(/homedir\(\)/);
    expect(homedir().length).toBeGreaterThan(0);
  });

  it('【故意造出的失败】把他刚打的字抹掉的那几种写法一旦出现，上面那条会红', () => {
    // 反向验证：把源码换成「exit 2」那版，检查确实认得出来。
    const bad = SRC.replace(/process\.exit\(0\)/, 'process.exit(2)');
    expect(bad).not.toBe(SRC);
    expect(bad).toMatch(/process\.exit\((?!0\))/);
  });
});
