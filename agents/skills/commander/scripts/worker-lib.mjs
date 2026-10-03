// 帅位「开别家模型的会话去干活」的启动器（创始人原话：「可以帅位自己干，也可以帅位开新会话去让别的模型干」）。
// worker.mjs 是外壳（真的 git/gh/pnpm/spawn/进程查杀），全部逻辑在这份 worker-lib.mjs（照认领那套 seat-lib.mjs 那种注入 io 的写法；
// 那几份 2026-10-02 随认领账删了，#446）。
// 改这里之前必须知道：
// - 创始人已拍：不给别家模型关目录/沙箱，它能读创始人账号能读的一切——不额外加 --sandbox、不用容器或受限令牌；
//   本文件只解决「无人值守跑得起来」（grok --always-approve、codex --dangerously-bypass-approvals-and-sandbox），
//   不额外收权限，也不额外放权限。
// - kimi 不接 start：`kimi --help` 只有 `-p <prompt>` 内联参数传提示词，没有 stdin、没有 --prompt-file；这台机器上
//   grok/codex/kimi 在 PATH 里解出来的都是 npm 装的 .cmd 套壳（Node 会自动转成 cmd.exe /d /s /c 再传参），brief 原文
//   可能带引号、换行、百分号，走命令行参数拼接在 Windows 上不可靠（cmd.exe 的 %VAR% 展开不因加引号而不展开，
//   09-28 用这几个命令行实测确认）。grok 用 --prompt-file（写文件、传文件路径，路径本身没有特殊字符，安全）；
//   codex exec 不给 PROMPT 位置参数就从标准输入读，用真文件描述符接（stdio[0] 指向 prompt.txt，不用管道）。
//   kimi 这两条都没有，明说「kimi 没有无人值守模式」、不接，不假装能跑。
// - 代理的坑（09-28 实测，细节写在 PR 正文）：这台机器 https_proxy/http_proxy 设着时，本脚本自己调的 git/gh
//   （fetch、worktree、pr list）一律先去掉代理（stripProxy，和帅位交活时手动加的 `env -u` 前缀一个道理，在 worker.mjs
//   里做）；但起的模型命令行要保留代理去连它自己的后端，只另外把 NO_PROXY/no_proxy 加上 github.com、api.github.com、
//   codeload.github.com 三个域名（mergeNoProxy），让它自己跑的 git/gh 走代理之外的路连 GitHub——Go 的 net/http、
//   git 的 libcurl 都认 NO_PROXY。这台机器的沙箱网络只能走代理、没有直连，没法在这台上把 NO_PROXY 对 GitHub 生效
//   完整实测到底（细节写在 PR 正文），只测过它不会误伤模型自己那条到后端的代理路。
// - 进程用 detached + windowsHide + stdio 指向真文件描述符（不是管道）起，spawn 完立刻 unref：这样 `start` 这条命令
//   退出之后子进程照样活着；用文件描述符不用 pipe，是因为 pipe 要父进程留着读写端才不出问题，文件描述符不需要。
// - 状态记在 ~/.fleet-dao/workers/<短名>/（meta.json、out.log、err.log、prompt.txt）：机器本地、不进仓。
// - 思考档位（创始人 2026-09-28 拍）：默认 high，简单活可以 medium，不用 xhigh；--effort 不给就是 high，
//   总是显式传给命令行，不靠模型自己的默认（grok 自己的默认是 xhigh，09-28 冒烟撞过）。grok 传
//   --reasoning-effort <档>；codex 传 -c model_reasoning_effort="<档>"（TOML 字符串，引号是字面量，
//   ~/.codex/config.toml 里本来就有这个键，键名对得上）；kimi 不支持，不传，status 里标「不支持」。
// - --repo 不给默认值就用当前目录（不写死这台机器的主检出路径）：这是公开仓，写死的本机路径会被卫生检查当成
//   「盘符下的个人目录」拦下，AGENTS.md 也不许公开仓里写个人目录路径；帅位平时就在主检出的检出里跑命令，默认当前
//   目录已经够用，--repo 留给不在那跑的场景。
// - 退出码：0 好了；1 用法不对；2 没查成、没做成（读不到、跑不起来）；3 冲突（工作树已经存在、还在跑、PR 没合没关）。
// - 09-28 晚上真活撞出两个坑，都在这份文件里改：
//   1. 【安全，当场修】给模型进程的环境变量必须先过 safeEnv() 这道白名单，不能把 io.env（=真的 process.env）
//      整个透传：worker.mjs 的 spawnDetached 会把 env 写进 launch-spec.json 明文留在磁盘上（起模型的进程要
//      靠这份 JSON 文件把环境变量带过去，见 worker.mjs 文件头），而 io.env 就是跑 worker.mjs 这个会话自己的
//      完整环境，真的撞见过里面带着 GITHUB_PERSONAL_ACCESS_TOKEN、MIRASIM_* 好几个真令牌（09-28 一次真起
//      grok 干活时留下的 launch-spec.json 里现原形，已经把那份文件和另一份冒烟测试留下的都打码删掉了）。
//      grok/codex 自己根本用不上这些——它们要连 GitHub 靠的是 gh 自己存的登录态，不是这个环境变量。
//      safeEnv() 是白名单（不是「挡像密钥的名字」那种黑名单）：以后这台机器环境里随便加一个新变量，默认就是
//      不传，不会因为它的名字「看着不像密钥」就漏出去。
//   2. cmdStart 起模型这步，io.spawnDetached 抛出来的 Error 不一定是「确认起不来」：可能是 Start-Process
//      已经真的起来了、只是没能把 pid 传回来（worker.mjs 那边的坑，细节在那份文件头）。这种情况 Error 上会带
//      err.uncertain = true，cmdStart 要认这个标记：不说「起不了」，把能写的 meta 先写上（pid: null，
//      pidUncertain: true），让 status/stop/clean 之后还找得到这棵工作树，报错里明说
//      「进程可能已经在跑、没记上」。metaProblem/oneStatus/cmdStop/cmdClean 都跟着认 pidUncertain 这个状态。
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

