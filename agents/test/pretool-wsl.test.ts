// 调工具前钩子（agents/hooks/pretool.mjs）看不进 wsl 的盲区（#452 建 GitHub App 时发现，2026-10-04）：钩子原来只认得 wsl 这个词，
// 里面的 cat 密钥文件只是碰巧被拦（wsl 不算「不读内容的」），里面无害的 ls、stat 也一起挡掉；打进程命令行（wsl -- ps -ef）、
// 从 /etc 往下搜（wsl -- grep -rn TOKEN /etc）直接放了过去。Windows 那头经 \\wsl$\、\\wsl.localhost\ 读 WSL 里的文件，
// 也认不出那是 /etc/fleet-dao。pwsh 同一类：--command、/c、-cwa、开关写简称（-exec Bypass）时看不进去。
// 拦什么、放什么的规矩由 agents/test/rules/pretool.rules.test.ts 钉着（改它是改标准）；这里只钉「把 wsl、pwsh 这一层剥开，
// 再按那套规矩判里面那条命令」，规矩本身一条不动。
// wsl 怎么交命令是 WSL 2.6.3 上实测的：不写 -e 时（写了 -- 也一样）把后面原样交给 Linux 那头的 bash 重新切一遍，
// 没套引号的 ; 在那头照样把命令分成两条；-e、--shell-type none 不经 shell、原样 exec；头一个词是 ~ 等于 --cd ~。
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

const DAO = `fleet${'-dao'}`;
const ETC = `/etc/${DAO}`;
const KEY = `${ETC}/github/gh-app-x.json`;
const RC = `.recl${'aude'}`;
const SHAPE = '"$HOME/.fleet-dao/hooks/secret-shape.mjs"';
const REDACT = '"$HOME/.fleet-dao/hooks/redact-secrets.mjs"';
const O = '/work/other';
/** Windows 那头看 WSL 里的文件：\\wsl.localhost\<发行版>\…、\\wsl$\<发行版>\…（新旧两种写法） */
const UNC = '\\\\wsl.localhost\\fleet-local';
const UNC_OLD = '\\\\wsl$\\fleet-local';

/** 拦下时理由里该有什么：密钥文件那段（指到 secret-shape.mjs）、看不清的写法、打进程命令行、从上层目录往下搜 */
type Why = 'secret' | 'unclear' | 'process' | 'broad';
/** [说明, 工具名, 命令, 该给的退出码, 拦下的是哪一类] */
type Case = [string, string, string, 0 | 2, Why?];

function expectVerdict(got: Verdict, want: 0 | 2, why: Why | undefined) {
  expect(got.code).toBe(want);
  if (want === 0) return;
  const first = got.message?.split('\n')[0] ?? '';
  if (why === 'secret') expect(first).toContain('secret-shape.mjs');
  if (why === 'unclear') expect(first).toContain('看不清');
  if (why === 'process') expect(first).toContain('进程的命令行');
  if (why === 'broad') expect(first).toContain('往下');
}

const run = (tool: string, command: string, cwd = O) =>
  lib.decide(JSON.stringify({ tool_name: tool, tool_input: { command }, cwd }));

