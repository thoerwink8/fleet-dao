// 调工具前钩子（agents/hooks/pretool.mjs）「打印进程命令行」那一段漏掉的写法（#792 的作者发现，2026-10-03）：
// 原来只认 ps、/proc/*/cmdline、wmic process、Win32_Process、挑 CommandLine 那一列；pgrep -a、pstree -a、top -c、
// tasklist /v 一样把别的进程的命令行（里面常有口令，2026-10-02 lark-mcp 的 -s <secret> 就是这么漏的）打进对话，却直接放了过去。
// 规矩本身（打印进程命令行要接 redact-secrets.mjs 才放行）由 agents/test/rules/pretool.rules.test.ts 钉着（改它是改标准）；
// 这里只钉「这几种写法也是打印进程命令行」，规矩一条不动。下面每条「拦」的用例在修之前都是退出码 0（故意造出的失败）。
// 命令字符串拆开拼：免得跑这条测试的命令、或者有人 grep 它时，本机的护栏把自己拦下。
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

interface Verdict {
  code: number;
  message?: string;
}
interface HookLib {
  decide(raw: string, fallbackCwd?: string): Verdict;
}

const hook = fileURLToPath(new URL('../hooks/pretool.mjs', import.meta.url));
const lib = (await import(pathToFileURL(hook).href)) as HookLib;

const REDACT = '"$HOME/.fleet-dao/hooks/redact-secrets.mjs"';
const O = '/work/other';
const PG = `pg${'rep'}`;
const PT = `ps${'tree'}`;

/** 拦下时理由里该有什么：打进程命令行（指到 redactor） */
type Why = 'process';
/** [说明, 工具名, 命令, 该给的退出码, 拦下的是哪一类] */
type Case = [string, string, string, 0 | 2, Why?];

function expectVerdict(got: Verdict, want: 0 | 2, why: Why | undefined) {
  expect(got.code).toBe(want);
  if (want === 0) return;
  const first = got.message?.split('\n')[0] ?? '';
  if (why === 'process') {
    expect(first).toContain('进程的命令行');
    expect(got.message).toContain('redact-secrets.mjs');
  }
}

const run = (tool: string, command: string, cwd = O) =>
  lib.decide(JSON.stringify({ tool_name: tool, tool_input: { command }, cwd }));