const NAME_RE = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const MODELS = ['grok', 'codex', 'kimi'];
/** 思考档位：不给就是 DEFAULT_EFFORT，总是显式传给模型命令行（创始人 2026-09-28 拍：默认 high，别用 xhigh）。 */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh'];
export const DEFAULT_EFFORT = 'high';
/** 模型自己要连的 GitHub 域名：让它自己跑的 git/gh 绕开代理直连这几个。 */
export const GITHUB_HOSTS = ['github.com', 'api.github.com', 'codeload.github.com'];

export const USAGE = `用法：node worker.mjs <命令> …（在项目仓的检出里跑，或用 --repo 指一个）
  start --model grok|codex|kimi --name <短名> --brief <文件> [--repo <主检出路径>] [--model-id <型号>]
        [--effort low|medium|high|xhigh，不给是 ${DEFAULT_EFFORT}] [--no-ship] [--no-automerge]
                    在主检出的上一级建一棵工作树、起一个别家模型命令行去干活（后台跑，这条命令退出它照跑）
                    --no-automerge：开非草稿 PR 但不挂自动合并，正文「还欠什么」栏写「人闸：改标准」，CI 绿了就停
                    （改标准要创始人点头才能合，见 AGENTS.md「改标准是人闸第四类」）；不给就是本机快马老规矩：
                    CI 绿就合、自动挂上。
  status [--name <短名>]         看工人在跑没跑、跑了多久、最后一句输出、对应的 PR；不带 --name 看全部
  stop --name <短名>             杀掉整棵进程树
  clean --name <短名> [--force]  PR 合了或关了（或带 --force）才删工作树和本地分支，日志留着
退出码：0 好了；1 用法不对；2 没查成、没做成；3 冲突（已经存在、还在跑、PR 没合没关）。`;

class UsageError extends Error {}

const fail = (io, why) => {
  io.err(why);
  return 2;
};
const conflict = (io, why) => {
  io.err(why);
  return 3;
};
const firstLine = (t) =>
  String(t ?? '')
    .trim()
    .split('\n')[0] ?? '';
/** git/gh/pnpm 跑完没成时给人看的一句话：优先标准错误，其次标准输出，都没有就退出码或 spawn 本身的错误。 */
const reasonOf = (r) => firstLine(r.stderr || r.stdout) || (r.error ? String(r.error) : `退出码 ${r.status}`);

// —— 参数 ——

function parseArgs(argv, allowed, flagNames = []) {
  const positional = [];
  const options = new Map();
  const flags = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq < 0 ? undefined : eq);
    if (flagNames.includes(name)) {
      if (eq >= 0) throw new UsageError(`--${name} 不带值`);
      flags.add(name);
      continue;
    }
    if (!allowed.includes(name)) throw new UsageError(`认不出参数 --${name}`);
    const value = eq >= 0 ? arg.slice(eq + 1) : argv[++i];
    if (value === undefined || (eq < 0 && value.startsWith('--')))
      throw new UsageError(`--${name} 后面要跟值`);
    if (options.has(name)) throw new UsageError(`--${name} 给了两次`);
    options.set(name, value);
  }
  return { positional, options, flags };
}

function nameOf(p) {
  const v = p.options.get('name');
  if (!v) throw new UsageError('要带 --name <短名>');
  if (!NAME_RE.test(v))
    throw new UsageError(`短名「${v}」不行：64 字以内，字母或数字开头，只许字母、数字、点、横线、下划线`);
  return v;
}