const wslCases: Case[] = [
  // —— 剥开后里面那条命令读密钥文件：拦 ——
  ['wsl -- cat 密钥文件', 'Bash', `wsl -- cat ${KEY}`, 2, 'secret'],
  [
    'PowerShell 里 wsl -d 发行版 -- cat 密钥文件',
    'PowerShell',
    `wsl -d fleet-local -- cat ${KEY}`,
    2,
    'secret',
  ],
  ['wsl bash -c "cat 密钥文件 | base64"', 'Bash', `wsl bash -c "cat ${KEY} | base64"`, 2, 'secret'],
  ["wsl -u root -- sh -c 'cat 密钥文件'", 'Bash', `wsl -u root -- sh -c 'cat ${KEY}'`, 2, 'secret'],
  ['wsl -e 不经 shell 直接 cat', 'Bash', `wsl -e cat ${ETC}/api.env`, 2, 'secret'],
  [
    'wsl --shell-type none 也是直接 exec',
    'PowerShell',
    `wsl --shell-type none -d fleet-local -- jq . ${KEY}`,
    2,
    'secret',
  ],
  ['wsl -- sudo cat', 'Bash', `wsl -d fleet-local -- sudo cat ${ETC}/feishu.env`, 2, 'secret'],
  ['wsl.exe 写全路径', 'PowerShell', 'C:\\Windows\\System32\\wsl.exe -e cat ~/.ssh/id_ed25519', 2, 'secret'],
  ['cmd /c 里再套 wsl', 'Bash', `cmd /c wsl -- cat ${ETC}/api.env`, 2, 'secret'],
  // 故意造出的失败：没套引号的 ; 到 Linux 那头照样把命令分成两条（实测）。把 wsl 当 sudo 那样的前缀剥（后面整串当一条命令的参数），
  // 这条就成了「ls 带了几个参数」被放过去
  [
    '没套引号的 ; 在 Linux 那头分成两条：后一条 cat 照拦',
    'Bash',
    `wsl ls ${ETC} ';' cat ${ETC}/api.env`,
    2,
    'secret',
  ],
  ['PowerShell 里同一写法', 'PowerShell', `wsl ls ${ETC} ';' cat ${ETC}/api.env`, 2, 'secret'],
  // cd 进去再读相对路径：钩子看不清读的是哪个文件（和 cd ~/.reclaude && cat device.json 一样）
  ['wsl --cd 进了放密钥的目录', 'Bash', `wsl --cd ${ETC} -- cat github/gh-app-x.json`, 2, 'unclear'],
  ['wsl --cd 进了放密钥的目录，哪怕只是 ls', 'PowerShell', `wsl --cd ${ETC} -- ls -la`, 2, 'unclear'],
  // —— 剥不开（引号没收尾）：按「看不清的写法」拦 ——
  ['外层的引号没收尾', 'Bash', `wsl -- sh -c 'cat ${ETC}/api.env`, 2, 'unclear'],
  [
    'bash -c 的脚本里引号没收尾：ls 本来放行，看不清就拦',
    'Bash',
    `wsl -- bash -c "ls '${ETC}/github"`,
    2,
    'unclear',
  ],
  ['PowerShell 里同一写法', 'PowerShell', `wsl -- sh -c "ls '${ETC}/github"`, 2, 'unclear'],
  // —— 剥开后是不读内容的：放行（原来整条拦，帮手只好写进脚本绕开） ——
  ['wsl -d 发行版 -u root -- ls -l 密钥目录', 'Bash', `wsl -d fleet-local -u root -- ls -l ${ETC}/github`, 0],
  ['PowerShell 里同一写法', 'PowerShell', `wsl -d fleet-local -u root -- ls -l ${ETC}/github`, 0],
  ["wsl -u root -- sh -c 'ls -la 密钥目录/'", 'Bash', `wsl -u root -- sh -c 'ls -la ${ETC}/github/'`, 0],
  ['wsl -e ls', 'Bash', `wsl -e ls -la ${ETC}`, 0],
  ['wsl -- stat 看权限', 'PowerShell', `wsl -d fleet-local -- stat -c %a ${ETC}/api.env`, 0],
  ['wsl -- test -f 判断在不在', 'Bash', `wsl -- test -f ${KEY} && echo 有`, 0],
  ['wsl -- sha256sum 只出指纹', 'Bash', `wsl -d fleet-local -- sha256sum ${ETC}/github/app.pem`, 0],
  ['wsl -- grep -c 只数个数', 'Bash', `wsl -- grep -c '^GITHUB_APP_ID=' ${ETC}/engine.env`, 0],
  ['wsl 那头的 cat 只交给 Windows 这头的 sha256sum', 'Bash', `wsl -- cat ${ETC}/api.env | sha256sum`, 0],
  ['值经管道交给 wsl 那头的 tee 写进去', 'Bash', `echo 'X=1' | wsl -u root -- tee -a ${ETC}/api.env`, 0],
  ['wsl -- cp 往密钥目录里放（源不是密钥文件）', 'Bash', `wsl -u root -- cp /mnt/c/tmp/app.json ${KEY}`, 0],
  [
    '把查看脚本喂给 wsl 那头的 node',
    'Bash',
    `cat ${SHAPE} | wsl -d fleet-local -- node --input-type=module - ${KEY}`,
    0,
  ],
  [
    'PowerShell 里同一写法',
    'PowerShell',
    `cat ${SHAPE} | wsl -d fleet-local -- node --input-type=module - ${KEY}`,
    0,
  ],
  // 管理分发版、只开 shell 的：不在 Linux 里跑命令，照旧不碰
  ['wsl --list --verbose', 'PowerShell', 'wsl --list --verbose', 0],
  ['wsl --shutdown', 'Bash', 'wsl --shutdown', 0],
  ['wsl -d 发行版（只开 shell）', 'PowerShell', 'wsl -d fleet-local', 0],

  // —— 打进程命令行：剥开后照「不接 redactor 就拦」 ——
  ['wsl -- ps -ef', 'Bash', 'wsl -- ps -ef', 2, 'process'],
  ['wsl -e ps aux', 'PowerShell', 'wsl -d fleet-local -e ps aux', 2, 'process'],
  ['wsl bash -c "ps -ef | grep node"', 'Bash', 'wsl bash -c "ps -ef | grep node"', 2, 'process'],
  ['wsl -- ps -ef 接 Windows 这头的 redactor', 'Bash', `wsl -- ps -ef | node ${REDACT}`, 0],
  [
    'wsl 那头自己接 redactor',
    'Bash',
    'wsl -- sh -c "ps -ef | node /root/.fleet-dao/hooks/redact-secrets.mjs"',
    0,
  ],
  ['wsl -- ps -eo pid,comm 只有程序名', 'Bash', 'wsl -- ps -eo pid,comm', 0],

  // —— 从上层目录往下搜：剥开后照判，--cd、头一个词 ~ 定了从哪搜 ——
  ['wsl -- grep -rn 从 /etc 搜', 'Bash', 'wsl -- grep -rn TOKEN /etc', 2, 'broad'],
  ['wsl --cd ~ 没写起点（从家目录搜）', 'Bash', 'wsl --cd ~ -- grep -rn TOKEN', 2, 'broad'],
  ['wsl 头一个词是 ~ 等于 --cd ~', 'PowerShell', "wsl '~' -d fleet-local -- rg sk-", 2, 'broad'],
  ['wsl -- grep -rl 只列文件名', 'Bash', 'wsl -- grep -rl TOKEN /etc', 0],
  ['wsl -- grep -rn 从代码目录搜', 'Bash', `wsl -- grep -rn x /srv/${DAO}`, 0],
];

