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
// - 代理：GitHub 走哪条路不写死，start 在 fetch 之前当场判一次（pickGithubRoute），记进 meta.json 的 githubRoute。
//   09-28 那会儿是「带代理连 GitHub 会失败、直连通」，10-05 撞上反过来的：github.com 直连超时、带会话里的代理才通，
//   写死「一律去代理」让工人一个都起不来。所以：先去掉代理 git ls-remote 直连一次（8 秒上限）——
//   · 通（direct）：照老做法，本脚本自己的 git/gh 去掉代理（worker.mjs 的 stripProxy）；起的模型命令行保留代理去连
//     它自己的后端，只另外把 NO_PROXY/no_proxy 加上 GITHUB_HOSTS 三个域名（mergeNoProxy），让它自己跑的 git/gh 直连
//     GitHub（Go 的 net/http、git 的 libcurl 都认 NO_PROXY）；收尾交代教它连不上时加 `env -u …` 去代理重试。
//   · 不通就带环境里原有的代理再试一次，通（proxy）：谁都不去代理——本脚本的 git/gh 调用带 proxy: true（外壳照原样
//     传环境），模型命令行不加 NO_PROXY，收尾交代不教它去代理。
//   · 两条都不通、或直连不通且环境里没有代理：不起，报错里两条各自的原因都写上。
//   status/watch/clean 查 PR 照 meta 里记的路走（老记录没有这个字段，照当时的做法算直连）；git worktree remove、
//   branch -D 这些纯本地的不连网，不分路。
// - 进程用 detached + windowsHide + stdio 指向真文件描述符（不是管道）起，spawn 完立刻 unref：这样 `start` 这条命令
//   退出之后子进程照样活着；用文件描述符不用 pipe，是因为 pipe 要父进程留着读写端才不出问题，文件描述符不需要。
// - 状态记在 ~/.fleet-dao/workers/<短名>/（meta.json、out.log、err.log、prompt.txt）：机器本地、不进仓。
// - 思考档位（创始人 2026-09-28 拍）：默认 high，简单活可以 medium，不用 xhigh。--effort 不给就照仓里路由骨架
//   （packages/db/routing.default.json，#470）给这个模型配的：引擎起会话照法国库里的路由两层，库里的值由这份骨架装进去、
//   驾驶舱再改；本机读不到法国库，读同步专用检出 ~/.fleet-dao/origin-main 里的那份（技能脚本也是从它装的，停在 origin/main）。
//   没配就是 high；骨架读不到、认不出，不起（不当成 high）。总是显式传给命令行，不靠模型自己的默认（grok 自己的默认是
//   xhigh，09-28 冒烟撞过）。grok 传 --reasoning-effort <档>；codex 传 -c model_reasoning_effort="<档>"（TOML 字符串，
//   引号是字面量，~/.codex/config.toml 里本来就有这个键，键名对得上）；kimi 不支持，不传，status 里标「不支持」。
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
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const NAME_RE = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const MODELS = ['grok', 'codex', 'kimi', 'claude'];
/** 思考档位的叫法，和 packages/shared/src/effort.ts 的 SESSION_EFFORTS 一样（测试钉着）。 */
export const SESSION_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
/** grok、codex 命令行认的档（都没有 max）；总是显式传给模型命令行。 */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh'];
/** 骨架里这个模型没配档位时用这一档（创始人 2026-09-28 拍：默认 high，别用 xhigh）。 */
export const DEFAULT_EFFORT = 'high';
/** 路由骨架在同步专用检出里的位置（相对家目录）：本机读不到法国库，档位照它（见文件头）。 */
export const ROUTING_DEFAULT_REL = join(
  '.fleet-dao',
  'origin-main',
  'packages',
  'db',
  'routing.default.json',
);
/** 不给 --model-id 时按骨架里哪个模型查档位：本机 grok 命令行跑的就是 grok-4.7（法国 grok 那条路由同一个命令行），codex 跑 GPT。 */
export const ROUTING_MODEL_OF = { grok: 'grok-4.7', codex: 'gpt-5.6-luna', claude: 'sonnet' };
/**
 * Claude 工人只许这两族（通用段「我的机器与模型」：机器派的会话、工人永不用 Fable，只用 Opus 或 Sonnet）。
 * 不给 --model-id 用 sonnet（创始人 2026-10-05：「派活我推荐sonnet5.5>opus5.5」），要 Opus 显式给 --model-id opus；
 * 给了别的（fable、haiku、认不出的）一律拒起，不替人改成能用的。
 */