function modelOf(p) {
  const v = p.options.get('model');
  if (!v) throw new UsageError('要带 --model grok|codex|kimi');
  if (!MODELS.includes(v)) throw new UsageError(`不认识的模型「${v}」：只有 grok、codex、kimi`);
  return v;
}

function effortOf(p) {
  const v = p.options.get('effort');
  if (v === undefined) return DEFAULT_EFFORT;
  if (!EFFORTS.includes(v)) throw new UsageError(`不认识的档位「${v}」：只有 ${EFFORTS.join('、')}`);
  return v;
}

/** 相对路径按 io.cwd() 展开，不用真的 process.cwd()（测试里两者不是一回事）。 */
const resolvePath = (io, p) => (isAbsolute(p) ? p : join(io.cwd(), p));

// —— 传给模型进程的环境变量：白名单 ——

/**
 * 起的模型进程只给这些名字的环境变量（Windows 标准路径类 + Node/pnpm 常用的几个），谁都用得上、谁都不是
 * 密钥。09-28 发现的教训见文件头：这是白名单，不是「挡像密钥的名字」那种黑名单——以后环境里加什么新变量，
 * 默认都不传，要模型真需要了再加名字到这。代理相关的几个（http_proxy 等）单独在 PROXY_ENV_KEYS，因为
 * mergeNoProxy 还要在它们基础上改 NO_PROXY/no_proxy。
 */
export const SAFE_ENV_KEYS = [
  'PATH',
  'Path',
  'PATHEXT',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'HOMEDRIVE',
  'HOMEPATH',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'USERNAME',
  'USERDOMAIN',
  'COMPUTERNAME',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL',
  'PROCESSOR_REVISION',
  'OS',
  'PROGRAMFILES',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'COMMONPROGRAMFILES',
  'CommonProgramFiles(x86)',
  'CommonProgramW6432',
  'ALLUSERSPROFILE',
  'ProgramData',
  'PUBLIC',
  'PSModulePath',
  'PNPM_HOME',
  'NVM_HOME',
  'NVM_SYMLINK',
  'NODE_EXTRA_CA_CERTS',
  'LANG',
  'PYTHONUTF8',
];
const PROXY_ENV_KEYS = ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'no_proxy'];

/** 只挑白名单里有的键，值是 undefined 的也不带（和原来 spawnDetached 里过滤 undefined 的规矩一致）。 */
export function safeEnv(env) {
  const out = {};
  for (const key of [...SAFE_ENV_KEYS, ...PROXY_ENV_KEYS]) {
    if (env[key] !== undefined) out[key] = env[key];
  }
  return out;
}

// —— 代理 ——

/** 保留原有代理不动，只把 NO_PROXY/no_proxy 加上 GITHUB_HOSTS 里没有的几个域名（大小写两份都补，谁都可能只认一种）。 */
export function mergeNoProxy(env) {
  const out = { ...env };
  for (const key of ['NO_PROXY', 'no_proxy']) {
    const existing = String(out[key] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const host of GITHUB_HOSTS) if (!existing.includes(host)) existing.push(host);
    out[key] = existing.join(',');
  }
  return out;
}

// —— 收尾交代 ——

/**
 * noAutomerge（创始人 09-28 晚上拍：改标准的活也要能派给别家模型）：开出来的 PR 不挂自动合并、正文第一行
 * 写「人闸：改标准」，CI 绿了就停手，等创始人自己看了同意——跟 AGENTS.md「改标准是人闸第四类」那条一致，
 * 不能让模型自己挂自动合并把改标准的 PR 合了。跟 noShip 不冲突但没意义一起用（noShip 压根不开 PR），noShip
 * 为真时这条不看。
 */
export function closingBrief({ branch, noShip, noAutomerge }) {
  if (noShip) {
    return [
      '—— 收尾交代 ——',
      '这是冒烟测试：不要 git commit、不要 git push、不要开 PR、不要碰 GitHub。',
      '做完上面的事，最后单独一行只输出：完成',
    ].join('\n');
  }
  const prSteps = noAutomerge
    ? [
        '5. gh pr create（不开草稿）：正文照 .github/pull_request_template.md 的四栏填；「还欠什么」栏写「人闸：改标准」，不再另写档位栏。',
        '6. 不要挂自动合并、不要跑 gh pr merge：这条改的是要创始人拍板的标准，他同意之前不能自己合，合并由',
        '   创始人或帅位在他同意后另外做。',
        '7. gh pr checks <PR 号> --watch 盯到过或红；红了自己改，最多 3 轮；CI 绿了就停下，不用等合并、不用',
        '   等创始人回话。',
      ]
    : [
        '5. gh pr create（不开草稿）：正文照 .github/pull_request_template.md 的四栏填。',
        '6. gh pr merge <PR 号> --auto --squash 挂自动合并。',
        '7. gh pr checks <PR 号> --watch 盯到过或红；红了自己改，最多 3 轮。',
      ];
  return [
    '—— 收尾交代（帅位自动加的，照做；具体要做的活见上面）——',
    '1. 先读仓根的 AGENTS.md，照它的规矩做。这是本机快马：不开单、不写需求文档和结果文档、不认领。',
    '2. 改完依次跑，都要过：',
    '   - pnpm test:changed（它说要全跑、退出码 3：照它打印的命令单独跑对应包的测试，不要在这台机器上跑全量',
    '     pnpm test 或 pnpm check）',
    '   - pnpm format',
    '   - pnpm typecheck',
    '3. 提交信息一句话说清改了什么、为什么。',
    `4. git push -u origin ${branch}`,
    ...prSteps,
    '8. 不开新 issue，不碰这棵工作树以外的目录、不碰别的检出。',
    '9. 如果 git 或 gh 连 GitHub 失败、像是代理问题：命令前加',
    '   env -u https_proxy -u http_proxy -u HTTPS_PROXY -u HTTP_PROXY 再试一次。',
    '10. 最后单独一行输出：完成：PR #<号>；做不下去就输出：卡住：<原因>',
  ].join('\n');
}