describe('wsl：剥开 wsl 自己的选项，里面那条命令按 Linux 那头的 bash 重新切了再判', () => {
  it.each(wslCases.map((c) => [c[0], c[1], c[3], c] as const))('%s（%s）→ 退出码 %i', (_n, _t, _w, c) => {
    const [, tool, command, want, why] = c;
    expectVerdict(run(tool, command), want, why);
  });

  it('拦下密钥文件时给的 WSL 那条明路，照着敲一遍确实放行（配方不是写着好看的）', () => {
    const blocked = run('Bash', `wsl -- cat ${KEY}`);
    expect(blocked.code).toBe(2);
    const recipe = /(cat \S+ \| wsl -d <发行版> -- node --input-type=module - <文件>)/.exec(
      blocked.message ?? '',
    )?.[1];
    expect(recipe).toBeDefined();
    const filled = String(recipe).replace('<发行版>', 'fleet-local').replace('<文件>', KEY);
    expect(filled).toContain('secret-shape.mjs');
    for (const tool of ['Bash', 'PowerShell']) expect([tool, run(tool, filled).code]).toEqual([tool, 0]);
  });
});

const uncCases: Case[] = [
  [
    'Get-Content \\\\wsl.localhost\\…',
    'PowerShell',
    `Get-Content ${UNC}\\etc\\${DAO}\\github\\gh-app-x.json`,
    2,
    'secret',
  ],
  ['Get-Content \\\\wsl$\\…', 'PowerShell', `Get-Content ${UNC_OLD}\\etc\\${DAO}\\api.env`, 2, 'secret'],
  [
    'Git Bash 里 cat //wsl.localhost/…',
    'Bash',
    `cat //wsl.localhost/fleet-local/etc/${DAO}/api.env`,
    2,
    'secret',
  ],
  ['Test-Path 看在不在', 'PowerShell', `Test-Path ${UNC_OLD}\\etc\\${DAO}\\api.env`, 0],
  ['Get-ChildItem 列目录', 'PowerShell', `Get-ChildItem ${UNC}\\etc\\${DAO}\\github`, 0],
  ['读 WSL 里的代码', 'PowerShell', `Get-Content ${UNC}\\srv\\${DAO}\\README.md`, 0],
];