export const CLAUDE_DEFAULT_MODEL = 'sonnet';
export function claudeModelProblem(modelId) {
  const id = modelId ?? CLAUDE_DEFAULT_MODEL;
  if (/^(opus|sonnet)$/.test(id) || /^claude-(opus|sonnet)-[\w.-]+$/.test(id)) return null;
  return `Claude 工人只用 Opus 或 Sonnet（机器派的会话永不用 Fable）：--model-id 给的是「${id}」，不起。`;
}
/** 模型自己要连的 GitHub 域名：直连通时让它自己跑的 git/gh 绕开代理直连这几个（走代理时不加，见文件头「代理」）。 */
export const GITHUB_HOSTS = ['github.com', 'api.github.com', 'codeload.github.com'];

export const USAGE = `用法：node worker.mjs <命令> …（在项目仓的检出里跑，或用 --repo 指一个）
  start --model grok|codex|kimi|claude --name <短名> --brief <文件> [--repo <主检出路径>] [--model-id <型号>]
        [--model-id：claude 默认 sonnet，要 Opus 给 opus；Fable 一律拒起]
        [--effort low|medium|high|xhigh，这一次用的；不给照 ~/${ROUTING_DEFAULT_REL.replaceAll('\\', '/')} 给这个模型配的，
        没配是 ${DEFAULT_EFFORT}] [--no-ship] [--no-automerge]
                    在主检出的 .claude/worktrees/ 下建一棵工作树、起一个模型命令行去干活（后台跑，这条命令退出它照跑）
                    --no-automerge：开非草稿 PR 但不挂自动合并，正文「还欠什么」栏写「人闸：改标准」，CI 绿了就停
                    （改标准要创始人点头才能合，见 AGENTS.md「改标准是人闸第四类」）；不给就是本机快马老规矩：
                    CI 绿就合、自动挂上。
  status [--name <短名>]         看工人在跑没跑、跑了多久、最后一句输出、对应的 PR；不带 --name 看全部
  watch [--wait <秒>]            巡看：只打印上次巡看之后变了的工人（「变化：…」），最后一行「还在跑：N」；
                                 --wait 没变化就等（最多 55 秒），一有变化马上返回；整条命令不超过
                                 max(--wait, 10) + 2 秒，到点没查完 PR 的工人报「没查成：…」、退出码 2
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
  if (!v) throw new UsageError('要带 --model grok|codex|kimi|claude');
  if (!MODELS.includes(v)) throw new UsageError(`不认识的模型「${v}」：只有 grok、codex、kimi、claude`);
  return v;
}

/** 命令行给的 --effort（一次性的指令，不改骨架）；没给是 undefined。 */
function explicitEffortOf(p) {
  const v = p.options.get('effort');
  if (v === undefined) return undefined;
  if (!EFFORTS.includes(v)) throw new UsageError(`不认识的档位「${v}」：只有 ${EFFORTS.join('、')}`);
  return v;
}

/**
 * 这次起工人用哪一档（#470）：--effort 给了就用它；不给照路由骨架给这个模型配的——模型下几条路由配了的都一样就用它，一条都没配、
 * 骨架里没这个模型就是 DEFAULT_EFFORT。骨架读不到、不是 JSON、形状或档位认不出、几条路由配的不一样（不知道照哪条）、这个命令行
 * 不认那一档：回 { ok: false, why }，调用方不起，不当成 high。
 */
export function routingEffortFor(home, model, modelId) {
  const file = join(home, ROUTING_DEFAULT_REL);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    return {
      ok: false,
      why: `路由骨架读不到（${file}：${e.code ?? e.message}），档位照它定、读不到不起：这台机器的同步专用检出没装好就先跑 pnpm agents:sync，或者带 --effort 明说这一次用哪档`,
    };
  }
  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch (e) {
    return { ok: false, why: `路由骨架不是 JSON（${file}：${e.message}）` };
  }
  const models = cfg?.models;
  if (!models || typeof models !== 'object' || Array.isArray(models)) {
    return { ok: false, why: `路由骨架认不出（${file}）：没有 models（模型 → 路由顺序）` };
  }
  const routingModel = modelId ?? ROUTING_MODEL_OF[model];
  const routes = models[routingModel];
  if (routes === undefined) {
    return { ok: true, effort: DEFAULT_EFFORT, source: `路由骨架里没有模型 ${routingModel}，用默认` };
  }
  if (!Array.isArray(routes)) {
    return { ok: false, why: `路由骨架认不出（${file}）：models.${routingModel} 不是路由列表` };
  }
  const configured = [];
  for (const [i, r] of routes.entries()) {
    if (!r || typeof r !== 'object' || typeof r.routeId !== 'string') {
      return {
        ok: false,
        why: `路由骨架认不出（${file}）：models.${routingModel} 第 ${i + 1} 项不是 { routeId, enabled }`,
      };
    }
    if (r.effort === undefined) continue;
    if (!SESSION_EFFORTS.includes(r.effort)) {
      return {
        ok: false,
        why: `路由骨架里 ${r.routeId} 的思考档位认不出：${JSON.stringify(r.effort)}（只有 ${SESSION_EFFORTS.join('、')}）`,
      };
    }
    configured.push(r);
  }
  const distinct = [...new Set(configured.map((r) => r.effort))];
  if (distinct.length > 1) {
    return {
      ok: false,
      why: `路由骨架里模型 ${routingModel} 几条路由配的档位不一样（${configured.map((r) => `${r.routeId}：${r.effort}`).join('、')}），启动器不知道照哪条：带 --effort 明说这一次用哪档`,
    };
  }
  const effort = distinct[0] ?? DEFAULT_EFFORT;
  if (!EFFORTS.includes(effort)) {
    return {
      ok: false,
      why: `路由骨架给模型 ${routingModel} 配的是 ${effort}，${model} 命令行不认（只认 ${EFFORTS.join('、')}）：带 --effort 明说这一次用哪档`,
    };
  }
  return {
    ok: true,
    effort,
    source:
      distinct.length > 0 ? `路由骨架给 ${routingModel} 配的` : `路由骨架里 ${routingModel} 没配，用默认`,
  };
}

/** 相对路径按 io.cwd() 展开，不用真的 process.cwd()（测试里两者不是一回事）。 */
const resolvePath = (io, p) => (isAbsolute(p) ? p : join(io.cwd(), p));

// —— 传给模型进程的环境变量：白名单 ——

/**
 * 起的模型进程只给这些名字的环境变量（Windows 标准路径类 + Node/pnpm 常用的几个），谁都用得上、谁都不是
 * 密钥。09-28 发现的教训见文件头：这是白名单，不是「挡像密钥的名字」那种黑名单——以后环境里加什么新变量，
 * 默认都不传，要模型真需要了再加名字到这。代理相关的几个（http_proxy 等）单独在 PROXY_ENV_KEYS，因为
 * 直连通时 mergeNoProxy 还要在它们基础上改 NO_PROXY/no_proxy。
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

/** 判「GitHub 走哪条路」那一下 git ls-remote 的上限：直连不通时多半是卡到超时，不能一等两分钟。 */
export const GITHUB_PROBE_TIMEOUT_MS = 8000;
const GITHUB_ROUTES = ['direct', 'proxy'];

/** 环境里原有的代理地址（https 优先，大小写都认）；没有回 null。 */
export function proxyOf(env) {
  return env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY || null;
}

/**
 * 这台机器此刻连 GitHub 走哪条路（必经的一步：start 在 fetch 之前判一次，记进 meta.json，后面 status/watch/clean
 * 调 gh 照它走）。先去掉代理直连 git ls-remote 一次（8 秒上限）：通就是 direct（老做法：脚本自己的 git/gh 去代理、
 * 模型命令行加 GitHub 的 NO_PROXY）；不通就带着环境里原有的代理再试一次：通就是 proxy（谁都不去代理、不加 NO_PROXY）。
 * 两条都不通、或直连不通且环境里根本没有代理：回 { ok: false, why }，两条各自的报错都写上，调用方不起。
 */
export function pickGithubRoute(io, repo) {
  const probe = (proxy) =>
    io.git(['ls-remote', 'origin', 'main'], { cwd: repo, proxy, timeoutMs: GITHUB_PROBE_TIMEOUT_MS });
  const direct = probe(false);
  if (direct.status === 0) return { ok: true, route: { via: 'direct', proxy: null } };
  const directWhy = reasonOf(direct);
  const proxy = proxyOf(io.env);
  if (!proxy)
    return {
      ok: false,
      why: `连不上 GitHub：去掉代理直连 git ls-remote 不通（${directWhy}），环境里也没有代理（https_proxy/http_proxy 都没设）可走`,
    };
  const viaProxy = probe(true);
  if (viaProxy.status === 0) return { ok: true, route: { via: 'proxy', proxy } };
  return {
    ok: false,
    why: `连不上 GitHub，两条路都不通：去掉代理直连——${directWhy}；走代理 ${proxy}——${reasonOf(viaProxy)}`,
  };
}

/** 判出来的路给人看的一行。 */
const routeLine = (route) => (route.via === 'proxy' ? `GitHub：走代理 ${route.proxy}` : 'GitHub：直连');

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
export function closingBrief({ branch, noShip, noAutomerge, githubRoute = { via: 'direct' } }) {
  if (noShip) {
    return [
      '—— 收尾交代 ——',
      '这是冒烟测试：不要 git commit、不要 git push、不要开 PR、不要碰 GitHub。',
      '做完上面的事，最后单独一行只输出：完成',
    ].join('\n');
  }
  const open = 'pnpm pr:open --title "<标题>" --body-file _tmp/pr-body.md';
  const prSteps = noAutomerge
    ? [
        `4. 正文照 .github/pull_request_template.md 的四栏写进 _tmp/pr-body.md，「还欠什么」写「人闸：改标准」；跑 ${open} --no-automerge`,
        '   开 PR。不要挂自动合并、不要跑 gh pr merge：创始人同意之前不能合。',
        '5. gh pr checks <PR 号> --watch 盯到过或红；红了自己改，最多 3 轮；CI 绿了就停下，不等合并、不等创始人回话。',
      ]
    : [
        `4. 正文照 .github/pull_request_template.md 的四栏写进 _tmp/pr-body.md，跑 ${open}：它开 PR、当场挂自动合并；`,
        '   它说「人闸：改标准」就照第 6 条停手。',
        '5. gh pr checks <PR 号> --watch 盯到过或红；红了自己改，最多 3 轮。',
      ];
  return [
    '—— 收尾交代（帅位自动加的，照做；具体要做的活见上面）——',
    '1. 照仓根 AGENTS.md 做。这是本机快马：不开单、不另写需求/结果文档、不认领（#446）。',
    '2. 改完跑 pnpm test:changed 要过（退出码 3 时照它打印的命令单跑对应包，不在这台机器上跑全量 pnpm test 或 pnpm check）；',
    '   格式和类型检查推前钩子会跑。提交信息一句话说清改了什么、为什么。',
    `3. git push -u origin ${branch}`,
    ...prSteps,
    '6. 不开新 issue，不碰这棵工作树以外的目录、不碰别的检出。碰到四类人闸——对外发布（上线、发版）、花钱（账单会',
    '   多出一笔的）、删数据、改标准——就停手：不自己做、不挂自动合并，最后输出「卡住：人闸——<哪一类、卡在哪>」。',
    ...(githubRoute.via === 'proxy'
      ? [
          '7. 这台机器连 GitHub 只能走代理（https_proxy/http_proxy，实测过直连不通）：git 或 gh 连不上时不要去掉代理，',
          '   原样重试一次；还不行就输出「卡住：GitHub 连不上——<报错>」。',
        ]
      : [
          '7. git 或 gh 连 GitHub 失败、像是代理问题：命令前加',
          '   env -u https_proxy -u http_proxy -u HTTPS_PROXY -u HTTP_PROXY 再试一次。',
        ]),
    '8. 最后单独一行输出：完成：PR #<号>；做不下去就输出：卡住：<原因>',
  ].join('\n');
}

// —— 起哪个模型 ——

/**
 * 各模型的无人值守启动方式；kimi 没有可靠的方式，调用方另处理。思考档位总是显式传（不靠模型自己的默认，
 * grok 自己默认 xhigh）：grok 用 --reasoning-effort，codex 用 -c model_reasoning_effort="<档>"（TOML 字符串，
 * 引号是字面量、和 ~/.codex/config.toml 里的键名对得上）。extraEnv 是这个模型必须额外给的环境变量（不从
 * io.env 挑，是我们自己强加的），cmdStart 会把它叠在 safeEnv（直连通时再加 mergeNoProxy）算出来的 env 上面。
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
  // Claude 一律经 reclaude 起（通用段）。-p 不带位置参数时从 stdin 读提示词；工作目录由起进程那一步定（没有 --cwd 这个参数）。
  // 用户级的钩子（pretool.mjs 那几条拦截）在无头模式下照常生效，--dangerously-skip-permissions 只是不弹权限确认。
  if (model === 'claude')
    return {
      command: 'reclaude',
      args: [
        '-p',
        '--dangerously-skip-permissions',
        '--model',
        modelId ?? CLAUDE_DEFAULT_MODEL,
        '--effort',
        effort,
        // 边做边出日志：默认的文字输出做完才出字，中途 status 只能报「还没有输出」（2026-10-05 第一件真活就是这样，
        // 创始人问进度时只能去翻它的工作树猜）。stream-json 必须配 --verbose，status 用 saidOf 把事件翻成人话。
        '--output-format',
        'stream-json',
        '--verbose',
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

/** 和开会话钩子 session-start.mjs 的 WORKERS_REL 同一处（互相 import 不了，agents/test/hooks-shared.test.ts 钉着相等） */
export const workersDir = (home) => join(home, '.fleet-dao', 'workers');
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
  // 老记录（这个字段加上之前 start 的）没有 githubRoute，照当时的做法算直连；有就得认得出，不猜。
  if (m.githubRoute !== undefined && !GITHUB_ROUTES.includes(m.githubRoute)) return 'githubRoute 认不出';
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
 * 从 here（主检出或它的任一棵工作树）找主检出：git worktree list 的第一条永远是主检出。
 * 回 { ok: true, main, trees }，或 { ok: false, why }（list 没跑成、输出认不出，算没查成，退出码 2；不退回拿 here 冒充）。
 */
function mainCheckoutOf(io, here) {
  const r = io.git(['worktree', 'list', '--porcelain'], { cwd: here });
  if (r.status !== 0) return { ok: false, why: `git worktree list 没跑成：${reasonOf(r)}` };
  const trees = parseWorktreeList(r.stdout);
  const main = trees[0]?.path;
  if (!main)
    return {
      ok: false,
      why: `git worktree list 的输出里认不出主检出（${
        String(r.stdout ?? '')
          .trim()
          .slice(0, 80) || '空的'
      }）`,
    };
  return { ok: true, main: resolve(main), trees };
}

/** 这棵工作树、这个分支，git 自己的账本里是不是已经占了：回 { ok: true } 或 { ok: false, why }（调用方算冲突，退出码 3）。 */
function worktreeConflict(trees, worktreeDir, branch) {
  const target = normalizePath(worktreeDir);
  const branchRef = `refs/heads/${branch}`;
  const hit = trees.find((e) => normalizePath(e.path) === target || e.branch === branchRef);
  if (!hit) return { ok: true };
  return {
    ok: false,
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
  const explicitEffort = explicitEffortOf(p);
  const noShip = p.flags.has('no-ship');
  const noAutomerge = p.flags.has('no-automerge');

  if (model === 'kimi') return fail(io, KIMI_UNSUPPORTED);
  if (model === 'claude') {
    const bad = claudeModelProblem(modelId);
    if (bad) return fail(io, bad);
  }

  // 档位先定：骨架读不到、认不出就不起，什么都还没建
  const picked =
    explicitEffort === undefined
      ? routingEffortFor(io.home, model, modelId)
      : { ok: true, effort: explicitEffort, source: '--effort 指定的' };
  if (!picked.ok) return fail(io, picked.why);
  const { effort } = picked;

  const briefPath = resolvePath(io, briefArg);
  let briefText;
  try {
    briefText = readFileSync(briefPath, 'utf8');
  } catch (e) {
    return fail(io, `brief 文件读不到（${briefPath}）：${e.code ?? e.message}`);
  }
  if (!briefText.trim()) return fail(io, `brief 文件是空的：${briefPath}`);

  const here = resolvePath(io, p.options.get('repo') ?? io.cwd());
  const branch = `w/${name}`;

  const repoCheck = io.git(['rev-parse', '--is-inside-work-tree'], { cwd: here });
  if (repoCheck.status !== 0) return fail(io, `--repo ${here} 不是 git 检出：${reasonOf(repoCheck)}`);

  const found = mainCheckoutOf(io, here);
  if (!found.ok) return fail(io, found.why);
  const repo = found.main;
  // 建在主检出的 .claude/worktrees/ 下（通用段：工作树一律建在那儿）——那里被 .gitignore 忽略、格式检查不扫，
  // 开会话的清扫也认它；原来建在主检出旁边（fd-w-<名字>），散在仓外没人收。在某棵工作树里起工人也拼在主检出下，
  // 不拿当前目录直接拼（那样会在那棵树里再套一棵）。
  const worktreeDir = join(repo, '.claude', 'worktrees', `w-${name}`);

  if (existsSync(worktreeDir))
    return conflict(io, `工作树已经存在：${worktreeDir}（换个 --name，或者先 clean 掉旧的）`);

  const wc = worktreeConflict(found.trees, worktreeDir, branch);
  if (!wc.ok) return conflict(io, wc.why);

  const routed = pickGithubRoute(io, repo);
  if (!routed.ok) return fail(io, routed.why);
  const githubRoute = routed.route;
  const viaProxy = githubRoute.via === 'proxy';
  io.out(routeLine(githubRoute));

  const fetched = io.git(['fetch', 'origin', 'main'], { cwd: repo, proxy: viaProxy });
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
  writeFileSync(
    promptFile,
    `${briefText.trimEnd()}\n\n${closingBrief({ branch, noShip, noAutomerge, githubRoute })}\n`,
  );

  const launch = launchOf(model, { promptFile, worktreeDir, modelId, effort });
  let spawned;
  try {
    spawned = io.spawnDetached({
      command: launch.command,
      args: launch.args,
      cwd: worktreeDir,
      // 直连通才让模型自己的 git/gh 绕开代理连 GitHub；走代理时原样给，加 NO_PROXY 就是把它推到不通的直连上。
      env: { ...(viaProxy ? safeEnv(io.env) : mergeNoProxy(safeEnv(io.env))), ...launch.extraEnv },
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
            githubRoute: githubRoute.via,
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
        githubRoute: githubRoute.via,
        cleanedAt: null,
      },
      null,
      2,
    )}\n`,
  );
  io.out(
    `${name}：pid ${spawned.pid}，档位 ${effort}（${picked.source}），工作树 ${worktreeDir}，日志 ${outLog}`,
  );
  return 0;
}