// —— 起哪个模型 ——

/**
 * 各模型的无人值守启动方式；kimi 没有可靠的方式，调用方另处理。思考档位总是显式传（不靠模型自己的默认，
 * grok 自己默认 xhigh）：grok 用 --reasoning-effort，codex 用 -c model_reasoning_effort="<档>"（TOML 字符串，
 * 引号是字面量、和 ~/.codex/config.toml 里的键名对得上）。extraEnv 是这个模型必须额外给的环境变量（不从
 * io.env 挑，是我们自己强加的），cmdStart 会把它叠在 safeEnv+mergeNoProxy 算出来的 env 上面。
 *
 * grok 的 --no-plan / GROK_FOLDER_TRUST / GROK_ASK_USER_QUESTION（09-28 晚上另一个会话真机撞出来、这边核实
 * 修的）：我们每个工人都是刚 git worktree add 出来的新目录，grok 认成「没被信任」——这不是权限问题（创始人已经
 * 拍板不给别家模型关目录/沙箱，见文件头），是 grok 自己一个独立的「目录信任」开关：没信任就不自动加载 AGENTS.md、
 * 项目钩子、项目 MCP、项目技能（这几个是绑在一起的一个门，见 ~/.grok/docs/user-guide/10-hooks.md「Trusting a
 * project」），--always-approve 只管工具调用要不要问，管不到这个。另外两张 --always-approve 也管不到的卡片：
 * 反问选择题（ask_user_question 这个工具本身）、进入计划模式要人点头批准（这是模式切换本身要审批，不是普通工具
 * 调用）。`grok --help`（这台装的 1.0.41）里没有 --trust、也没有 --no-ask-user 这两个名字——不是瞎编的，是真
 * 核对过：--trust 在 bundled 文档（~/.grok/docs/user-guide/10-hooks.md、18-sandbox.md 等多处）里确认是真旗标，
 * 只是不出现在 --help 里，而且会把这次信任写进 ~/.grok/trusted_folders.toml 长期攒着（我们每次都是新目录名，
 * 攒了也没用，还占地方）；--no-ask-user 从头到尾没找到，真正的开关是 features.ask_user_question 这个配置键，
 * 环境变量 GROK_ASK_USER_QUESTION（见 ~/.grok/docs/user-guide/26-config-reference.md）。改用等价、不留状态的
 * 环境变量：GROK_FOLDER_TRUST=0 整个关掉目录信任门（AGENTS.md/钩子/MCP/技能一起放行），
 * GROK_ASK_USER_QUESTION=0 关掉反问选择题那个工具。--no-plan 是 --help 里明明白白有的真旗标，直接禁掉整个计划
 * 模式。09-28 用一份带暗号的 AGENTS.md 在全新目录里真跑过对照（prompt 明说「不许主动读文件、只看会话一开始加载
 * 的内容」，避免模型自己主动 read_file 把这条掩盖掉）：不带这三样时 grok 答「NONE」（复现了问题——AGENTS.md
 * 确实没被自动加载），带上之后正确答出暗号（过程和命令见 PR 正文）。codex 没有这个概念，extraEnv 给空对象。
 */
function launchOf(model, { promptFile, worktreeDir, modelId, effort }) {
  if (model === 'grok')
    return {
      command: 'grok',
      args: [
        '--prompt-file',
        promptFile,
        '--always-approve',
        '--cwd',
        worktreeDir,
        '--reasoning-effort',
        effort,
        '--no-plan',
        ...(modelId ? ['--model', modelId] : []),
      ],
      stdinFile: null,
      extraEnv: { GROK_FOLDER_TRUST: '0', GROK_ASK_USER_QUESTION: '0' },
    };
  if (model === 'codex')
    return {
      command: 'codex',
      args: [
        'exec',
        '--dangerously-bypass-approvals-and-sandbox',
        '-C',
        worktreeDir,
        '-c',
        `model_reasoning_effort="${effort}"`,
        ...(modelId ? ['--model', modelId] : []),
      ],
      stdinFile: promptFile,
      extraEnv: {},
    };
  return null;
}