/** [说明, 钩子输入, 该给的退出码, 拦下的是哪一类] */
type ToolCase = [string, Record<string, unknown>, 0 | 2, Why?];
const uncToolCases: ToolCase[] = [
  [
    'Read 读 \\\\wsl.localhost\\… 下的密钥文件',
    { tool_name: 'Read', tool_input: { file_path: `${UNC}\\etc\\${DAO}\\github\\gh-app-x.json` } },
    2,
    'secret',
  ],
  [
    'Read 读 \\\\?\\UNC\\wsl$\\… 写法',
    { tool_name: 'Read', tool_input: { file_path: `\\\\?\\UNC\\wsl$\\fleet-local\\etc\\${DAO}\\api.env` } },
    2,
    'secret',
  ],
  [
    'Grep 从 WSL 的 /etc 往下搜',
    { tool_name: 'Grep', tool_input: { pattern: 'TOKEN', path: `${UNC}\\etc` } },
    2,
    'broad',
  ],
  [
    'Grep 从 WSL 的根往下搜',
    { tool_name: 'Grep', tool_input: { pattern: 'TOKEN', path: UNC_OLD } },
    2,
    'broad',
  ],
  [
    'Read 读 WSL 里的代码',
    { tool_name: 'Read', tool_input: { file_path: `${UNC}\\srv\\${DAO}\\README.md` } },
    0,
  ],
  [
    'Grep 在 WSL 里的代码目录搜',
    { tool_name: 'Grep', tool_input: { pattern: 'x', path: `${UNC}\\srv\\${DAO}` } },
    0,
  ],
];

describe('Windows 那头经 \\\\wsl$\\、\\\\wsl.localhost\\ 碰 WSL 里的文件：去掉这截前缀再认路径', () => {
  it.each(uncCases.map((c) => [c[0], c[1], c[3], c] as const))('%s（%s）→ 退出码 %i', (_n, _t, _w, c) => {
    const [, tool, command, want, why] = c;
    expectVerdict(run(tool, command), want, why);
  });

  it.each(uncToolCases.map((c) => [c[0], c[2], c] as const))('%s → 退出码 %i', (_n, _w, c) => {
    const [, input, want, why] = c;
    expectVerdict(lib.decide(JSON.stringify(input), '/work/repo'), want, why);
  });
});

// pwsh 的开关照 PowerShell 源码（CommandLineParameterParser.cs 的 GetSwitchKey、MatchSwitch）认：前缀 -、--、/、长横线都算，
// 开关名写到「最短能认的那截」以上的任一截都算；-CommandWithArgs 只有紧跟的那个词是命令，后面的是 $args。
const LONG_DASH = '\u2013';
const pwshCases: Case[] = [
  ['pwsh --command（两个横线）', 'Bash', 'pwsh --command "Get-CimInstance Win32_Process"', 2, 'process'],
  ['pwsh /c（斜杠开头的开关）', 'Bash', 'pwsh /c "Get-CimInstance Win32_Process"', 2, 'process'],
  ['powershell /Command', 'PowerShell', 'powershell /Command "Get-CimInstance Win32_Process"', 2, 'process'],
  ['pwsh -cwa（-CommandWithArgs）', 'Bash', 'pwsh -cwa "Get-CimInstance Win32_Process"', 2, 'process'],
  [
    '开关写简称：-exec 是 -ExecutionPolicy，吃掉一个词',
    'Bash',
    'pwsh -exec Bypass -c "Get-CimInstance Win32_Process"',
    2,
    'process',
  ],
  ['-settings 吃掉一个词', 'Bash', 'pwsh -settings x.json -c "Get-CimInstance Win32_Process"', 2, 'process'],
  ['-inp 吃掉一个词', 'PowerShell', "pwsh -inp Text -c 'Get-CimInstance Win32_Process'", 2, 'process'],
  ['长横线开头的开关', 'Bash', `pwsh ${LONG_DASH}c "Get-CimInstance Win32_Process"`, 2, 'process'],
  [
    '原来就认的写法照认',
    'Bash',
    'pwsh -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process"',
    2,
    'process',
  ],
  [
    'powershell 不写开关时整段是命令',
    'PowerShell',
    'powershell "Get-CimInstance Win32_Process"',
    2,
    'process',
  ],
  ['pwsh --command 读密钥文件', 'Bash', `pwsh --command "Get-Content ~/${RC}/device.json"`, 2, 'secret'],
  [
    'pwsh -cwa 把密钥路径当 $args 传进去',
    'Bash',
    `pwsh -cwa 'Get-Content $args[0]' ~/${RC}/device.json`,
    2,
    'secret',
  ],
  // 原来整条拦：pwsh 认不出 /c、-cwa 时只当它是个不读内容的命令名
  ['pwsh /c 里只看在不在', 'Bash', `pwsh /c "Test-Path ~/${RC}/device.json"`, 0],
  ['pwsh -cwa 里只看在不在', 'Bash', `pwsh -cwa 'Test-Path ~/${RC}/device.json'`, 0],
];

describe('pwsh、powershell：开关照它自己的认法剥开，再判 -Command 里那条', () => {
  it.each(pwshCases.map((c) => [c[0], c[1], c[3], c] as const))('%s（%s）→ 退出码 %i', (_n, _t, _w, c) => {
    const [, tool, command, want, why] = c;
    expectVerdict(run(tool, command), want, why);
  });
});