// —— status ——

/**
 * 一行输出在说什么。Claude 工人的输出是 stream-json（一行一个事件，边做边写，不然做完才出字、中途什么都看不见）：
 * 认出事件就翻成一句人话——在调哪个工具、说了什么、最后的结论；别家模型的输出是普通文字，原样返回。
 * 认不出的事件返回 null（调用方接着往前找上一行），不拿事件原文冒充一句话。
 */
export function saidOf(line) {
  if (!line.startsWith('{')) return line;
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return line; // 只是恰好以 { 开头的普通文字
  }
  if (!ev || typeof ev !== 'object') return null;
  const tail = (text) => {
    const rows = String(text)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    return rows.at(-1) ?? null;
  };
  if (ev.type === 'result') return typeof ev.result === 'string' ? tail(ev.result) : null;
  if (ev.type !== 'assistant' || !Array.isArray(ev.message?.content)) return null;
  for (const b of [...ev.message.content].reverse()) {
    if (b?.type === 'tool_use') {
      const i = b.input ?? {};
      const what = i.command ?? i.file_path ?? i.pattern ?? i.description ?? '';
      return `在调 ${b.name}${what ? `：${String(what).replace(/\s+/g, ' ').slice(0, 80)}` : ''}`;
    }
    if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) return tail(b.text);
  }
  return null;
}

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
  // 从后往前找第一行说得出人话的（stream-json 里夹着认不出的事件）
  let line = null;
  for (let i = lines.length - 1; i >= 0 && line === null; i -= 1) line = saidOf(lines[i]);
  let idleMin = null;
  try {
    idleMin = Math.max(0, Math.round((Date.now() - statSync(file).mtimeMs) / 60_000));
  } catch {
    // 日志刚被删：不知道多久没动
  }
  return { ok: true, line, idleMin };
}