export const KIMI_UNSUPPORTED =
  'kimi 没有无人值守模式：`kimi --help` 只有 -p <prompt> 内联参数传提示词，没有 stdin、也没有 --prompt-file；' +
  '这台机器上 kimi 在 PATH 里解出来的是 npm 的 .cmd 套壳，长文本走命令行参数在 Windows 上不可靠（引号、换行、' +
  '百分号变量会坏）。不起 kimi，也不假装能跑。';

// —— 状态目录 ——

const workersDir = (home) => join(home, '.fleet-dao', 'workers');
const stateDir = (home, name) => join(workersDir(home), name);
const metaFile = (home, name) => join(stateDir(home, name), 'meta.json');

function metaProblem(m) {
  if (!m || typeof m !== 'object') return '不是一个对象';
  if (typeof m.name !== 'string' || !m.name) return 'name 认不出';
  if (!MODELS.includes(m.model)) return 'model 认不出';
  if (m.pidUncertain === true) {
    if (m.pid !== null) return 'pidUncertain 时 pid 应该是 null';
    if (typeof m.pidUncertainWhy !== 'string' || !m.pidUncertainWhy) return 'pidUncertainWhy 认不出';
  } else if (m.pidUncertain !== undefined && m.pidUncertain !== false) {
    return 'pidUncertain 认不出';
  } else if (!Number.isInteger(m.pid) || m.pid <= 0) {
    return 'pid 认不出';
  }
  if (!EFFORTS.includes(m.effort)) return 'effort 认不出';
  if (typeof m.mainRepo !== 'string' || !m.mainRepo) return 'mainRepo 认不出';
  if (typeof m.worktree !== 'string' || !m.worktree) return 'worktree 认不出';
  if (typeof m.branch !== 'string' || !m.branch) return 'branch 认不出';
  if (!Number.isFinite(Date.parse(m.startedAt))) return 'startedAt 认不出';
  if (typeof m.outLog !== 'string' || !m.outLog) return 'outLog 认不出';
  if (typeof m.errLog !== 'string' || !m.errLog) return 'errLog 认不出';
  return null;
}

/** 读一个工人的 meta.json；文件没有、不是 JSON、缺字段都明说，不当成「没在跑」。 */
function readMeta(home, name) {
  const file = metaFile(home, name);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    return {
      ok: false,
      why:
        e.code === 'ENOENT'
          ? `工人「${name}」没有记录（${file} 不存在）：是不是名字打错了，或者从没 start 过`
          : `${file} 读不了（${e.code ?? e.message}）`,
    };
  }
  let m;
  try {
    m = JSON.parse(text);
  } catch (e) {
    return { ok: false, why: `${file} 不是 JSON（${e.message}）` };
  }
  const why = metaProblem(m);
  if (why) return { ok: false, why: `${file} 认不出（${why}）` };
  return { ok: true, meta: m, file };
}

/** git worktree list --porcelain 的输出拆成一条条 { path, branch }。 */
function parseWorktreeList(text) {
  return String(text ?? '')
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n');
      const path = /^worktree (.+)$/.exec(lines[0] ?? '')?.[1] ?? '';
      const branchLine = lines.find((l) => l.startsWith('branch '));
      return { path, branch: branchLine ? branchLine.slice('branch '.length).trim() : null };
    });
}