const cases: Case[] = [
  // —— pgrep：-a / --list-full 打整条命令行；不带它只打 pid，-l 只多一个进程名 ——
  [`${PG} -a`, 'Bash', `${PG} -a node`, 2, 'process'],
  [`${PG} -af（和 -f 连写）`, 'Bash', `${PG} -af lark-mcp`, 2, 'process'],
  [`${PG} -fa（换个顺序）`, 'Bash', `${PG} -fa lark`, 2, 'process'],
  [`${PG} -la（和 -l 连写）`, 'Bash', `${PG} -la node`, 2, 'process'],
  [`${PG} --list-full`, 'Bash', `${PG} --list-full node`, 2, 'process'],
  [`${PG} --list-f（长选项的缩写）`, 'Bash', `${PG} --list-f node`, 2, 'process'],
  [`${PG} -u 用户 -a`, 'Bash', `${PG} -u fleet -a node`, 2, 'process'],
  [`sudo ${PG} -af`, 'Bash', `sudo ${PG} -af fleet-api`, 2, 'process'],
  [`ssh 到别的机器上 ${PG} -af`, 'Bash', `ssh fr "${PG} -af fleet-api"`, 2, 'process'],
  [`wsl 里 ${PG} -af`, 'PowerShell', `wsl -d fleet-local -- ${PG} -af node`, 2, 'process'],
  [`${PG} -af 接 redactor`, 'Bash', `${PG} -af lark | node ${REDACT}`, 0],
  [`${PG} 不带选项只打 pid`, 'Bash', `${PG} node`, 0],
  [`${PG} -f 按整条命令行找、只打 pid`, 'Bash', `${PG} -f lark-mcp`, 0],
  [`${PG} -l 只多打进程名`, 'Bash', `${PG} -l node`, 0],
  [`${PG} -lf 也只打进程名（procps-ng 的 -l 打的是 CMD）`, 'Bash', `${PG} -lf lark-mcp`, 0],
  [`${PG} -c 只数个数`, 'Bash', `${PG} -c node`, 0],
  // 故意造出的失败：-u 的值紧贴着写时，值里的 a 不是 -a（不按 getopt 吃掉值，这条会被误拦）
  [`${PG} -ualice（值紧贴着写）`, 'Bash', `${PG} -ualice node`, 0],
  ['pkill 不打东西', 'Bash', 'pkill -f lark-mcp', 0],

  // —— pstree：-a / --arguments 打每个进程的命令行参数 ——
  [`${PT} -a`, 'Bash', `${PT} -a`, 2, 'process'],
  [`${PT} -ap`, 'Bash', `${PT} -ap`, 2, 'process'],
  [`${PT} -la 某个 pid`, 'Bash', `${PT} -la 1234`, 2, 'process'],
  [`${PT} --arguments`, 'Bash', `${PT} --arguments fleet`, 2, 'process'],
  [`ssh 到别的机器上 ${PT} -ap`, 'Bash', `ssh fr '${PT} -ap'`, 2, 'process'],
  [`${PT} -ap 接 redactor`, 'Bash', `${PT} -ap | node ${REDACT}`, 0],
  [`${PT} 不带选项`, 'Bash', PT, 0],
  [`${PT} -p 只多 pid`, 'Bash', `${PT} -p`, 0],
  [`${PT} -l 只是不截断`, 'Bash', `${PT} -lp 1234`, 0],

  // —— top：-c（--cmdline-toggle）把程序名换成整条命令行 ——
  ['top -b -n 1 -c', 'Bash', 'top -b -n 1 -c', 2, 'process'],
  ['top -bcn1（连写）', 'Bash', 'top -bcn1', 2, 'process'],
  ['top --cmdline-toggle', 'Bash', 'top --cmdline-toggle -b -n 1', 2, 'process'],
  ['ssh 到别的机器上 top -bc', 'Bash', "ssh fr 'top -bc -n 1'", 2, 'process'],
  ['top -bc 接 redactor', 'Bash', `top -bc -n 1 | node ${REDACT}`, 0],
  ['top -b -n 1 只打程序名', 'Bash', 'top -b -n 1', 0],
  ['top -o 的值不是 -c', 'Bash', 'top -b -n 1 -o %CPU', 0],

  // —— tasklist /v：多出的「窗口标题」一列里是 cmd 窗口正在跑的那条命令行 ——
  ['tasklist /v', 'PowerShell', 'tasklist /v', 2, 'process'],
  ['tasklist /fo csv /v', 'PowerShell', 'tasklist /fo csv /v /nh', 2, 'process'],
  ['Git Bash 里 tasklist //v', 'Bash', 'tasklist //v', 2, 'process'],
  ['tasklist -v', 'PowerShell', 'tasklist -v', 2, 'process'],
  ['tasklist /v 接 redactor', 'PowerShell', `tasklist /v | node ${REDACT}`, 0],
  ['tasklist /svc 只多服务名', 'PowerShell', 'tasklist /svc', 0],
];

describe('打印进程命令行：pgrep -a、pstree -a、top -c、tasklist /v 也算，接上 redactor 才放行', () => {
  it.each(cases.map((c) => [c[0], c[1], c[3], c] as const))('%s（%s）→ 退出码 %i', (_n, _t, _w, c) => {
    const [, tool, command, want, why] = c;
    expectVerdict(run(tool, command), want, why);
  });

  it(`拦下 ${PG} -af 时给的配方，照着接一条 redactor 确实放行（配方不是写着好看的）`, () => {
    const blocked = run('Bash', `${PG} -af lark`);
    expect(blocked.code).toBe(2);
    const pipe = /\|\s*(node \S+redact-secrets\.mjs\S*)/.exec(blocked.message ?? '')?.[1];
    expect(pipe).toBeDefined();
    expect(run('Bash', `${PG} -af lark | ${pipe}`).code).toBe(0);
  });
});