/** 查这个工人分支的 PR：照 start 时判出、记在 meta 里的那条路连 GitHub（老记录没有 githubRoute，照旧直连）。 */
function prOf(io, m) {
  return prFromResult(io.gh(prArgs(m), prOpts(m)));
}

const prArgs = (m) => ['pr', 'list', '--head', m.branch, '--state', 'all', '--json', 'number,state,url'];
const prOpts = (m) => ({ cwd: m.mainRepo, proxy: m.githubRoute === 'proxy' });

/** gh pr list 的回话认成 { ok, rows } 或 { ok: false, why } */
function prFromResult(r) {
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
  const { s, m } = metaStatus(io, name, at);
  if (s.ok) s.pr = prOf(io, m);
  return s;
}

/** 一个工人除了 PR 以外的状态（读 meta、日志、进程在不在，都是本机的、快）；PR 由调用方另查、填进 s.pr。 */
function metaStatus(io, name, at) {
  const r = readMeta(io.home, name);
  if (!r.ok) return { s: { name, ok: false, why: r.why }, m: null };
  const m = r.meta;
  const last = lastMeaningfulLine(m.outLog);
  if (!last.ok) return { s: { name, ok: false, why: last.why }, m: null };
  const elapsedMin = Math.max(0, Math.round((at.getTime() - Date.parse(m.startedAt)) / 60_000));
  const base = {
    name,
    ok: true,
    model: m.model,
    effort: m.model === 'kimi' ? null : m.effort,
    elapsedMin,
    lastLine: last.line,
    idleMin: last.idleMin,
    cleanedAt: m.cleanedAt,
    worktree: m.worktree,
    branch: m.branch,
    pr: null,
  };
  // pidUncertain：起的时候没能确认 pid（见文件头），没法调 io.isRunning——那需要一个真 pid，不能瞎猜。
  if (m.pidUncertain)
    return { s: { ...base, pidUncertain: true, pidUncertainWhy: m.pidUncertainWhy, pid: null }, m };
  return { s: { ...base, pidUncertain: false, running: io.isRunning(m.pid), pid: m.pid }, m };
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
    `  最后一句输出：${s.lastLine ?? '（还没有输出）'}${s.running && s.idleMin !== null && s.idleMin !== undefined ? `（${s.idleMin} 分钟前）` : ''}`,
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

// —— 巡看：只说变了的 ——

/** 在跑的工人这么久没往日志里写东西，巡看时算「没动静」报一次。 */
export const WATCH_STUCK_MIN = 30;

/** 一个工人此刻的状态压成一个词加它的 PR：巡看拿它和上次报过的比，一样就不出声。 */
export function watchState(s) {
  if (!s.ok) return { kind: 'unreadable', key: `unreadable|${s.why}` };
  const pr = s.pr.ok ? s.pr.rows.map((r) => `#${r.number}（${r.state}）`).join('、') : '';
  const last = s.lastLine ?? '';
  const kind = s.pidUncertain
    ? 'uncertain'
    : s.running
      ? s.idleMin !== null && s.idleMin !== undefined && s.idleMin >= WATCH_STUCK_MIN
        ? 'stuck'
        : 'running'
      : /^完成/.test(last)
        ? 'done'
        : /^卡住/.test(last)
          ? 'blocked'
          : 'dead';
  return { kind, key: `${kind}|${pr}`, pr, last };
}

function watchLine(s, st) {
  if (st.kind === 'unreadable') return `${s.name}：没查成——${s.why}`;
  const pr = st.pr ? `；PR ${st.pr}` : '';
  const last = st.last || '还没有输出';
  if (st.kind === 'running') return `${s.name} 在跑（${s.model}，${s.elapsedMin} 分钟）：${last}${pr}`;
  if (st.kind === 'stuck') return `${s.name} 还在跑，但 ${s.idleMin} 分钟没动静，最后在：${last}${pr}`;
  if (st.kind === 'done') return `${s.name} 做完了：${last}${pr}`;
  if (st.kind === 'blocked') return `${s.name} 卡住了：${last}${pr}`;
  if (st.kind === 'uncertain') return `${s.name} 不确定在跑没跑（起的时候没记上进程号）${pr}`;
  return `${s.name} 不在跑了、也没交活，最后一句：${last}${pr}`;
}

/**
 * 巡看（指挥官在自己的会话里用，#1016；创始人 2026-10-05：进度只在当前会话里报，不要出现在别的会话）：每个没 clean 的工人，状态和上次报过的不一样才出一行「变化：…」，
 * 并把这次的记进它目录里的 reported.json；最后一行总是「还在跑：N」——只有这一行就是没变化。
 * 工人脱离会话跑，没有谁会被它的完成通知叫醒；指挥官无人值守时循环跑它，有变化就在对话里报给创始人。
 * --wait <秒>：没变化就等，最多等这么久（上限 WATCH_WAIT_MAX_SEC：单次前台等待不超过 60 秒，创始人的插话在两次调用之间才送到）；
 * 一有变化马上返回。等的时候每 WATCH_POLL_MS 看一次，不烧模型额度。
 *
 * 整条命令有一个总截止：max(--wait, WATCH_GH_MS) + WATCH_SLACK_MS（2026-10-05 实测：5 个工人时 --wait 20 到 45 多次跑了
 * 58 秒以上被前台上限掐掉——原来看一遍要逐个排着调 gh，截止只管「睡」不管「看」，第一遍多久都得跑完）。现在看一遍里的 gh
 * 并发查、每次带超时，到截止还没回来的不等了；没查成的工人逐个说「没查成」、退出码 2，不当成没变化。
 */
export const WATCH_WAIT_MAX_SEC = 55;
export const WATCH_POLL_MS = 10_000;
/** 巡看里一次 gh 最多等这么久（gh pr list 平时一两秒）；--wait 不到这么久时，第一遍也给够这么久 */
export const WATCH_GH_MS = 10_000;
/** 整条命令最多比 max(--wait, WATCH_GH_MS) 多这么久：看一遍到截止前 1 秒收手，剩下的给收尾和输出 */
export const WATCH_SLACK_MS = 2_000;

async function cmdWatch(p, io) {
  if (p.positional.length > 0) throw new UsageError('watch 不收位置参数');
  const waitArg = p.options.get('wait');
  const waitSec = waitArg === undefined ? 0 : Number(waitArg);
  if (!Number.isInteger(waitSec) || waitSec < 0 || waitSec > WATCH_WAIT_MAX_SEC)
    throw new UsageError(`--wait 要是 0 到 ${WATCH_WAIT_MAX_SEC} 的整数秒，给的是「${waitArg}」`);
  const start = io.now().getTime();
  const deadline = start + waitSec * 1000;
  // 每一遍看都得在这之前收手（gh 的超时、没回来就不等，都照它）
  const lookEnd = start + Math.max(waitSec * 1000, WATCH_GH_MS) + WATCH_SLACK_MS - 1_000;
  for (;;) {
    const lookStart = io.now().getTime();
    const r = await watchOnce(io, lookEnd);
    if (typeof r === 'number') return r;
    const now = io.now().getTime();
    // 下一遍什么时候看：隔 WATCH_POLL_MS，不晚于 --wait 到点，也要按上一遍花的时间留出能看完的余地
    const nap = Math.min(WATCH_POLL_MS, deadline - now, lookEnd - (now - lookStart) - now);
    if (r.lines.length > 0 || r.code !== 0 || r.running === 0 || now >= deadline || nap <= 0) {
      for (const l of r.lines) io.out(l);
      io.out(`还在跑：${r.running}`);
      return r.code;
    }
    await io.sleep(nap);
  }
}

/**
 * 看一遍：变了的行、还在跑几个、退出码；工人目录读不了直接返回退出码。变了的当场记进 reported.json。
 * 各工人的 PR 并发查（io.ghAsync；外壳没给就退回一个一个的 io.gh），到 lookEnd 还没回来的不等，记成没查成。
 * PR 没查成的工人单独说一行「没查成：…」、退出码 2，也不记 reported.json（下次查成了照常比）。
 */
async function watchOnce(io, lookEnd) {
  let names = [];
  try {
    names = readdirSync(workersDir(io.home)).sort();
  } catch (e) {
    if (e.code !== 'ENOENT') return fail(io, `${workersDir(io.home)} 读不了（${e.code ?? e.message}）`);
  }
  const at = io.now();
  const looks = names.map((name) => ({ name, ...metaStatus(io, name, at) }));
  const live = looks.filter(({ s }) => !(s.ok && s.cleanedAt));
  await fillPrs(io, live, lookEnd);
  const lines = [];
  let running = 0;
  let code = 0;
  for (const { name, s } of live) {
    const st = watchState(s);
    if (!s.ok) code = 2;
    if (st.kind === 'running' || st.kind === 'stuck' || st.kind === 'uncertain') running += 1;
    if (s.ok && !s.pr.ok) {
      code = 2;
      lines.push(`没查成：${name} 的 PR（${s.pr.why}），这次看不出 PR 变没变；${watchLine(s, st)}`);
      continue;
    }
    const file = join(stateDir(io.home, name), 'reported.json');
    let before = null;
    try {
      before = JSON.parse(readFileSync(file, 'utf8')).key ?? null;
    } catch {
      // 没报过，或记录坏了：当没报过，多报一次比漏报好
    }
    if (before === st.key) continue;
    lines.push(`变化：${watchLine(s, st)}`);
    try {
      writeFileSync(file, `${JSON.stringify({ key: st.key, at: at.toISOString() })}\n`);
    } catch (e) {
      io.err(`${name} 的 reported.json 写不进（${e.code ?? e.message}）：下次巡看会再报一遍`);
    }
  }
  return { lines, running, code };
}

/** 并发查每个工人的 PR，填进 s.pr；到 lookEnd 没回来的、gh 超时的都填成没查成（说清多少秒），不当成「没有 PR」。 */
async function fillPrs(io, looks, lookEnd) {
  const asking = looks.filter(({ s }) => s.ok);
  const ghMs = Math.min(WATCH_GH_MS, lookEnd - io.now().getTime());
  const late = { ok: false, why: '到巡看的截止还没回话' };
  if (ghMs < 1_000) {
    for (const { s } of asking) s.pr = late;
    return;
  }
  const ghAsync = io.ghAsync ?? (async (args, opts) => io.gh(args, opts));
  const stop = new AbortController();
  const asks = asking.map(async ({ s, m }) => {
    let r;
    try {
      r = await ghAsync(prArgs(m), { ...prOpts(m), timeoutMs: ghMs, signal: stop.signal });
    } catch (e) {
      r = { status: null, stdout: '', stderr: '', error: e?.message ?? String(e) };
    }
    if (stop.signal.aborted) return;
    s.pr =
      r.error === 'ETIMEDOUT'
        ? { ok: false, why: `gh 超过 ${Math.round(ghMs / 1000)} 秒没回话` }
        : prFromResult(r);
  });
  let timer;
  const timeUp = new Promise((resolve) => {
    timer = setTimeout(resolve, Math.max(0, lookEnd - io.now().getTime()));
  });
  await Promise.race([Promise.all(asks), timeUp]);
  clearTimeout(timer);
  stop.abort();
  for (const { s } of asking) if (s.pr === null) s.pr = late;
}

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
 *   git(args, {cwd, proxy?, timeoutMs?}) → {status, stdout, stderr, error?}；proxy 为真时照原样带环境里的代理，
 *     不给或为假时去掉代理直连（见文件头「代理」那条）；timeoutMs 是这次调用的上限（不给用外壳的默认）,
 *   gh(args, {cwd, proxy?, timeoutMs?}) → 同上,
 *   ghAsync(args, {cwd, proxy?, timeoutMs?, signal?}) → Promise<同上>（可选；巡看并发查 PR 用，signal 叫停时当场杀掉子进程；
 *     没给就退回 gh 一个一个查）,
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
    if (cmd === 'watch') return await cmdWatch(parseArgs(rest, ['wait']), io);
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