const normalizePath = (p) =>
  String(p ?? '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();

/**
 * 这棵工作树、这个分支，git 自己的账本里是不是已经占了。回 { ok: true }、{ ok: false, kind: 'conflict', why }
 * （真占了，调用方算冲突，退出码 3），或 { ok: false, kind: 'unknown', why }（list 本身没跑成，查不出，算没查成，退出码 2）。
 */
function worktreeConflict(io, repo, worktreeDir, branch) {
  const r = io.git(['worktree', 'list', '--porcelain'], { cwd: repo });
  if (r.status !== 0) return { ok: false, kind: 'unknown', why: `git worktree list 没跑成：${reasonOf(r)}` };
  const target = normalizePath(worktreeDir);
  const branchRef = `refs/heads/${branch}`;
  const hit = parseWorktreeList(r.stdout).find(
    (e) => normalizePath(e.path) === target || e.branch === branchRef,
  );
  if (!hit) return { ok: true };
  return {
    ok: false,
    kind: 'conflict',
    why: `已经有一棵工作树占着了：${hit.path}${hit.branch ? `（分支 ${hit.branch}）` : ''}`,
  };
}

// —— start ——

async function cmdStart(p, io) {
  if (p.positional.length > 0) throw new UsageError('start 不收位置参数');
  const model = modelOf(p);
  const name = nameOf(p);
  const briefArg = p.options.get('brief');
  if (!briefArg) throw new UsageError('要带 --brief <文件>');
  const modelId = p.options.get('model-id');
  const effort = effortOf(p);
  const noShip = p.flags.has('no-ship');
  const noAutomerge = p.flags.has('no-automerge');

  if (model === 'kimi') return fail(io, KIMI_UNSUPPORTED);

  const briefPath = resolvePath(io, briefArg);
  let briefText;
  try {
    briefText = readFileSync(briefPath, 'utf8');
  } catch (e) {
    return fail(io, `brief 文件读不到（${briefPath}）：${e.code ?? e.message}`);
  }
  if (!briefText.trim()) return fail(io, `brief 文件是空的：${briefPath}`);

  const repo = resolvePath(io, p.options.get('repo') ?? io.cwd());
  const branch = `w/${name}`;
  const worktreeDir = join(dirname(repo), `fd-w-${name}`);

  // 先做本地、不碰子进程的检查（已经存在就不用再去问 git 了），再验 repo、再问 git 账本里占没占。
  if (existsSync(worktreeDir))
    return conflict(io, `工作树已经存在：${worktreeDir}（换个 --name，或者先 clean 掉旧的）`);

  const repoCheck = io.git(['rev-parse', '--is-inside-work-tree'], { cwd: repo });
  if (repoCheck.status !== 0) return fail(io, `--repo ${repo} 不是 git 检出：${reasonOf(repoCheck)}`);

  const wc = worktreeConflict(io, repo, worktreeDir, branch);
  if (!wc.ok) return wc.kind === 'conflict' ? conflict(io, wc.why) : fail(io, wc.why);

  const fetched = io.git(['fetch', 'origin', 'main'], { cwd: repo });
  if (fetched.status !== 0) return fail(io, `git fetch origin main 没成：${reasonOf(fetched)}`);

  const added = io.git(['worktree', 'add', '-b', branch, worktreeDir, 'origin/main'], { cwd: repo });
  if (added.status !== 0) {
    const why = reasonOf(added);
    if (/already exists|already used by worktree|already checked out/i.test(added.stderr ?? ''))
      return conflict(io, `git worktree add 说已经占了：${why}`);
    return fail(io, `git worktree add 没成：${why}`);
  }

  const installed = io.pnpm(['install', '--frozen-lockfile', '--prefer-offline'], { cwd: worktreeDir });
  if (installed.status !== 0)
    return fail(
      io,
      `pnpm install 没成（工作树留着没删，手动看，或者 clean --name ${name} --force 删掉重来）：${reasonOf(installed)}`,
    );

  const dir = stateDir(io.home, name);
  mkdirSync(dir, { recursive: true });
  const promptFile = join(dir, 'prompt.txt');
  const outLog = join(dir, 'out.log');
  const errLog = join(dir, 'err.log');
  writeFileSync(promptFile, `${briefText.trimEnd()}\n\n${closingBrief({ branch, noShip, noAutomerge })}\n`);

  const launch = launchOf(model, { promptFile, worktreeDir, modelId, effort });
  let spawned;
  try {
    spawned = io.spawnDetached({
      command: launch.command,
      args: launch.args,
      cwd: worktreeDir,
      env: { ...mergeNoProxy(safeEnv(io.env)), ...launch.extraEnv },
      stdinFile: launch.stdinFile,
      outFile: outLog,
      errFile: errLog,
    });
  } catch (e) {
    if (e.uncertain) {
      // 半成功：起的那一步没能确认成没成，但也没确认失败——不能说「起不了」（09-28 真撞过：进程其实已经在跑，
      // 见文件头）。工作树、pnpm install、prompt.txt 都留着，把能写的先写上，让 status/stop/clean 之后还找得到。
      writeFileSync(
        join(dir, 'meta.json'),
        `${JSON.stringify(
          {
            name,
            model,
            modelId: modelId ?? null,
            effort,
            pid: null,
            pidUncertain: true,
            pidUncertainWhy: e.message,
            mainRepo: repo,
            worktree: worktreeDir,
            branch,
            startedAt: io.now().toISOString(),
            promptFile,
            outLog,
            errLog,
            noShip,
            cleanedAt: null,
          },
          null,
          2,
        )}\n`,
      );
      return fail(
        io,
        `不确定：${model} 进程可能已经在跑、没记上 pid（${e.message}）。工作树和日志都留着（${worktreeDir}），` +
          `确认后 node worker.mjs status --name ${name} 能看到「不确定」这个状态；先手动确认真跑没跑（任务管理器` +
          `或 tasklist 按工作树路径查），clean 要带 --force。`,
      );
    }
    return fail(io, `起不了 ${model}（工作树和 pnpm install 都已经做完，没删）：${e.message}`);
  }

  writeFileSync(
    join(dir, 'meta.json'),
    `${JSON.stringify(
      {
        name,
        model,
        modelId: modelId ?? null,
        effort,
        pid: spawned.pid,
        mainRepo: repo,
        worktree: worktreeDir,
        branch,
        startedAt: io.now().toISOString(),
        promptFile,
        outLog,
        errLog,
        noShip,
        cleanedAt: null,
      },
      null,
      2,
    )}\n`,
  );
  io.out(`${name}：pid ${spawned.pid}，档位 ${effort}，工作树 ${worktreeDir}，日志 ${outLog}`);
  return 0;
}

// —— status ——

function lastMeaningfulLine(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: true, line: null };
    return { ok: false, why: `${file} 读不了（${e.code ?? e.message}）` };
  }
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return { ok: true, line: lines.at(-1) ?? null };
}

function prOf(io, m) {
  const r = io.gh(['pr', 'list', '--head', m.branch, '--state', 'all', '--json', 'number,state,url'], {
    cwd: m.mainRepo,
  });
  if (r.status !== 0) return { ok: false, why: reasonOf(r) };
  let rows;
  try {
    rows = JSON.parse(r.stdout);
  } catch (e) {
    return { ok: false, why: `gh 回的不是 JSON：${e.message}` };
  }
  if (!Array.isArray(rows)) return { ok: false, why: 'gh 回的不是一个列表' };
  return { ok: true, rows };
}

function oneStatus(io, name, at) {
  const r = readMeta(io.home, name);
  if (!r.ok) return { name, ok: false, why: r.why };
  const m = r.meta;
  const last = lastMeaningfulLine(m.outLog);
  if (!last.ok) return { name, ok: false, why: last.why };
  const elapsedMin = Math.max(0, Math.round((at.getTime() - Date.parse(m.startedAt)) / 60_000));
  const base = {
    name,
    ok: true,
    model: m.model,
    effort: m.model === 'kimi' ? null : m.effort,
    elapsedMin,
    lastLine: last.line,
    cleanedAt: m.cleanedAt,
    worktree: m.worktree,
    branch: m.branch,
    pr: prOf(io, m),
  };
  // pidUncertain：起的时候没能确认 pid（见文件头），没法调 io.isRunning——那需要一个真 pid，不能瞎猜。
  if (m.pidUncertain) return { ...base, pidUncertain: true, pidUncertainWhy: m.pidUncertainWhy, pid: null };
  return { ...base, pidUncertain: false, running: io.isRunning(m.pid), pid: m.pid };
}

function formatStatus(s) {
  if (!s.ok) return `${s.name}：没查成——${s.why}`;
  const prText = !s.pr.ok
    ? `没查到（${s.pr.why}）`
    : s.pr.rows.length === 0
      ? '没有'
      : s.pr.rows.map((r) => `#${r.number}（${r.state}）${r.url}`).join('、');
  const stateText = s.pidUncertain
    ? `不确定在跑没跑（起的时候没记上 pid：${s.pidUncertainWhy}）`
    : `${s.running ? '在跑' : '已经不在跑了'}${s.cleanedAt ? `（已经 clean 过：${s.cleanedAt}）` : ''}，pid ${s.pid}`;
  return [
    `${s.name}：${s.model}，档位 ${s.effort ?? '不支持'}，${stateText}，从起来到现在 ${s.elapsedMin} 分钟`,
    `  工作树 ${s.worktree}（分支 ${s.branch}）`,
    `  最后一句输出：${s.lastLine ?? '（还没有输出）'}`,
    `  PR：${prText}`,
  ].join('\n');
}

async function cmdStatus(p, io) {
  if (p.positional.length > 0) throw new UsageError('status 不收位置参数');
  const name = p.options.get('name');
  const at = io.now();
  if (name) {
    const s = oneStatus(io, name, at);
    io.out(formatStatus(s));
    return s.ok ? 0 : 2;
  }
  let names;
  try {
    names = readdirSync(workersDir(io.home)).sort();
  } catch (e) {
    if (e.code === 'ENOENT') {
      io.out('没有起过任何工人');
      return 0;
    }
    return fail(io, `${workersDir(io.home)} 读不了（${e.code ?? e.message}）`);
  }
  if (names.length === 0) {
    io.out('没有起过任何工人');
    return 0;
  }
  let code = 0;
  for (const n of names) {
    const s = oneStatus(io, n, at);
    io.out(formatStatus(s));
    if (!s.ok) code = 2;
  }
  return code;
}

// —— stop ——

async function cmdStop(p, io) {
  if (p.positional.length > 0) throw new UsageError('stop 不收位置参数');
  const name = nameOf(p);
  const r = readMeta(io.home, name);
  if (!r.ok) return fail(io, r.why);
  const m = r.meta;
  if (m.pidUncertain)
    return fail(
      io,
      `${name} 没记上 pid，stop 杀不了：自己用任务管理器或 tasklist 按工作树路径（${m.worktree}）找进程手动结束，` +
        `确认后 node worker.mjs clean --name ${name} --force 收尾`,
    );
  if (!io.isRunning(m.pid)) {
    io.out(`${name} 已经不在跑了（pid ${m.pid}）`);
    return 0;
  }
  const k = io.killTree(m.pid);
  if (!k.ok) return fail(io, `没停成（pid ${m.pid}）：${k.why}`);
  io.out(`${name} 停了（pid ${m.pid}）`);
  return 0;
}

// —— clean ——

async function cmdClean(p, io) {
  if (p.positional.length > 0) throw new UsageError('clean 不收位置参数');
  const name = nameOf(p);
  const force = p.flags.has('force');
  const r = readMeta(io.home, name);
  if (!r.ok) return fail(io, r.why);
  const m = r.meta;

  if (m.pidUncertain) {
    if (!force)
      return conflict(
        io,
        `${name} 没记上 pid，不确定还在跑没跑，不敢删：自己确认完了（任务管理器或 tasklist 按工作树路径 ` +
          `${m.worktree} 查）再带 --force`,
      );
  } else if (io.isRunning(m.pid)) {
    return conflict(io, `${name} 还在跑（pid ${m.pid}）：先 node worker.mjs stop --name ${name}`);
  }

  if (!force) {
    const pr = prOf(io, m);
    if (!pr.ok) return fail(io, `PR 状态查不到，不确定合没合，不敢删（确认要删就带 --force）：${pr.why}`);
    if (pr.rows.length === 0)
      return conflict(
        io,
        `没找到分支 ${m.branch} 的 PR（可能从没开过，比如 --no-ship 冒烟）：确认要删就带 --force`,
      );
    const open = pr.rows.filter((row) => row.state === 'OPEN');
    if (open.length > 0)
      return conflict(
        io,
        `PR 还开着、没合也没关：${open.map((row) => `#${row.number} ${row.url}`).join('、')}；合了或关了再删，或者带 --force`,
      );
  }

  const removed = io.git(['worktree', 'remove', m.worktree, '--force'], { cwd: m.mainRepo });
  if (removed.status !== 0) return fail(io, `git worktree remove 没成：${reasonOf(removed)}`);
  const branchDeleted = io.git(['branch', '-D', m.branch], { cwd: m.mainRepo });
  if (branchDeleted.status !== 0)
    return fail(
      io,
      `工作树删了，但分支 ${m.branch} 没删成（手动 git branch -D ${m.branch}）：${reasonOf(branchDeleted)}`,
    );

  writeFileSync(r.file, `${JSON.stringify({ ...m, cleanedAt: io.now().toISOString() }, null, 2)}\n`);
  io.out(`${name} 清理完了：工作树、本地分支删了，日志留在 ${dirname(r.file)}`);
  return 0;
}

// —— 入口 ——

/**
 * worker.mjs 的全部逻辑。io：{
 *   env, home, now() → Date, cwd() → string,
 *   git(args, {cwd}) → {status, stdout, stderr, error?},
 *   gh(args, {cwd}) → 同上,
 *   pnpm(args, {cwd}) → 同上,
 *   spawnDetached({command, args, cwd, env, stdinFile, outFile, errFile}) → {pid}；确认起不来就抛 Error，
 *     起没起成不确定时（比如中间那步查不到 pid，但也没法排除已经起来了）要在 Error 上标 err.uncertain = true，
 *     cmdStart 按「不确定」处理、不说「起不了」，把能写的 meta 先写上（见文件头「安全」和「pidUncertain」两条）,
 *   isRunning(pid) → boolean,
 *   killTree(pid) → {ok, why?},
 *   out(text), err(text),
 * }。返回退出码（见 USAGE）。
 */
export async function runWorker(argv, io) {
  try {
    if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
      io.out(USAGE);
      return argv.length === 0 ? 1 : 0;
    }
    const [cmd, ...rest] = argv;
    if (cmd === 'start')
      return await cmdStart(
        parseArgs(
          rest,
          ['model', 'name', 'brief', 'repo', 'model-id', 'effort'],
          ['no-ship', 'no-automerge'],
        ),
        io,
      );
    if (cmd === 'status') return await cmdStatus(parseArgs(rest, ['name']), io);
    if (cmd === 'stop') return await cmdStop(parseArgs(rest, ['name']), io);
    if (cmd === 'clean') return await cmdClean(parseArgs(rest, ['name'], ['force']), io);
    throw new UsageError(`没有「${cmd}」这个命令\n${USAGE}`);
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(e.message);
      return 1;
    }
    return fail(io, `没查成、没做成：${e.message}`);
  }
}
