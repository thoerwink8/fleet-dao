// PreToolUse 钩子（agents-sync 装进 ~/.fleet-dao/hooks/，Claude Code 每次调 Bash、PowerShell、Read、Grep 之前跑）：
// 拦住绕过仓里脚本、会把本机会话全弄断、会把密钥文件的内容读进对话、会把别的进程的命令行（里面常有口令）打出来的调用。
// 只是止血：正式的强制点在仓里（packages/conventions、卫生检查），这里挡的是会话自己手滑。
// 协议：stdin 一份 JSON（tool_name、tool_input、cwd）；退出码 2 = 拦下，stderr 给模型看；0 = 放行。
// 输入认不出一律按拦处理（退出码 2），不当成没事放行。
// 规矩本身由 agents/test/rules/pretool.rules.test.ts 钉住：改这里的判断改了规矩，那边会红。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshBeforeSubagent, SUBAGENT_DIRECT_MS, SUBAGENT_FETCH_MS } from './fresh-main.mjs';
import { gitOk, gitRunner, gitWhy } from './git-run.mjs';
import { cleanId, DELIVERY_TOOLS, nagIfOwed, stateDir } from './unattended.mjs';

// 类型只写在 JSDoc 里（这份文件被同步工具原样装到各台机器、纯 node 直接跑，没有编译步骤）；agents/tsconfig.json 用 checkJs 过严格检查。
// 只标类型、不改判断：改判断就是改规矩，由 agents/test/rules/pretool.rules.test.ts 钉着。
/** @typedef {'bash' | 'powershell' | 'shell'} Kind 命令行是哪一种终端的写法（别家的终端不一定是 bash） */
/** @typedef {{ raw: string, value: string }} Word 一个词：raw 是原文（带引号、转义），value 是去掉引号转义之后的值 */
/** @typedef {{ words: Word[], redirects: Word[] }} SimpleCmd 一条简单命令：词和往文件写的重定向 */
/** @typedef {{ name: string, args: Word[], viaXargs: boolean }} Leaf 剥掉 sudo、env、xargs 这类前缀之后真正跑的命令 */
/** @typedef {{ text: string, kind: Kind, cwd?: string | undefined }} Nested ssh、wsl、bash -c、pwsh -Command、cmd /c 里的另一条命令行 */
/**
 * unwrap 的结果三选一：leaf（真正跑的命令）、nested（另一条命令行）、complex（看不清，写明为什么）。
 * 另外两个键都标成 ?: undefined，方便按有没有哪个键分开判。
 * @typedef {{ leaf: Leaf, nested?: undefined, complex?: undefined, name?: undefined, extra?: undefined, exclude: Set<Word> }
 *   | { leaf?: undefined, nested: Nested, complex?: undefined, name: string, extra?: Word[], exclude: Set<Word> }
 *   | { leaf?: undefined, nested?: undefined, complex: string, name?: undefined, extra?: undefined, exclude: Set<Word> }} Unwrapped
 */
/** @typedef {{ code: 2, message: string }} Block 拦下：退出码 2，message 给模型看 */
/** @typedef {{ code: 0 } | Block} Verdict 钩子的结论：放行或拦下 */
/** @typedef {{ stdoutSafe?: boolean, stdinViewer?: boolean, receiver?: boolean }} LineCtx checkLine 的上下文（见 checkLine 上面的说明） */
/** @typedef {{ u: Unwrapped, label: string | null, head: string | null }} CmdInfo 一条命令碰没碰到密钥路径、头一个词看不看得清 */
/** @typedef {{ why: string }} Why 这条命令为什么算「打印进程命令行」 */

/**
 * 抛出来的东西上的 message；不是对象就是 undefined。
 * @param {unknown} e
 */
const messageOf = (e) => (typeof e === 'object' && e !== null && 'message' in e ? e.message : undefined);
/**
 * 抛出来的东西上的 code（ENOENT 这类）；不是对象就是 undefined。
 * @param {unknown} e
 */
const errCode = (e) => (typeof e === 'object' && e !== null && 'code' in e ? e.code : undefined);
/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
const isObjectLike = (v) => typeof v === 'object' && v !== null;
/**
 * 取一个值上的属性（原来写的 o?.k）：不是对象就是 undefined。
 * @param {unknown} o
 * @param {string} k
 * @returns {unknown}
 */
const prop = (o, k) => (isObjectLike(o) ? o[k] : undefined);
/**
 * 叶子命令没有：原来读 leaf.name 会抛的就是这条 TypeError，上层 secretVerdict 接住按拦处理，拦下提示里带着这句话。
 * 显式写出来、文字不变（拦下提示的说法也就不变）。
 */
const missingLeaf = () => new TypeError("Cannot read properties of undefined (reading 'name')");

/** 只为记「起了后台活」才登记到这条钩子上的工具：不判、直接放行 */
export const BACKGROUND_ONLY_TOOLS = new Set(['Agent', 'Task', 'Monitor', 'Workflow']);

// bash 里反引号是「先把里面当命令跑」（命令替换）：只有单引号里、带引号的 heredoc（<<'EOF'）里才是普通字符。
// 双引号里、不带引号、不带引号的 heredoc 里出现没转义的反引号，就返回 true。
// 认 $( ) 套在双引号里的写法（git commit -m "$(cat <<'EOF' … EOF)" 这种不误拦）；算术 << 之类极少见的写法认错时只会漏拦、不会误拦。
/**
 * @param {unknown} cmd
 * @returns {boolean}
 */
export function bashBacktickSubst(cmd) {
  const s = String(cmd).replace(/\r\n/g, '\n');
  const n = s.length;
  /** @type {{ k: 'none' | 'sq' | 'dq', d: number }[]} 括号层：最底下那层是 none，只有 none 才数括号（d） */
  const stack = [{ k: 'none', d: 0 }];
  /** @type {{ delim: string, quoted: boolean, strip: boolean }[]} 还没读到正文的 heredoc */
  const pending = [];
  let i = 0;
  while (i < n) {
    const f = stack[stack.length - 1];
    // 最底下那层从不出栈（只有 sq、dq、括号层会弹）；真空了就明说，别往下读 undefined
    if (f === undefined) throw new RangeError('bashBacktickSubst 的括号栈空了（不该发生）');
    const c = s[i];
    if (f.k === 'sq') {
      if (c === "'") stack.pop();
      i++;
      continue;
    }
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '`') return true;
    if (c === '$' && s[i + 1] === '(') {
      stack.push({ k: 'none', d: 0 });
      i += 2;
      continue;
    }
    if (f.k === 'dq') {
      if (c === '"') stack.pop();
      i++;
      continue;
    }
    if (c === "'") {
      stack.push({ k: 'sq', d: 0 });
      i++;
      continue;
    }
    if (c === '"') {
      stack.push({ k: 'dq', d: 0 });
      i++;
      continue;
    }
    if (c === '$' && s[i + 1] === "'") {
      i += 2;
      while (i < n && s[i] !== "'") i += s[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if (c === '(') {
      f.d++;
      i++;
      continue;
    }
    if (c === ')') {
      if (f.d > 0) f.d--;
      else if (stack.length > 1) stack.pop();
      i++;
      continue;
    }
    if (c === '#' && (i === 0 || /[\s;&|(]/.test(s[i - 1] ?? ''))) {
      while (i < n && s[i] !== '\n') i++;
      continue;
    }
    if (c === '<' && s[i + 1] === '<' && s[i + 2] === '<') {
      i += 3;
      continue;
    }
    if (c === '<' && s[i + 1] === '<') {
      let j = i + 2;
      const strip = s[j] === '-';
      if (strip) j++;
      while (s[j] === ' ' || s[j] === '\t') j++;
      let delim = '';
      let quoted = false;
      while (j < n && !/[\s;&|<>()]/.test(s[j] ?? '')) {
        const d = s[j];
        if (d === "'" || d === '"') {
          quoted = true;
          j++;
          while (j < n && s[j] !== d) delim += s[j++];
          j++;
        } else if (d === '\\') {
          quoted = true;
          delim += s[j + 1] ?? '';
          j += 2;
        } else delim += s[j++];
      }
      if (delim) pending.push({ delim, quoted, strip });
      i = j;
      continue;
    }
    if (c === '\n' && pending.length > 0) {
      i++;
      for (const h of pending.splice(0)) {
        while (i < n) {
          let e = s.indexOf('\n', i);
          if (e === -1) e = n;
          const line = s.slice(i, e);
          i = e + 1;
          if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
          if (!h.quoted && /(^|[^\\])`/.test(line)) return true;
        }
      }
      continue;
    }
    i++;
  }
  return false;
}

/**
 * @param {string} message
 * @returns {Block}
 */
const block = (message) => ({ code: 2, message });

// —— 密钥文件：值不进对话 ——
// 2026-09-27 撞过：帅位想看 reclaude 的配置长什么样，for 循环把 ~/.reclaude/*.json 逐个 node -e 读出来、按字段名猜着遮值，
// 漏了设备密钥和一个账号名，原样打进了对话。命令碰到下面这些密钥路径时，只放行不读内容的（列目录、看权限、判断在不在），
// 看结构走同目录的 secret-shape.mjs（只打字段名、类型、长度）。挡的是会话手滑、不是存心绕：钩子看不清的写法
// （cd 进去、赋给变量、循环、$( )、脚本块）一律按拦处理。没碰到这些路径的命令一概不管（快路：先整条扫一遍名字）。

/**
 * reclaude 目录里写死了具体文件名时，这几个算密钥（设备密钥、账号名在 device.json 里），外加 backups/（它留的 Claude
 * 配置副本，带账号编号，docs/reclaude-self-check.md）；state.json、logs/ 不算，自检照读。目录本身、通配、变量、拆开写的一律算碰到
 */
const RECLAUDE_SECRETS = new Set(['device.json', 'device.key', 'ca.key', 'claude-ca-bundle.pem']);
/**
 * /etc/fleet-dao 是服务器上放密钥的地方（README「密钥和本机配置在哪」，root:fleet 750）：里面的一律算，不按文件名挑
 * （api.env、engine.env 之外还有飞书的 feishu.env、网关通行证 gateway-token.env、备份的 backup.env、目录配置 catalog.json、
 * 敏感值名单 sensitive-values.txt……）。这几个名字只拿来判 glob 限定得够不够（下面 SECRET_NAMES）。
 */
const FLEET_ETC_NAMES = [
  'api.env',
  'engine.env',
  'feishu.env',
  'gateway-token.env',
  'backup.env',
  'hk.env',
  'france.env',
  'temporal.env',
  'release.env',
  'catalog.json',
  'jev.json',
  'sensitive-values.txt',
];

/**
 * 仓根 .gitignore「密钥文件名单」那一段里，读出来不算漏值、所以这里不拦的；别的每一行这里都得拦。
 * agents/test/rules/pretool.rules.test.ts 抄了那一段逐行核对：.gitignore 加一行，这里和那边一起跟上。
 */
export const GITIGNORE_NOT_BLOCKED = {
  '*.age': '保险箱的密文：读出来不漏值，保险箱仓里天天要 git add、看 diff',
  '.env': '开发里 source .env、cp .env.example .env、--env-file 太常见，没出过事，先不加关卡',
  '.env.*': '同 .env',
};

/** 路径词前后的分界：空白、引号、反引号、分号、管道、括号、尖括号、逗号、等号、冒号、斜杠 */
const EDGE = String.raw`\\/\s'"\x60;|&()<>,=:`;
const DIR_REST = String.raw`(?<rest>/[^\s'"\x60;|&()<>,]*)?`;
const RECLAUDE_RE = new RegExp(String.raw`(?<![\w.-])\.reclaude(?![\w.-])${DIR_REST}`, 'gi');
const FLEET_ETC_RE = /(?<![\w.~-])\/etc\/fleet-dao(?![\w.-])/i;
const SECRETS_DIR_RE = /(?<![\w.-])\.secrets(?![\w.-])/i;
const NAMED_RE = new RegExp(
  String.raw`(?:^|[${EDGE}])(?<name>vault-key\.txt|id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?|\.pgpass|\.netrc|\.credentials\.json|\.git-credentials|sensitive-values\.txt)(?=$|[${EDGE}\]}])`,
  'i',
);
/** gh 没接系统钥匙串时把令牌明文存在这里（Linux 上常见） */
const GH_HOSTS_RE = /(?<![\w.-])\.config\/gh\/hosts\.yml(?![\w.-])/i;
const GENERIC_RE = new RegExp(
  String.raw`(?:^|[${EDGE}])[^${EDGE}\[\]{}$!+]*[^${EDGE}\[\]{}$!+.]\.(?:pass|key|pem|p12|pfx|ppk|kdbx|jks|keystore)(?=$|[${EDGE}\]}])`,
  'i',
);

/** @param {string} name */
function namedLabel(name) {
  const n = name.toLowerCase();
  if (n === 'vault-key.txt') return '保险箱的钥匙 vault-key.txt';
  if (n === '.credentials.json') return 'Claude 的登录凭据 .credentials.json';
  if (n.startsWith('id_')) return 'SSH 私钥';
  if (n === '.git-credentials') return 'git 存的口令 .git-credentials';
  if (n === 'sensitive-values.txt') return '已知敏感值名单 sensitive-values.txt（真实的账号、组织编号、IP）';
  return `口令文件 ${n}`;
}

/**
 * 放着登录凭据的点目录（各家 AI 命令行、SSH）：直接写在目录下的这几个文件名，和能匹配上它们的通配（cat ~/.ssh/*、
 * cat ~/.grok/*）都算。会话用户家里就有 cursor 的密钥、grok 的登录态（design 第十四节），开发机上还有 codex、gemini 的。
 */
const DOTDIR_RE = new RegExp(
  String.raw`(?<![\w.-])\.(?<dir>claude|ssh|codex|grok|gemini|cursor)(?![\w.-])${DIR_REST}`,
  'gi',
);
const DOTDIR_SECRETS = {
  claude: ['.credentials.json'],
  ssh: ['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'id_ecdsa_sk', 'id_ed25519_sk'],
  codex: ['auth.json'],
  grok: ['auth.json'],
  gemini: ['oauth_creds.json'],
  cursor: ['fleet-api-key'],
};
const DOTDIR_LABELS = {
  claude: 'Claude 的登录凭据 .credentials.json',
  ssh: 'SSH 私钥',
  codex: 'Codex 的登录凭据 ~/.codex/auth.json',
  grok: 'grok 的登录态 ~/.grok/auth.json',
  gemini: 'Gemini 的登录凭据 ~/.gemini/oauth_creds.json',
  cursor: 'cursor-agent 的 API 密钥 ~/.cursor/fleet-api-key',
};

/**
 * 通配（shell、rg、.gitignore 的写法）展开花括号后转成正则，整段比。* 也匹配点开头的名字：PowerShell、rg 都这样，
 * bash 不这样，按宽的算。认不出（括号不配对、展开太多）返回 null。
 * @param {string} glob
 * @returns {RegExp[] | null}
 */
function globRegexes(glob) {
  /** @type {string[]} */
  const expanded = [];
  /**
   * @param {string} g
   * @param {number} depth
   * @returns {void}
   */
  const expand = (g, depth) => {
    const m = /\{([^{}]*)\}/.exec(g);
    if (!m || depth > 4) expanded.push(g);
    else {
      for (const alt of (m[1] ?? '').split(','))
        expand(g.slice(0, m.index) + alt + g.slice(m.index + m[0].length), depth + 1);
    }
  };
  expand(glob, 0);
  // 花括号不配对：多半是命令里的逗号把路径词截断了（~/.ssh/{id_rsa,config}），看不清
  if (expanded.length > 64 || expanded.some((g) => /[{}]/.test(g))) return null;
  /** @type {RegExp[]} */
  const out = [];
  for (const g of expanded) {
    let re = '';
    for (let i = 0; i < g.length; i++) {
      const c = g[i] ?? '';
      if (c === '*') re += '.*';
      else if (c === '?') re += '.';
      else if (c === '[') {
        const end = g.indexOf(']', i + 2);
        if (end < 0) return null;
        const body = g
          .slice(i + 1, end)
          .replace(/^!/, '^')
          .replace(/\\/g, '\\\\');
        re += `[${body}]`;
        i = end;
      } else re += c.replace(/[.+^${}()|\\/]/g, '\\$&');
    }
    try {
      out.push(new RegExp(`^${re}$`, 'i'));
    } catch {
      return null;
    }
  }
  return out;
}

/**
 * 这个通配能不能匹配上 names 里的名字；认不出按能
 * @param {string} glob
 * @param {readonly string[]} names
 */
function globHits(glob, names) {
  const res = globRegexes(glob);
  return res === null || res.some((re) => names.some((n) => re.test(n)));
}

/**
 * 目录下的路径算不算碰到密钥：目录本身、子目录、通配、变量、. 和 .. 都算；写死的文件名交给 isSecret 判
 * @param {string | undefined} rest
 * @param {(parts: string[]) => boolean} isSecret
 */
function secretUnder(rest, isSecret) {
  if (!rest || rest === '/' || rest.endsWith('/') || /[*?[\]{}$~\x60]/.test(rest)) return true;
  const parts = rest.split('/').filter(Boolean);
  return parts.some((p) => p === '.' || p === '..') || isSecret(parts.map((p) => p.toLowerCase()));
}

/**
 * Windows 那头碰 WSL 里的文件写成 \\wsl.localhost\<发行版>\…、\\wsl$\<发行版>\…（还有 \\?\UNC\ 打头的）：反斜杠换成 / 之后把这截换成 /，
 * 剩下的就是 Linux 那头的路径。不换的话 /etc/fleet-dao 前面紧挨着发行版名，认不出来（Get-Content、Read 读得到里面的密钥）。
 */
const WSL_UNC_RE = /(?:\/[?.]\/unc)?\/wsl(?:\$|\.localhost)\/[^/\s'"\x60;|&()<>,]+/gi;

/**
 * 这段文字碰到了哪类密钥路径（给提示用的说法）；没碰到返回 null。反斜杠当路径分隔、再去掉转义和引号各看一遍
 * @param {unknown} text
 * @returns {string | null}
 */
export function secretMention(text) {
  const s = String(text);
  const slashed = s
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(WSL_UNC_RE, '/');
  for (const v of [slashed, s.replace(/[\\'"\x60]/g, '')]) {
    for (const m of v.matchAll(RECLAUDE_RE)) {
      if (secretUnder(m.groups?.rest, (p) => p[0] === 'backups' || RECLAUDE_SECRETS.has(p.at(-1) ?? ''))) {
        return '~/.reclaude/ 里 reclaude 的设备密钥和账号';
      }
    }
    if (FLEET_ETC_RE.test(v)) return '/etc/fleet-dao/ 里的密钥和配置';
    if (SECRETS_DIR_RE.test(v)) return '.secrets/ 里的密钥';
    const named = NAMED_RE.exec(v);
    if (named?.groups?.name) return namedLabel(named.groups.name);
    if (GH_HOSTS_RE.test(v)) return 'gh 的登录令牌 ~/.config/gh/hosts.yml';
    if (GENERIC_RE.test(v)) return '密钥文件（*.key、*.pem、*.pass 这类）';
    for (const m of v.matchAll(DOTDIR_RE)) {
      const parts = (m.groups?.rest ?? '').split('/').filter(Boolean);
      // DOTDIR_RE 里 dir 是必有的一组；没有就是正则被改坏了，抛出去（和原来读 undefined 抛 TypeError 一样不放行）
      const dirName = m.groups?.dir;
      if (dirName === undefined) throw new TypeError('DOTDIR_RE 没有 dir 这一组');
      const dir = /** @type {keyof typeof DOTDIR_SECRETS} */ (dirName.toLowerCase());
      const names = DOTDIR_SECRETS[dir];
      const [part] = parts;
      if (
        parts.length === 1 &&
        part !== undefined &&
        (/[*?[{]/.test(part) ? globHits(part, names) : names.includes(part.toLowerCase()))
      ) {
        return DOTDIR_LABELS[dir];
      }
    }
  }
  return null;
}

/**
 * 把命令切成管道和简单命令，只认词、引号、; && || | & 换行、往文件写的重定向。钩子看不清的写法（$( )、反引号、
 * 括号花括号、< 读入和 heredoc、PowerShell 的脚本块和表达式）记进 complex，照样往下切，好认出碰没碰到密钥路径。
 * 注释去掉：注释里写到的路径不算碰到。
 * @param {unknown} text
 * @param {Kind} kind
 * @returns {{ pipelines: SimpleCmd[][], complex: string[] }}
 */
function scanCommand(text, kind) {
  const ps = kind === 'powershell';
  const s = String(text).replace(/\r\n?/g, '\n');
  const n = s.length;
  /** @type {string[]} */
  const complex = [];
  /** @type {SimpleCmd[][]} */
  const pipelines = [];
  /** @type {SimpleCmd[]} */
  let pipe = [];
  /** @type {SimpleCmd} */
  let cmd = { words: [], redirects: [] };
  // 下面几个闭包里会改它：初始值带上类型，免得 TS 以为它一直是 null
  let word = /** @type {Word | null} */ (null);
  let redirect = false;
  let afterPipe = false;
  let inTest = false;
  /**
   * @param {string} raw
   * @param {string} [value]
   */
  const add = (raw, value = raw) => {
    word ??= { raw: '', value: '' };
    word.raw += raw;
    word.value += value;
  };
  const endWord = () => {
    if (word === null) return;
    if (redirect) {
      cmd.redirects.push(word);
      redirect = false;
    } else {
      cmd.words.push(word);
      if (!ps && cmd.words.length === 1 && word.raw === '[[') inTest = true;
      else if (inTest && word.raw === ']]') inTest = false;
    }
    word = null;
  };
  /** @param {boolean} piped */
  const endCmd = (piped) => {
    endWord();
    if (redirect) {
      complex.push('重定向后面没写文件');
      redirect = false;
    }
    if (cmd.words.length > 0 || cmd.redirects.length > 0) {
      pipe.push(cmd);
      cmd = { words: [], redirects: [] };
    } else if (piped || afterPipe) complex.push('管道的一头是空的');
    afterPipe = piped;
    inTest = false;
    if (!piped && pipe.length > 0) {
      pipelines.push(pipe);
      pipe = [];
    }
  };
  let i = 0;
  while (i < n) {
    const c = s[i] ?? '';
    const d = s[i + 1];
    if (c === ' ' || c === '\t') {
      endWord();
      i++;
    } else if (c === '\n') {
      if (!(afterPipe && word === null && cmd.words.length === 0)) endCmd(false);
      i++;
    } else if (c === '#' && word === null) {
      while (i < n && s[i] !== '\n') i++;
    } else if (c === (ps ? '`' : '\\')) {
      if (d !== '\n') add(s.slice(i, i + 2), d ?? '');
      i += 2;
    } else if (c === "'") {
      let j = i + 1;
      let v = '';
      for (;;) {
        const k = s.indexOf("'", j);
        if (k < 0) {
          complex.push('引号没收尾');
          v += s.slice(j);
          j = n;
          break;
        }
        v += s.slice(j, k);
        j = k + 1;
        if (!(ps && s[j] === "'")) break;
        v += "'";
        j++;
      }
      add(s.slice(i, j), v);
      i = j;
    } else if (c === '"') {
      let j = i + 1;
      let v = '';
      let closed = false;
      while (j < n) {
        const e = s[j];
        const f = s[j + 1] ?? '';
        if (e === '"' && ps && f === '"') {
          v += '"';
          j += 2;
        } else if (e === '"') {
          closed = true;
          j++;
          break;
        } else if (!ps && e === '\\') {
          v += '$`"\\'.includes(f) ? f : f === '\n' ? '' : e + f;
          j += 2;
        } else if (ps && e === '`') {
          v += f;
          j += 2;
        } else {
          if ((!ps && e === '`') || (e === '$' && f === '(')) complex.push('双引号里有 $( ) 或反引号');
          v += e;
          j++;
        }
      }
      if (!closed) complex.push('引号没收尾');
      add(s.slice(i, j), v);
      i = j;
    } else if (!ps && c === '$' && d === "'") {
      let j = i + 2;
      let v = '';
      while (j < n && s[j] !== "'") {
        v += s[j] === '\\' ? (s[j + 1] ?? '') : s[j];
        j += s[j] === '\\' ? 2 : 1;
      }
      if (j >= n) complex.push('引号没收尾');
      add(s.slice(i, j + 1), v);
      i = j + 1;
    } else if (c === '$' && d === '{') {
      const k = s.indexOf('}', i + 2);
      const inner = k < 0 ? s.slice(i) : s.slice(i, k + 1);
      if (k < 0 || /[`$(]/.test(inner.slice(2))) complex.push('变量展开里套了别的');
      add(inner);
      i += inner.length;
    } else if (c === '$' && d === '(') {
      complex.push('$( )');
      add('$(');
      i += 2;
    } else if ((!ps && c === '`') || (ps && word === null && (c === '@' || c === '['))) {
      complex.push(ps ? '@( )、[类型]:: 这类表达式' : '反引号');
      add(c);
      i++;
    } else if ('(){}'.includes(c) && !(inTest && (c === '(' || c === ')'))) {
      complex.push('括号、花括号');
      add(c);
      i++;
    } else if (c === '<' && !inTest) {
      // 从文件读入（sha256sum < 文件）照常认：读的那个文件和别的参数一样判；heredoc、<<<、<( )、<& 看不清
      if (ps || d === '<' || d === '(' || d === '&') complex.push('< 读入、heredoc');
      add(c);
      i++;
    } else if (c === '>' && !inTest) {
      if (word !== null && /^(?:\d+|\*)$/.test(word.raw)) word = null;
      let j = i + 1;
      if (s[j] === '>' || s[j] === '|') j++;
      endWord();
      if (s[j] === '&') {
        j++;
        while (j < n && /[\d-]/.test(s[j] ?? '')) j++;
      } else redirect = true;
      i = j;
    } else if (c === '&' && d === '&' && !inTest) {
      endCmd(false);
      i += 2;
    } else if (c === '&' && !inTest && !ps && d === '>') {
      endWord();
      redirect = true;
      i += s[i + 2] === '>' ? 3 : 2;
    } else if (c === '&' && !inTest && ps && word === null && cmd.words.length === 0) {
      i++; // PowerShell 的调用运算符：& 'C:\…\node.exe' …
    } else if (c === '&' && !inTest && ps) {
      complex.push('&');
      add(c);
      i++;
    } else if (c === '&' && !inTest) {
      endCmd(false);
      i++;
    } else if (c === '|' && d === '|' && !inTest) {
      endCmd(false);
      i += 2;
    } else if (c === '|' && !inTest) {
      endCmd(true);
      i += !ps && d === '&' ? 2 : 1;
    } else if (c === ';') {
      endCmd(false);
      i++;
    } else {
      add(c);
      i++;
    }
  }
  endCmd(false);
  return { pipelines, complex };
}

const BASH_KEYWORDS = new Set(
  'if then else elif fi for while until do done case esac select function coproc ! { }'.split(' '),
);

/**
 * 简单命令的头一个词为什么看不清（循环、赋值、拿变量当命令），看得清返回 null
 * @param {Word[]} words
 * @param {Kind} kind
 * @returns {string | null}
 */
function headProblem(words, kind) {
  const head = words[0];
  if (head === undefined) return null;
  if (kind !== 'powershell' && BASH_KEYWORDS.has(head.raw)) return `${head.raw} 这类循环、判断`;
  if (kind !== 'powershell' && /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/.test(head.raw)) return '变量赋值';
  if (head.value.startsWith('$')) return kind === 'powershell' ? '变量、表达式' : '拿变量当命令';
  return null;
}

/** @param {unknown} value */
function cmdName(value) {
  return (String(value).split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/, '');
}

/**
 * 跳过选项，返回头一个不是选项的词的下标；argOpts 里的选项吃掉下一个词（-u fleet；-ufleet 不吃）
 * @param {Word[]} words
 * @param {Set<string>} argOpts
 * @returns {number}
 */
function afterOptions(words, argOpts) {
  let i = 0;
  while (i < words.length) {
    const v = words[i]?.value ?? '';
    if (v === '--') return i + 1;
    if (!v.startsWith('-') || v === '-') return i;
    if (v.startsWith('--')) {
      i += !v.includes('=') && argOpts.has(v) ? 2 : 1;
      continue;
    }
    let takes = false;
    for (let k = 1; k < v.length; k++) {
      if (argOpts.has(`-${v[k]}`)) {
        takes = k === v.length - 1;
        break;
      }
    }
    i += takes ? 2 : 1;
  }
  return i;
}

/**
 * 照 getopt 的认法拆参数：-abc 一簇里 argShort 的字母吃掉这簇剩下的、没剩就吃下一个词（optShort 的只吃这簇剩下的，
 * 不吃下一个词：top 的 -w[宽度]）；--name 在 argLong 里、又没写 =值 的吃下一个词；-- 之后全是位置参数。
 * 返回 { flags（出现过的单字母）, longs（出现过的长选项，不带 =值）, positional }。吃掉的值不算选项：pgrep -ualice 里没有 -a。
 * @param {string[]} words
 * @param {Set<string>} argShort
 * @param {Set<string>} [argLong]
 * @param {Set<string>} [optShort]
 * @returns {{ flags: Set<string>, longs: string[], positional: string[] }}
 */
function getopt(words, argShort, argLong = new Set(), optShort = new Set()) {
  /** @type {Set<string>} */
  const flags = new Set();
  /** @type {string[]} */
  const longs = [];
  /** @type {string[]} */
  const positional = [];
  for (let i = 0; i < words.length; i++) {
    const v = words[i] ?? '';
    if (v === '--') {
      positional.push(...words.slice(i + 1));
      break;
    }
    if (v.startsWith('--')) {
      const name = v.includes('=') ? v.slice(0, v.indexOf('=')) : v;
      longs.push(name);
      if (!v.includes('=') && argLong.has(name)) i++;
      continue;
    }
    if (!v.startsWith('-') || v === '-') {
      positional.push(v);
      continue;
    }
    for (let k = 1; k < v.length; k++) {
      const c = v[k] ?? '';
      flags.add(c);
      if (optShort.has(c)) break;
      if (argShort.has(c)) {
        if (k === v.length - 1) i++;
        break;
      }
    }
  }
  return { flags, longs, positional };
}

/**
 * 长选项写成了 full 的哪一截前缀（getopt_long 认不冲突的缩写）：不短于 least 就算
 * @param {string} name
 * @param {string} full
 * @param {string} least
 */
const longIs = (name, full, least) => name.length >= least.length && full.startsWith(name);

/** @param {string} list */
const opts = (list) => new Set(list.split(' '));
const SUDO_ARGS = opts(
  '-u -g -h -p -C -D -R -T -U -r -t --user --group --host --prompt --chdir --role --type',
);
const XARGS_ARGS = opts(
  '-a -d -E -I -L -n -P -s --arg-file --delimiter --eof --replace --max-lines --max-args --max-procs --max-chars',
);
const SSH_ARGS = opts('-B -b -c -D -E -e -F -I -i -J -L -l -m -O -o -P -p -Q -R -S -W -w');
const SCP_ARGS = opts('-c -D -F -i -J -l -o -P -S -X');
/** @type {Record<string, Set<string>>} */
const PREFIX_ARGS = {
  nohup: opts(''),
  time: opts(''),
  command: opts(''),
  builtin: opts(''),
  exec: opts('-a'),
  setsid: opts(''),
  nice: opts('-n --adjustment'),
  ionice: opts('-c -n -p -t --class --classdata'),
  stdbuf: opts('-i -o -e --input --output --error'),
  timeout: opts('-s -k --signal --kill-after'),
  doas: opts('-u -C'),
};
const SH_NAMES = opts('bash sh zsh dash ksh ash');
/**
 * pwsh、powershell 吃掉下一个词的开关：[全名, 最短能认的那截]（PowerShell 源码 CommandLineParameterParser.cs 的 MatchSwitch，
 * pwsh 7.6 的 -? 对过）。开关名写全名的任一截前缀都算，只要不短于最短那截：-exec、-executionpolicy 都是 -ExecutionPolicy。
 * -Version 在 pwsh 7 里打完版本就退出，按 Windows PowerShell 5.1 的 -Version 2 算它吃一个。
 */
/** @type {[string, string][]} */
const PWSH_VALUE_SWITCHES = [
  ['version', 'v'],
  ['configurationfile', 'configurationfile'],
  ['configurationname', 'config'],
  ['custompipename', 'cus'],
  ['windowstyle', 'w'],
  ['outputformat', 'o'],
  ['of', 'o'],
  ['inputformat', 'inp'],
  ['if', 'if'],
  ['executionpolicy', 'ex'],
  ['ep', 'ep'],
  ['encodedarguments', 'encodeda'],
  ['ea', 'ea'],
  ['settingsfile', 'settings'],
  ['workingdirectory', 'wo'],
  ['wd', 'wd'],
  ['token', 'to'],
  ['utctimestamp', 'utc'],
];
const PWSH_DASHES = new Set(['-', '–', '—', '―']);

/** pwsh 的开关名（去掉前缀、小写）；不是开关返回 null。前缀 -、--、/ 和长横线（– — ―）都认（源码的 GetSwitchKey） */
/**
 * @param {string} v
 * @returns {string | null}
 */
function pwshSwitchKey(v) {
  const first = v[0];
  if (first === undefined || (first !== '/' && !PWSH_DASHES.has(first))) return null;
  return v.slice(first !== '/' && v[1] === first ? 2 : 1).toLowerCase();
}

/**
 * wsl.exe 自己的选项里吃掉下一个词的（`wsl --help`「运行 Linux 二进制文件的参数」「选项」两节，WSL 2.6.3 对过；区分大小写，
 * 不认 -d=名字）。别的 - 开头的（--list、--export、--install……）是管理分发版的，或者 wsl 不认、报错退出：都不在 Linux 里跑命令。
 */
const WSL_ARGS = opts('-d --distribution --distribution-id -u --user --cd --shell-type');

/**
 * 一个词照 Windows 命令行的引法写回去（Git Bash、PowerShell 7 起 wsl.exe 时都这么引）：空的、带空白或双引号的套双引号，
 * 里面的双引号前加反斜杠，紧挨在双引号前和词尾的反斜杠加倍
 */
/** @param {string} v */
function winQuote(v) {
  if (v !== '' && !/[\s"]/.test(v)) return v;
  return `"${v.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

/**
 * wsl 在 Linux 里跑的那条命令行：{ text, cd }（cd 是 --cd 后面那个词）；只开 shell、管理分发版、选项不对（wsl 报错退出）返回 null。
 * WSL 2.6.3 实测：不写 -e 时（写了 -- 也一样）wsl 把后面原样交给 Linux 那头的 bash 重新切一遍，所以词按 Windows 的引法拼回去，
 * 没套引号的词里的 ; | & 在那头照样生效（wsl -- printf %s 'a;echo' 跑了两条命令）；-e、--shell-type none 不经 shell、原样 exec，
 * 拼成每个词各加单引号的一条，切回来还是那几个词。-e 后面的全是命令；头一个词是 ~ 等于 --cd ~。
 * @param {Word[]} rest
 * @returns {{ text: string, cd: Word | undefined } | null}
 */
function wslRun(rest) {
  /** @type {Word | undefined} */
  let cd;
  let exec = false;
  let i = 0;
  if (rest[0]?.value === '~') {
    cd = rest[0];
    i = 1;
  }
  while (i < rest.length) {
    const v = rest[i]?.value ?? '';
    if (v === '--' || v === '-e' || v === '--exec') {
      exec ||= v !== '--';
      i++;
      break;
    }
    // --% 是 PowerShell 的「后面原样交出去」，不是 wsl 的选项
    if (v === '--system' || v === '--%') {
      i++;
      continue;
    }
    if (!WSL_ARGS.has(v)) {
      if (v.startsWith('-')) return null;
      break;
    }
    const arg = rest[i + 1];
    if (arg === undefined) return null;
    if (v === '--cd') cd = arg;
    if (v === '--shell-type') {
      if (!['standard', 'login', 'none'].includes(arg.value)) return null;
      exec = arg.value === 'none';
    }
    i += 2;
  }
  const words = rest.slice(i);
  if (words.length === 0) return null;
  /** @type {(x: Word) => string} */
  const quote = exec ? (x) => `'${x.value.replace(/'/g, "'\\''")}'` : (x) => winQuote(x.value);
  return { text: words.map(quote).join(' '), cd };
}

/** @param {Word[]} words */
const joinValues = (words) => words.map((x) => x.value).join(' ');

/**
 * 剥掉 sudo、env、xargs 这类前缀，拿到真正跑的命令：{ leaf }；ssh、wsl、bash -c、pwsh -Command、cmd /c 里的命令另算一条命令行：
 * { nested }（nested.cwd 是那条命令行在哪个目录跑：ssh 是那头的家目录，wsl 看 --cd，没写就是这头的会话目录）；看不清：{ complex }。
 * exclude 是不算「碰到」的词：ssh、scp 自己的选项（-i 指的钥匙是拿来用的，不打出来）和主机名。
 * @param {Word[]} words
 * @returns {Unwrapped}
 */
function unwrap(words) {
  /** @type {Set<Word>} */
  const exclude = new Set();
  let w = words;
  let viaXargs = false;
  for (let hop = 0; hop < 12; hop++) {
    const head = w[0];
    if (head === undefined) return { complex: '前缀后面没有命令', exclude };
    const name = cmdName(head.value);
    const rest = w.slice(1);
    if (name === 'sudo') {
      w = rest.slice(afterOptions(rest, SUDO_ARGS));
    } else if (name === 'env') {
      let i = 0;
      while (i < rest.length) {
        const v = rest[i]?.value ?? '';
        if (v === '-S' || v.startsWith('--split-string')) return { complex: 'env -S', exclude };
        if (v === '-u' || v === '-C' || v === '--unset' || v === '--chdir') i += 2;
        else if (v.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(v)) i++;
        else break;
      }
      w = rest.slice(i);
    } else if (Object.hasOwn(PREFIX_ARGS, name)) {
      // hasOwn 为真时一定有；?? 只为让类型跟上（不能改成 PREFIX_ARGS[name] !== undefined：name 是 constructor 这类时会读到原型上的东西）
      let i = afterOptions(rest, PREFIX_ARGS[name] ?? opts(''));
      if (name === 'timeout') i++;
      w = rest.slice(i);
    } else if (name === 'xargs') {
      viaXargs = true;
      w = rest.slice(afterOptions(rest, XARGS_ARGS));
      if (w.length === 0) return { leaf: { name: 'echo', args: [], viaXargs }, exclude };
    } else if (name === 'ssh') {
      const at = afterOptions(rest, SSH_ARGS);
      for (const x of rest.slice(0, at + 1)) exclude.add(x);
      const remote = rest.slice(at + 1);
      if (remote.length === 0) return { leaf: { name, args: rest, viaXargs }, exclude };
      return { nested: { text: joinValues(remote), kind: 'bash', cwd: '~' }, name, exclude };
    } else if (name === 'wsl') {
      const run = wslRun(rest);
      if (run === null) return { leaf: { name, args: rest, viaXargs }, exclude };
      // --cd 进了放密钥的目录：后面按相对路径读的是哪个文件，钩子看不清（和 cd ~/.reclaude && cat device.json 一样）
      if (run.cd && (secretMention(run.cd.raw) ?? secretMention(run.cd.value)) !== null) {
        return { complex: 'wsl --cd 进了放密钥的目录', exclude };
      }
      return { nested: { text: run.text, kind: 'bash', cwd: run.cd?.value }, name, exclude };
    } else if (SH_NAMES.has(name)) {
      let i = 0;
      let dashC = false;
      while (i < rest.length) {
        const v = rest[i]?.value ?? '';
        if (v === '--' || v === '-') {
          i++;
          break;
        }
        if (/^[-+][oO]$|^--(?:rcfile|init-file)$/.test(v)) i += 2;
        else if (v.startsWith('--')) i++;
        else if (/^[-+][A-Za-z]+$/.test(v)) {
          if (v[0] === '-' && v.includes('c')) dashC = true;
          i++;
        } else break;
      }
      if (!dashC) return { leaf: { name, args: rest, viaXargs }, exclude };
      const script = rest[i];
      if (script === undefined) return { complex: `${name} -c 后面没有脚本`, exclude };
      return { nested: { text: script.value, kind: 'bash' }, name, extra: rest.slice(i + 1), exclude };
    } else if (name === 'pwsh' || name === 'powershell') {
      let i = 0;
      while (i < rest.length) {
        const key = pwshSwitchKey(rest[i]?.value ?? '');
        // 不是开关：Windows PowerShell 5.1 把它连同后面的都当 -Command 的命令文字，pwsh 7 当 -File 的脚本
        if (key === null) {
          if (name !== 'powershell') break;
          return { nested: { text: joinValues(rest.slice(i)), kind: 'powershell' }, name, exclude };
        }
        /**
         * @param {string} full
         * @param {string} least
         */
        const is = (full, least) => key.length >= least.length && full.startsWith(key);
        // -CommandWithArgs：只有紧跟的那个词是命令，后面的是它的 $args
        if (is('commandwithargs', 'commandwithargs') || is('cwa', 'cwa')) {
          const script = rest[i + 1];
          if (script === undefined) return { complex: `${name} -CommandWithArgs 后面没有命令`, exclude };
          return {
            nested: { text: script.value, kind: 'powershell' },
            name,
            extra: rest.slice(i + 2),
            exclude,
          };
        }
        if (is('command', 'c')) {
          return { nested: { text: joinValues(rest.slice(i + 1)), kind: 'powershell' }, name, exclude };
        }
        if (is('encodedcommand', 'e') || is('ec', 'e')) return { complex: '-EncodedCommand', exclude };
        if (is('file', 'f')) break;
        i += PWSH_VALUE_SWITCHES.some(([full, least]) => is(full, least)) ? 2 : 1;
      }
      return { leaf: { name, args: rest, viaXargs }, exclude };
    } else if (name === 'cmd') {
      const at = rest.findIndex((x) => /^\/[ck]$/i.test(x.value));
      if (at < 0) return { leaf: { name, args: rest, viaXargs }, exclude };
      return { nested: { text: joinValues(rest.slice(at + 1)), kind: 'shell' }, name, exclude };
    } else {
      if (name === 'scp' || name === 'sftp') {
        rest.forEach((x, i) => {
          const next = rest[i + 1];
          if (SCP_ARGS.has(x.value) && next) exclude.add(next);
        });
      }
      return { leaf: { name, args: rest, viaXargs }, exclude };
    }
  }
  return { complex: '前缀套了太多层', exclude };
}

/**
 * 不读内容的：列目录、看属性、判断在不在、改权限、只往里写（tee）、只出摘要、用钥匙不打钥匙；拿它们碰密钥路径放行。
 * cp、mv 不在里面：拷到别处再读一遍就绕过去了（cp 到 /tmp 再 jq . 是顺手就会写的）。
 */
const NONREADING = opts(
  [
    'ls dir vdir tree stat test [ [[ file du wc readlink realpath basename dirname pwd echo printf true false :',
    'chmod chown chgrp getfacl lsattr mkdir touch tee',
    'sha1sum sha224sum sha256sum sha384sum sha512sum md5sum shasum b2sum cksum ssh-keygen ssh-add',
    'test-path get-item gi get-childitem gci get-itemproperty gp get-acl icacls attrib resolve-path rvpa split-path',
    'join-path write-output write write-host get-filehash new-item ni md',
  ].join(' '),
);
/** 只出摘要的：密钥往它这里送，屏幕上只有一串指纹（ops 第九节「核对：比指纹」） */
const HASHES = opts('sha1sum sha224sum sha256sum sha384sum sha512sum md5sum shasum b2sum cksum');
/** 只处理管道里传过来的文字（这里是文件名）的：和碰了密钥路径的命令接在一个管道里放行 */
const FILTERS = opts(
  [
    'grep egrep fgrep rg sort uniq head tail wc cut tr column nl fold tac rev awk gawk sed tee less more findstr',
    'select-object select sort-object format-table ft format-list fl format-wide fw measure-object measure',
    'out-string out-host oh out-null where-object where ? group-object group convertto-json convertto-csv',
  ].join(' '),
);
const VIEWER_RE = /(?:^|[\\/])secret-shape\.mjs$/i;

/**
 * node 跑的是不是 secret-shape.mjs：node <…/secret-shape.mjs> …，或者经管道喂进去的 node -（stdinViewer）
 * @param {Word[]} args
 * @param {LineCtx} ctx
 * @returns {boolean}
 */
function isViewerRun(args, ctx) {
  for (let i = 0; i < args.length; i++) {
    const v = args[i]?.value ?? '';
    if (v === '-') return ctx.stdinViewer === true;
    if (!v.startsWith('-')) return VIEWER_RE.test(v);
    if (/^(?:-e|--eval|-p|--print|-i|--interactive|-c|--check)$|^--(?:eval|print)=/.test(v)) return false;
    if (
      /^(?:-r|--require|--import|--loader|--experimental-loader|--env-file|--input-type|--conditions|-C)$/.test(
        v,
      )
    ) {
      i++;
    }
  }
  return false;
}

/** git 不读文件内容的子命令：看跟没跟踪、忽没忽略，加进、撤出暂存（git rm --cached 正是撤掉误提交的密钥）；-p 这类会打出改动的不算 */
/**
 * @param {Word[]} args
 * @returns {boolean}
 */
function gitNonReading(args) {
  let i = 0;
  while (i < args.length && (args[i]?.value ?? '').startsWith('-')) {
    i += /^(?:-C|-c|--git-dir|--work-tree|--namespace)$/.test(args[i]?.value ?? '') ? 2 : 1;
  }
  const sub = args[i]?.value ?? '';
  if (!['ls-files', 'check-ignore', 'status', 'add', 'rm', 'mv'].includes(sub)) return false;
  return !args
    .slice(i + 1)
    .some((x) => /^(?:-[A-Za-z]*[pie][A-Za-z]*|--patch|--interactive|--edit)$/.test(x.value));
}

/** grep、rg 只列文件名、只数个数、不出声（-l、-L、-c、-q 和长写法）：内容不上屏幕（ops 第五节 grep -c '^KEY=' 那样读回） */
/**
 * @param {Leaf} leaf
 * @returns {boolean}
 */
function quietSearch(leaf) {
  const isGrep = ['grep', 'egrep', 'fgrep'].includes(leaf.name);
  if (!isGrep && leaf.name !== 'rg') return false;
  const argShort = isGrep ? GREP_ARG_SHORT : RG_ARG_SHORT;
  const argLong = isGrep ? GREP_ARG_LONG : RG_ARG_LONG;
  for (let i = 0; i < leaf.args.length; i++) {
    const v = leaf.args[i]?.value ?? '';
    if (v === '--') return false;
    if (v.startsWith('--')) {
      if (QUIET_LONG.has(v.split('=')[0] ?? v)) return true;
      if (!v.includes('=') && argLong.has(v)) i++;
      continue;
    }
    if (!v.startsWith('-') || v === '-') continue;
    for (let k = 1; k < v.length; k++) {
      if (argShort.has(v[k] ?? '')) {
        if (k === v.length - 1) i++;
        break;
      }
      if ((isGrep ? 'lLcq' : 'lcq').includes(v[k] ?? '')) return true;
    }
  }
  return false;
}

/** @type {Record<string, Set<string>>} */
const COPY_ARGS = {
  cp: opts('-t -S --target-directory --suffix'),
  mv: opts('-t -S --target-directory --suffix'),
  install: opts('-m -o -g -t -S --mode --owner --group --target-directory --suffix'),
  scp: SCP_ARGS,
  rsync: opts('-e --rsh --exclude --include --filter -f'),
};

/** cp、mv、install、scp、rsync 只往密钥路径里写（碰到密钥路径的只有最后那个目标）：值不上屏幕，放密钥就是这么放的 */
/**
 * @param {Leaf} leaf
 * @returns {boolean}
 */
function copiesInto(leaf) {
  const argOpts = COPY_ARGS[leaf.name];
  if (!argOpts) return false;
  const words = leaf.args;
  if (words.some((x) => /^(?:-t|--target-directory)(?:=|$)/.test(x.value))) return false;
  /** @type {Word[]} */
  const positional = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const v = word?.value ?? '';
    if (v === '--') {
      positional.push(...words.slice(i + 1));
      break;
    }
    if (v.startsWith('-') && v !== '-') {
      if (argOpts.has(v)) i++;
      continue;
    }
    if (word !== undefined) positional.push(word);
  }
  // 选项的值（scp -i 指的钥匙、rsync -e 里的 ssh -i）是拿来用的，不算读；源里碰到密钥路径就是往外拷，不算
  if (positional.length < 2) return false;
  return positional.slice(0, -1).every((x) => (secretMention(x.raw) ?? secretMention(x.value)) === null);
}

/**
 * @param {Leaf | undefined} leaf
 * @param {LineCtx} ctx
 * @returns {boolean}
 */
function nonReading(leaf, ctx) {
  if (leaf === undefined) throw missingLeaf();
  if (NONREADING.has(leaf.name)) return true;
  if (leaf.name === 'node') return isViewerRun(leaf.args, ctx);
  // find 只列路径；-exec 这类会跑别的命令、-delete 会删、-fprint 这类会写
  if (leaf.name === 'find')
    return !leaf.args.some((x) => /^-(?:exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/.test(x.value));
  if (leaf.name === 'openssl') return leaf.args[0]?.value === 'x509';
  if (leaf.name === 'git') return gitNonReading(leaf.args);
  return quietSearch(leaf) || copiesInto(leaf);
}

/** cat / Get-Content 只读 secret-shape.mjs 这一个文件：往 ssh 那头的 node - 喂查看脚本 */
/**
 * @param {CmdInfo} info
 * @returns {boolean}
 */
function isViewerFeeder(info) {
  const leaf = info.u.leaf;
  if (!leaf || !['cat', 'type', 'gc', 'get-content'].includes(leaf.name)) return false;
  const files = leaf.args.filter((x) => !x.value.startsWith('-'));
  return files.length === 1 && VIEWER_RE.test(files[0]?.value ?? '');
}

const REDACTOR_RE = /(?:^|[\\/])redact-secrets\.mjs$/i;

/** 这个管道里有没有一段在跑 redactor：node <…/redact-secrets.mjs>（带 --env-file、-r 这类前置选项也认） */
/**
 * @param {SimpleCmd[]} pipeline
 * @returns {boolean}
 */
function redactorAt(pipeline) {
  for (const c of pipeline) {
    const u = unwrap(c.words);
    const leaf = u.leaf;
    if (!leaf) continue;
    if (!['node', 'nodejs'].includes(leaf.name)) continue;
    if (isViewerRun(leaf.args, {})) continue; // 认得出是 secret-shape.mjs 的那种写法
    for (let i = 0; i < leaf.args.length; i++) {
      const v = leaf.args[i]?.value ?? '';
      if (v === '--') {
        const next = leaf.args[i + 1];
        if (next !== undefined && REDACTOR_RE.test(next.value)) return true;
        break;
      }
      if (v.startsWith('--')) {
        if (
          !v.includes('=') &&
          /^--(?:require|import|loader|env-file|conditions|experimental-loader)$/.test(v)
        )
          i++;
        continue;
      }
      if (v.startsWith('-') && v !== '-') {
        if (/^-[ri]/.test(v) || /^-[CD]$/.test(v)) i++;
        continue;
      }
      if (REDACTOR_RE.test(v)) return true;
      break; // 头一个不是选项的词就是脚本名（或者 `-`），后面全是它的参数
    }
  }
  return false;
}

// —— 命令的输出里带密钥：打印进程命令行 ——
// 命令行把口令当参数交给别的进程之后，口令就落在那个进程的命令行里（Windows 的 Win32_Process.CommandLine、Linux 的
// /proc/<pid>/cmdline），而进程的命令行是公开的、谁都能读。于是「看现在有哪些进程」这条平常的命令会把它们整段打出来：
// 2026-10-02 就是这么漏的（Get-CimInstance Win32_Process 看 MCP 服务起了没，lark-mcp 那行的 -s <secret> 全打进了对话；
// 2026-09-30 那次是读 MCP 运行目录的 JSON，里面把飞书 app secret 写在参数里，当时那套遮值只认 40 个字符以上的串，
// 32 个字符的密钥过去了）。密钥文件那条（上面）只管「输入的路径」，管不到「命令的输出」，所以另立这一段。
//
// 得、程序名和 pid 不用管，但下面这几种写法一样把整条命令行打出来，认不出来就等于没有这一段：
// ps -ef、pgrep -a、pstree -a、top -c、tasklist /v、/proc/<pid>/cmdline、wmic process、Win32_Process、
// 挑出 CommandLine 那一列、systemctl status（CGroup 一节里每个进程一整行）。
//
// 这一段的处理是「拦住、给条明路」，不是「一律不许看」：看进程是调试的日常，不能堵死。要跑就接一条管道
// 把输出过 redactor（agents/hooks/redact-secrets.mjs，和这条钩子一起装进 ~/.fleet-dao/hooks/）：
//   ps -ef | node "$HOME/.fleet-dao/hooks/redact-secrets.mjs"
//   Get-CimInstance Win32_Process | node "$HOME/.fleet-dao/hooks/redact-secrets.mjs"
// 为什么不直接放行、让模型自己记得接管道：这一步是动作必经的那一步（design 第五节「发现问题当场修」），
// 人记不住、模型也记不住——两次都是从这条路上漏的。为什么不索性一律拦住（连接了管道的也拦）：那等于把看进程
// 变得做不了，而凭据根本不在命令行里的那九成情况也跟着遭殃；接上管道之后屏幕上确实没有值了，再拦没有意义。
// 认不出一律按拦处理（和这份文件别的段落一样）：看不清管道接了什么，就当没接。

/** 这段 ps 参数里有没有要求打命令行：-e -f -w -x，或者 -o / --format 后面写了 cmd / args / command */
const PS_CMDLINE_SHORT = new Set([...'efwx']);
/** cmd、args、command 是整条命令行；comm 只是程序名（ps -eo pid,comm），不带参数，不算 */
const PS_CMDLINE_COLUMN = /\b(?:cmd|args?|command)\b/i;

/**
 * @param {Word[]} args
 * @returns {boolean}
 */
function psPrintsCommandLine(args) {
  const words = args.map((x) => x.value);
  for (const v of words) if (/^(?:aux|ef|ew|auxww|efww)$/i.test(v)) return true;
  // 先看有没有 -o/--format：写了它，打哪几列就由格式串说了算，别的短选项（-e、-f、-w、-x）不再单独算数
  /** @type {string | null} */
  let format = null;
  for (let i = 0; i < words.length; i++) {
    const v = words[i] ?? '';
    if (v === '--') break;
    if (/^--format(?:=|$)/.test(v)) {
      format = v.includes('=') ? v.slice(v.indexOf('=') + 1) : (words[i + 1] ?? '');
      continue;
    }
    if (!v.startsWith('-') || v === '-') continue;
    const at = v.search(/[oO]/);
    if (at >= 0) format = at === v.length - 1 ? (words[i + 1] ?? '') : v.slice(at + 1);
  }
  if (format !== null) return PS_CMDLINE_COLUMN.test(format);
  // 没写格式串的短选项：-e、-f、-w、-x 各自都能带出命令行（-f 最典型：UID PID PPID C STIME TTY TIME CMD）
  for (const v of words) {
    if (!v.startsWith('-') || v.startsWith('--') || v === '-') continue;
    for (const c of v.slice(1)) if (PS_CMDLINE_SHORT.has(c)) return true;
  }
  return false;
}

/** pgrep 吃掉一个值的选项（procps-ng src/pgrep.c 的 opts、longopts）：-u alice 的 alice 不是 -a */
const PGREP_ARGS = new Set([...'dgGpPOstuUFrq']);
const PGREP_LONG_ARGS = opts(
  '--signal --cgroup --delimiter --pgroup --group --older --pid --parent --session --terminal --euid --uid --pidfile --ns --nslist --queue --runstates --env',
);
/** pstree 吃掉一个值的选项：-C 颜色、-H 高亮的 pid、-N 名字空间 */
const PSTREE_ARGS = new Set([...'CHN']);
/** top 吃掉一个值的选项（procps-ng top 的 getopt 串 "bcd:E:e:Hhin:Oo:p:SsU:u:Vw::1"）；-w 的宽度只能紧贴着写 */
const TOP_ARGS = new Set([...'dEenopUu']);

/**
 * systemctl 的子命令里会打出进程命令行的（systemctl 1 的 man、systemd 254 实测）：
 * - status：活动状态后面就是 CGroup 一节，每行是「PID 完整命令行」，服务里跑的进程带的口令（--token、-s、连接串）整段打出来；
 * - show：不写 -p 时打全部属性，其中有 ExecStart（老版本 systemd < 239 写成 ExecStart={ 路径 ; 参数… }，参数一并在里面）、
 *   ExecMainStartTimestamp、ExecMainPID（MainPID 是主进程的 pid，进程一退就没了，也打）；挑列看的那几种写法另有 COMMANDLINE_COLUMN_RE 管；
 * - cat：把 unit 文件原样打出来，ExecStart= 那一行连参数一起；dump：内部状态，同样带 ExecStart 和 ExecMain*。
 * 不打的放行：is-active、is-enabled、is-failed（一个词）、start / stop / restart（动作）、list-units、list-unit-files、
 * list-dependencies（只有单元名）、enable、mask……「挑一条属性看」（show -p ActiveState）也算只打状态，见下面 execPropertyPicked。
 */
const SYSTEMCTL_PRINTS = new Set(['status', 'show', 'cat', 'dump']);
/** systemctl 的全局选项里吃掉一个值的（systemctl 1）：--property 的 =值 和 -p 的值都在这里认，别的开关不吃后面的词 */
const SYSTEMCTL_VALUE_LONG = opts('--property');
/** systemctl 的短选项里吃掉一个值的：-H 主机、-M 容器、-p 属性（-pH、-Hfr 这类紧贴着写的也认） */
const SYSTEMCTL_VALUE_SHORT = new Set([...'HMp']);
/** systemctl show 的 -p / --property 后面挑的属性名里，有这些就是命令行（老版本 systemd 的 ExecStart={ 参数… } 也认前缀） */
const SYSTEMCTL_EXEC_PROP =
  /^(?:ExecStart|ExecStop|ExecReload|ExecStartPre|ExecStartPost|ExecStopPost|ExecCondition|ExecMainPID|ExecMainStartTimestamp|MainPID)$/i;

/**
 * systemctl show 挑的这几条属性里有没有带命令行的：挑过（写了 -p / --property）且一条带命令行的都没有，才算「只打状态」放行。
 * 没挑过（show 后面什么都没写）打印全部属性、里面有 ExecStart，返回 true。属性值跟着 -p 一起写在值里面，按逗号、空格切开看。
 */
/**
 * @param {Word[]} args
 * @returns {boolean}
 */
function showPicksExecProps(args) {
  /** @type {string[]} */
  const picked = [];
  let sawP = false;
  for (let i = 0; i < args.length; i++) {
    const v = args[i]?.value ?? '';
    if (v === '--') break;
    if (v.startsWith('--property')) {
      sawP = true;
      const val = v.includes('=') ? v.slice(v.indexOf('=') + 1) : (args[++i]?.value ?? '');
      picked.push(...val.split(','));
      continue;
    }
    if (!v.startsWith('-') || v === '-') continue;
    const at = v.indexOf('p'); // -p 就是挑属性；写成 -tp 也只多认一个 p（systemctl 没有吃值的 t）
    if (at < 1) continue;
    sawP = true;
    const rest = v.slice(at + 1);
    picked.push(...(rest === '' ? (args[++i]?.value ?? '') : rest).split(','));
  }
  // 没挑过属性 = 全部属性都打（里面有 ExecStart）；挑过但一条带命令行的都没有 = 只看状态，放行
  if (!sawP) return true;
  return picked.some((p) => SYSTEMCTL_EXEC_PROP.test(p.trim()));
}

/** systemctl 的整个命令行会不会把进程命令行打出来：不是 systemctl 返回 null；是就返回 { why } */
/**
 * @param {Word[]} args
 * @returns {Why | null}
 */
function systemctlPrintsCommandLine(args) {
  // 子命令前面可以写全局选项（systemctl --user status …）：--property 和 -H、-M、-p 各吃一个值，其余开关不吃后面的词
  let i = 0;
  while (i < args.length) {
    const v = args[i]?.value ?? '';
    if (v === '--') {
      i++;
      break;
    }
    if (!v.startsWith('-') || v === '-') break;
    if (v.startsWith('--')) {
      i += !v.includes('=') && SYSTEMCTL_VALUE_LONG.has(v) ? 2 : 1;
      continue;
    }
    const takes = [...v.slice(1)].findIndex((c) => SYSTEMCTL_VALUE_SHORT.has(c)) === v.length - 2;
    i += takes ? 2 : 1;
  }
  const sub = args[i]?.value.toLowerCase();
  if (sub === undefined || !SYSTEMCTL_PRINTS.has(sub)) return null;
  if (sub === 'show' && !showPicksExecProps(args.slice(i + 1))) return null;
  return {
    why: `systemctl ${sub} 打出了进程的命令行（${sub === 'status' ? 'CGroup 一节里每个进程一整行' : 'ExecStart= 那一行'})`,
  };
}

/**
 * 这条叶子命令会不会把某个进程的命令行打出来：是就返回 { why }（why 是拦下时告诉模型是哪一条），不是返回 null。
 * 只看写死的写法；拿变量当命令、或者把输出再加工一道的看不出来——那是这一段的边界，说清楚比假装拦住了好。
 * 只打进程名和 pid 的放行：tasklist（不带 /v）、Get-Process（不挑 CommandLine）、pgrep（-l 只打进程名，procps-ng 的
 * pgrep.c 里 -l 打的是 CMD、-a 才是整条 cmdline）、pstree（不带 -a）、top（不带 -c，默认只打程序名；~/.toprc 里存了
 * 「显示命令行」的认不出，这也是边界）、systemctl（status / show / cat / dump 之外的子命令只打状态或只报成败）。
 */
/**
 * @param {Leaf | undefined} leaf
 * @returns {Why | null}
 */
function printsCommandLines(leaf) {
  if (!leaf) return null;
  const words = leaf.args.map((x) => x.value);
  if (leaf.name === 'ps') return psPrintsCommandLine(leaf.args) ? { why: 'ps 打出了进程的命令行' } : null;
  if (leaf.name === 'pgrep') {
    const o = getopt(words, PGREP_ARGS, PGREP_LONG_ARGS);
    const full = o.flags.has('a') || o.longs.some((l) => longIs(l, '--list-full', '--list-f'));
    return full ? { why: 'pgrep -a 打出了进程的整条命令行' } : null;
  }
  if (leaf.name === 'pstree') {
    const o = getopt(words, PSTREE_ARGS);
    const args = o.flags.has('a') || o.longs.some((l) => longIs(l, '--arguments', '--ar'));
    return args ? { why: 'pstree -a 打出了每个进程的命令行参数' } : null;
  }
  if (leaf.name === 'top') {
    const o = getopt(words, TOP_ARGS, new Set(), new Set(['w']));
    const full = o.flags.has('c') || o.longs.some((l) => longIs(l, '--cmdline-toggle', '--c'));
    return full ? { why: 'top -c 打出了进程的命令行' } : null;
  }
  if (leaf.name === 'systemctl') return systemctlPrintsCommandLine(leaf.args);
  // /v 多出来的「窗口标题」一列：cmd 窗口跑着命令时，标题就是「cmd.exe - 那条命令行」。Git Bash 里得写 //v（单斜杠会被当路径改写）
  if (leaf.name === 'tasklist') {
    const verbose = words.some((v) => /^(?:\/\/?|-)v$/i.test(v));
    return verbose ? { why: 'tasklist /v 打出了窗口标题（cmd 窗口的标题里就是正在跑的那条命令行）' } : null;
  }
  if (leaf.name === 'wmic') {
    const sub = words.find((v) => !v.startsWith('-')) ?? '';
    return /^process(?:_get)?$/i.test(sub) ? { why: 'wmic process 打出了进程的命令行' } : null;
  }
  if (['get-ciminstance', 'get-wmiobject', 'gcim', 'gwmi'].includes(leaf.name)) {
    const cls = words.find((v) => !v.startsWith('-')) ?? '';
    return /^(?:win32_)?process$/i.test(cls) ? { why: `${cls} 打出了进程的命令行` } : null;
  }
  return null;
}

/** 读 /proc 下某个进程的 cmdline（写死路径、通配都算）：那里就是那个进程的整条命令行 */
const PROC_CMDLINE_RE = /\/proc\/(?:[^/\s'"\x60|&;<>]*\/)*cmdline(?![\w.-])/i;
/** PowerShell 里挑出命令行这一列：Select-Object CommandLine、Format-List CommandLine… */
const COMMANDLINE_COLUMN_RE =
  /(?:^|[\s|,;([{-])(?:select-object|select|format-table|format-list|format-wide|ft|fl|fw|where-object|where|sort-object|sort)\s[^|;\n]*\bCommandLine\b/i;

/**
 * 这条命令行里为什么算「打印进程命令行」；不像返回 null。text 是这一层命令行的原文
 * @param {unknown} text
 * @param {Kind} kind
 * @returns {Why | null}
 */
function processListing(text, kind) {
  const flat = String(text).replace(/\\/g, '/');
  if (PROC_CMDLINE_RE.test(flat)) return { why: '读了 /proc 下的 cmdline（那里是那个进程的整条命令行）' };
  if (COMMANDLINE_COLUMN_RE.test(String(text)))
    return { why: '挑出了 CommandLine 这一列（命令行就在这一列里）' };
  for (const c of scanCommand(text, kind).pipelines.flat()) {
    const u = unwrap(c.words);
    if (u.nested) {
      const inner = processListing(u.nested.text, u.nested.kind);
      if (inner !== null) return inner;
      continue;
    }
    const hit = printsCommandLines(u.leaf);
    if (hit !== null) return hit;
  }
  return null;
}

/**
 * 值往这里送就不过屏幕：ssh 到别的机器（ops 第九节「值不过屏幕」那几条管道）、只出摘要的
 * @param {CmdInfo} info
 * @returns {boolean}
 */
function isSink(info) {
  return info.u.name === 'ssh' ? info.u.nested !== undefined : HASHES.has(info.u.leaf?.name ?? '');
}

/**
 * @param {SimpleCmd} c
 * @param {Kind} kind
 * @returns {CmdInfo}
 */
function describeCmd(c, kind) {
  const u = unwrap(c.words);
  const label = c.words
    .filter((x) => !u.exclude.has(x))
    .reduce(
      (found, x) => found ?? secretMention(x.raw) ?? secretMention(x.value),
      /** @type {string | null} */ (null),
    );
  return { u, label, head: headProblem(c.words, kind) };
}

const SHAPE = '"$HOME/.fleet-dao/hooks/secret-shape.mjs"';

/** 拦下时第一行就要说清怎么办：Grok 只把 stderr 的第一行交给模型（~/.grok/docs/user-guide/10-hooks.md「Exit Codes」） */
const SECRET_WAY = `看结构用 node ${SHAPE} <文件>（只打字段名、类型、长度，一个值都不打），看在不在、权限用 stat、test -f、Test-Path`;

/**
 * @param {string} label
 * @param {string} [why]
 * @returns {Block}
 */
function secretBlock(label, why) {
  return block(
    [
      `fleet-guard：这条命令碰到了${label}${why ? `，又${why}` : ''}，按拦处理（密钥、令牌、口令的值不进对话）；${SECRET_WAY}。`,
      '碰到密钥文件只放行不读内容的：ls、stat、test、Test-Path、Get-Item 这类看在不在、看权限的，单独一条跑（别 cd 进去、别赋给变量、别套循环或 $( )）。',
      `查看脚本认 JSON、env、PEM；别的机器上的文件：cat ${SHAPE} | ssh <机器> 'node --input-type=module - <文件>'；WSL 里的：cat ${SHAPE} | wsl -d <发行版> -- node --input-type=module - <文件>。`,
      '提交信息、PR 正文里要写这些路径：先用 Write 写进文件，再 -F / --body-file；在代码里搜这些名字用 Grep 工具。',
    ].join('\n'),
  );
}

/**
 * checkLine 的结论：碰到了、都不读内容，放行
 * @type {{ code: 0 }}
 */
const CLEAN = { code: 0 };

/** 管道那头的远端脚本里，命令前面这些词剥掉再看后面那条命令 */
const RECEIVER_SKIP = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!']);

/**
 * 一条命令行里碰到密钥路径的命令是不是都不读内容：每条碰到的叶子命令不读内容（或者它的输出直接送进 ssh、摘要）；
 * 和它接在一个管道里的只能是不读内容的、只处理文字的（xargs 后面那条得不读内容）。ctx.stdoutSafe：这条命令行的输出
 * 本身就送进了 ssh、摘要；ctx.stdinViewer：标准输入是 secret-shape.mjs。
 * 返回 null：一处都没碰到；CLEAN：碰到了、放行；否则是 block。
 * @param {string} text
 * @param {Kind} kind
 * @param {LineCtx} ctx
 * @param {number} depth
 * @returns {Verdict | null}
 */
function checkLine(text, kind, ctx, depth) {
  if (depth > 4) return secretBlock('密钥路径', '套了太多层 ssh / bash -c');
  const { pipelines, complex } = scanCommand(text, kind);
  // 管道那头接着值的远端脚本（… | ssh 机器 '…'，ops 第九节「值不过屏幕」把值落进 /etc/fleet-dao 的那几条）：它往密钥路径里写，
  // 用变量、$( )、if 是常事。这里不管看不清的写法，只看写死了密钥路径的命令读不读内容（if/then 这类剥掉再看，赋值、看不清的跳过）
  const receiver = ctx.receiver === true;
  const infos = pipelines.map((p) =>
    p.map((c) => {
      if (!receiver) return describeCmd(c, kind);
      let n = 0;
      while (n < c.words.length && RECEIVER_SKIP.has(c.words[n]?.raw ?? '')) n++;
      return describeCmd({ ...c, words: c.words.slice(n) }, kind);
    }),
  );
  const hit = infos.flat().find((x) => x.label !== null);
  if (hit === undefined) return null;
  const unclear = receiver
    ? undefined
    : (complex[0] ??
      infos.flat().find((x) => x.head !== null)?.head ??
      infos.flat().find((x) => x.u.complex)?.u.complex);
  // hit 是上面按 label !== null 找出来的，所以 label 一定有；?? 只为让类型跟上
  const hitLabel = hit.label ?? '';
  if (unclear) return secretBlock(hitLabel, `用了钩子看不清的写法（${unclear}）`);
  for (const p of infos) {
    const last = p.length - 1;
    for (let i = 0; i <= last; i++) {
      const x = p[i];
      if (x === undefined || x.label === null) continue;
      if (receiver && (x.head !== null || x.u.complex)) continue;
      const nextInfo = p[i + 1];
      const toSink =
        (i < last && nextInfo !== undefined && isSink(nextInfo)) || (i === last && ctx.stdoutSafe === true);
      if (x.u.nested) {
        if ((x.u.extra ?? []).some((a) => secretMention(a.raw) ?? secretMention(a.value))) {
          return secretBlock(x.label, `把它当参数传给 ${x.u.name} -c 里的脚本`);
        }
        const prevInfo = p[i - 1];
        const viewer = i > 0 && prevInfo !== undefined && isViewerFeeder(prevInfo);
        const r = checkLine(
          x.u.nested.text,
          x.u.nested.kind,
          { stdoutSafe: toSink, stdinViewer: viewer, receiver: i > 0 && x.u.name === 'ssh' },
          depth + 1,
        );
        // 外层看得见、拆出来的那条命令行里却找不到了（多半是转义把反斜杠吃了）：看不清就按拦处理
        if (r === null) return secretBlock(x.label, `用了 ${x.u.name} 转手、拆开后钩子对不上路径`);
        if (r !== CLEAN) return r;
      } else if (!nonReading(x.u.leaf, ctx) && !toSink) return secretBlock(x.label);
    }
    const first = p.find((x) => x.label !== null);
    if (first === undefined || p.length === 1) continue;
    const firstLabel = first.label ?? '';
    for (let j = 0; j <= last; j++) {
      const x = p[j];
      if (x === undefined || x.label !== null || isViewerFeeder(x)) continue;
      if (j > 0 && p[j - 1]?.label !== null && isSink(x)) continue;
      if (x.u.nested) {
        if (x.u.name === 'ssh') continue;
        return secretBlock(firstLabel, `把它接进管道交给 ${x.u.name}`);
      }
      const leaf = x.u.leaf;
      if (leaf === undefined) throw missingLeaf();
      const ok =
        nonReading(leaf, ctx) ||
        (!leaf.viaXargs && (FILTERS.has(leaf.name) || (kind === 'bash' && leaf.name === 'cat')));
      if (!ok)
        return secretBlock(
          firstLabel,
          `把它接进管道交给 ${leaf.viaXargs ? `xargs ${leaf.name}` : leaf.name}`,
        );
    }
  }
  return CLEAN;
}

/**
 * 碰到密钥文件的命令判一下：没碰到、或者只列目录看权限，返回 null；要把内容打出来的返回 block
 * @param {string} command
 * @param {Kind} kind
 * @returns {Block | null}
 */
function secretVerdict(command, kind) {
  const label = secretMention(command);
  if (label === null) return null;
  try {
    const r = checkLine(command, kind, {}, 0);
    return r === null || r === CLEAN ? null : /** @type {Block} */ (r);
  } catch (err) {
    return secretBlock(label, `钩子没看懂这条命令（${messageOf(err) ?? err}）`);
  }
}

/** redactor 装在哪（和这条钩子同一个目录，agents-sync 整份拷过去） */
const REDACT = '"$HOME/.fleet-dao/hooks/redact-secrets.mjs"';
/** 拦下时给的那几条照着敲的命令：把进程列表接上它 */
const REDACT_RECIPE = [
  `把输出接一条管道过它（把 -s / --secret / --token / --password 的值、名字带 secret/token 的字段换成 ***）：`,
  `  ps -ef | node ${REDACT}`,
  `  Get-CimInstance Win32_Process | node ${REDACT}`,
  `  ... | node ${REDACT} | grep lark-mcp（后面还要接 head、grep、Select-Object 的，接在它后面）`,
  `  要看的是文件里的进程列表：node ${REDACT} <文件>`,
].join('\n');

/**
 * @param {string} why
 * @returns {Block}
 */
function processBlock(why) {
  return block(
    [
      `fleet-guard：这条命令${why}，进程的命令行里常常带着别的进程的口令（命令行交给进程之后，它就落在那个进程的命令行里，谁都能读：MCP 服务的 -s <secret>、--token、数据库口令），按拦处理（密钥、令牌、口令的值不进对话）。`,
      REDACT_RECIPE,
      '只看进程名和 pid 的打法不用它：ps -A、ps -l、ps -eo pid,comm、pgrep（-l 只打进程名，不带 -a）、pstree -p（不带 -a）、top（不带 -c）、tasklist（不带 /v）、Get-Process（不挑 CommandLine）、systemctl is-active / show -p ActiveState（挑的这几条属性里没有命令行）。',
    ].join('\n'),
  );
}

/**
 * redactor 在不在这条命令行里：整条命令行（含 ssh 那头、bash -c 里头）任一段管道跑的是 redact-secrets.mjs 就算。
 * 判的是「这条命令行里有没有它」，不是「它接在哪个位置」——接错位置（接在不打进程列表的那一段后面）等于没接，
 * 那种写法本来就该按拦处理，这里不为它开例外。
 * @param {string} command
 * @param {Kind} kind
 * @param {number} [depth]
 * @returns {boolean}
 */
function hasRedactor(command, kind, depth = 0) {
  if (depth > 4) return false;
  for (const c of scanCommand(command, kind).pipelines) {
    if (redactorAt(c)) return true;
    for (const leaf of c) {
      const u = unwrap(leaf.words);
      if (u.nested && hasRedactor(u.nested.text, u.nested.kind, depth + 1)) return true;
    }
  }
  return false;
}

/**
 * 打印进程命令行的命令判一下：不是这类返回 null；认不出（钩子没看懂这条命令）也按拦处理
 * @param {string} command
 * @param {Kind} kind
 * @returns {Block | null}
 */
function processListingVerdict(command, kind) {
  /** @type {Why | null} */
  let hit;
  try {
    hit = processListing(command, kind);
  } catch (err) {
    return block(`fleet-guard：钩子没看懂这条看进程的命令（${messageOf(err) ?? err}），按拦处理`);
  }
  if (hit === null) return null;
  try {
    if (hasRedactor(command, kind)) return null;
  } catch {
    return processBlock(`${hit.why}，钩子又没看懂这条命令的管道`);
  }
  return processBlock(hit.why);
}

// —— 从上层目录往下搜 ——
// 上面按名字认，认的是写出来的密钥路径。从家目录（或更上层）、~/.claude、~/.ssh 往下搜内容，路径里一个名字都不出现，
// 却会把 ~/.reclaude/device.json、~/.claude/.credentials.json、~/.ssh/id_* 一起搜出来：Claude 的 Grep 连点开头的隐藏文件
// 一起搜（2026-09-27 本机实测；它认 .gitignore，所以仓里的 .secrets/、*.pem 搜不到），grep -r 也搜。起点是这些目录、
// 又要打出匹配的内容时按拦处理；只列文件名、只数个数的，或者 glob、文件类型限定到碰不到密钥文件名的（比如 *.ts），放行。
// 起点写成变量（$REPO）的认不出、不拦；从家目录列出文件再交给别的命令读（find ~ | xargs grep）也认不出：这是止血，不是保险箱。

const HOME_WORD = String.raw`(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE)`;
const DRIVE = '(?:[a-z]:|/[a-z]|/mnt/[a-z])';
const HOME_PATH = `(?:/root|/home/[^/]+|/Users/[^/]+|${DRIVE}/Users/[^/]+)`;
const BROAD_ROOT_RE = new RegExp(
  String.raw`^(?:(?:${HOME_WORD}|${HOME_PATH})(?:/\.(?:claude|ssh|codex|grok|gemini|cursor|config(?:/gh)?))?|/(?:home|Users|etc|mnt)?|${DRIVE}(?:/Users)?)$`,
  'i',
);
/** 拿来判 glob、文件类型限定得够不够：密钥文件的名字（通用名单的扩展名配个 x） */
const SECRET_NAMES = [
  ...RECLAUDE_SECRETS,
  ...FLEET_ETC_NAMES,
  ...Object.values(DOTDIR_SECRETS).flat(),
  'vault-key.txt',
  '.pgpass',
  '.netrc',
  '.git-credentials',
  'hosts.yml',
  ...'pass key pem p12 pfx ppk kdbx jks keystore'.split(' ').map((e) => `x.${e}`),
];
/** rg 的文件类型里会带上密钥文件的：json（device.json、auth.json……）、txt（vault-key.txt）、yaml（gh 的 hosts.yml） */
const RISKY_TYPES = new Set(['json', 'jsonl', 'txt', 'yaml']);

/**
 * 搜的起点规整成 / 分隔、去掉 . 和 ..、末尾不带 /；相对路径接在 cwd 后面，cwd 也没有返回 null（看不出来）
 * @param {unknown} p
 * @param {unknown} cwd
 * @returns {string | null}
 */
function normRoot(p, cwd) {
  let s = String(p).replace(/['"]/g, '').replace(/\\/g, '/').replace(WSL_UNC_RE, '/');
  if (!isAbsolutePath(s)) {
    if (!cwd) return null;
    s = `${String(cwd).replace(/['"]/g, '').replace(/\\/g, '/')}/${s}`;
  }
  const lead = s.startsWith('/') ? '/' : '';
  /** @type {string[]} */
  const out = [];
  for (const part of s.split('/')) {
    if (part === '' || part === '.') continue;
    if (part !== '..') out.push(part);
    else if (out.length > (lead ? 0 : 1)) out.pop();
    else return '/';
  }
  return lead + out.join('/') || '/';
}

/**
 * 起点是不是上层目录；限定到碰不到密钥文件名的 glob、文件类型不算（有一个限定够了就放行，rg 取交集）
 * @param {unknown} root
 * @param {unknown} cwd
 * @param {string[]} globs
 * @param {string[]} types
 * @returns {boolean}
 */
function broadRoot(root, cwd, globs, types) {
  const r = normRoot(root, cwd);
  if (r === null || !BROAD_ROOT_RE.test(r)) return false;
  const positive = globs.filter((g) => !g.startsWith('!'));
  if (positive.length > 0 && positive.every((g) => !globHits(g.split('/').pop() ?? g, SECRET_NAMES)))
    return false;
  return !(types.length > 0 && types.every((t) => !RISKY_TYPES.has(t.toLowerCase())));
}

const BROAD_WHY =
  '会连 ~/.reclaude/device.json、~/.claude/.credentials.json、~/.ssh/id_* 这些密钥文件一起搜进对话，按拦处理（密钥、令牌、口令的值不进对话）';

const GREP_ARG_SHORT = new Set([...'efmABCdD']);
const GREP_ARG_LONG = opts(
  '--regexp --file --max-count --after-context --before-context --context --directories --devices --include --exclude --exclude-dir --exclude-from --label --binary-files --group-separator',
);
const RG_ARG_SHORT = new Set([...'efgtTmABCMjdEr']);
const RG_ARG_LONG = opts(
  '--regexp --file --glob --iglob --type --type-not --max-count --after-context --before-context --context --max-columns --threads --max-depth --encoding --replace --sort --sortr --type-add --type-clear --ignore-file --pre --pre-glob --colors --color --path-separator --context-separator --field-context-separator --field-match-separator --dfa-size-limit --regex-size-limit --engine --max-filesize --hyperlink-format',
);
const QUIET_LONG = new Set([
  '--files-with-matches',
  '--files-without-match',
  '--count',
  '--count-matches',
  '--quiet',
  '--silent',
  '--files',
]);

/**
 * grep -r、rg 这类往下递归搜内容的命令：{ roots, quiet, globs, types }（没写起点的，起点是 cwd）；不是这类返回 null。
 * quiet：只列文件名、只数个数、不出声（-l、-c、-q）。
 * @param {Leaf} leaf
 * @param {string} cwd
 * @returns {{ roots: string[], quiet: boolean, globs: string[], types: string[] } | null}
 */
function recursiveSearch(leaf, cwd) {
  const isGrep = ['grep', 'egrep', 'fgrep'].includes(leaf.name);
  if (!isGrep && leaf.name !== 'rg') return null;
  const argShort = isGrep ? GREP_ARG_SHORT : RG_ARG_SHORT;
  const argLong = isGrep ? GREP_ARG_LONG : RG_ARG_LONG;
  let recursive = !isGrep;
  let quiet = false;
  let patternGiven = false;
  /** @type {string[]} */
  const globs = [];
  /** @type {string[]} */
  const types = [];
  /** @type {string[]} */
  const positional = [];
  const words = leaf.args.map((x) => x.value);
  for (let i = 0; i < words.length; i++) {
    const v = words[i] ?? '';
    if (v === '--') {
      positional.push(...words.slice(i + 1));
      break;
    }
    if (v.startsWith('--')) {
      const eq = v.indexOf('=');
      const name = eq < 0 ? v : v.slice(0, eq);
      const val = eq < 0 ? (argLong.has(name) ? words[++i] : undefined) : v.slice(eq + 1);
      if (name === '--recursive' || name === '--dereference-recursive') recursive = true;
      else if (name === '--directories' && val === 'recurse') recursive = true;
      else if (QUIET_LONG.has(name)) quiet = true;
      else if (name === '--regexp' || name === '--file') patternGiven = true;
      else if (['--include', '--glob', '--iglob'].includes(name) && val !== undefined) globs.push(val);
      else if (name === '--type' && val !== undefined) types.push(val);
      continue;
    }
    if (!v.startsWith('-') || v === '-') {
      positional.push(v);
      continue;
    }
    for (let k = 1; k < v.length; k++) {
      const c = v[k] ?? '';
      if (argShort.has(c)) {
        const val = k < v.length - 1 ? v.slice(k + 1) : words[++i];
        if (c === 'e' || c === 'f') patternGiven = true;
        else if (isGrep && c === 'd' && val === 'recurse') recursive = true;
        else if (!isGrep && c === 'g' && val !== undefined) globs.push(val);
        else if (!isGrep && c === 't' && val !== undefined) types.push(val);
        break;
      }
      if (isGrep && (c === 'r' || c === 'R')) recursive = true;
      if ((isGrep ? 'lLcq' : 'lcq').includes(c)) quiet = true;
    }
  }
  if (!recursive) return null;
  const roots = patternGiven ? positional : positional.slice(1);
  return { roots: roots.length > 0 ? roots : [cwd], quiet, globs, types };
}

/**
 * 命令行里有没有从上层目录往下递归搜、又要打出内容的；有返回 block。ssh 到别的机器上跑的，没写起点就是那头的家目录；
 * wsl 里跑的按 --cd（没写就是这头的会话目录，WSL 把它换成 /mnt/<盘>/… 照用）
 * @param {string} text
 * @param {Kind} kind
 * @param {string} cwd
 * @param {number} depth
 * @returns {Block | null}
 */
function broadSearchLine(text, kind, cwd, depth) {
  if (depth > 4) return null;
  for (const c of scanCommand(text, kind).pipelines.flat()) {
    const u = unwrap(c.words);
    if (u.nested) {
      const r = broadSearchLine(u.nested.text, u.nested.kind, u.nested.cwd ?? cwd, depth + 1);
      if (r) return r;
      continue;
    }
    const s = u.leaf ? recursiveSearch(u.leaf, cwd) : null;
    if (s === null || s.quiet) continue;
    const root = s.roots.find((r) => broadRoot(r, cwd, s.globs, s.types));
    if (root !== undefined) {
      return block(
        [
          `fleet-guard：这条命令从「${root || cwd}」往下递归搜、又要打出匹配的内容，${BROAD_WHY}；搜的起点指到具体的目录，或者用 --include / -g 限定文件类型（比如 '*.ts'），只要文件名用 -l。`,
          `要看密钥文件的结构：node ${SHAPE} <文件>（只打字段名、类型、长度，一个值都不打）。`,
        ].join('\n'),
      );
    }
  }
  return null;
}

/**
 * 从上层目录往下搜的命令判一下：不是这类返回 null
 * @param {string} command
 * @param {Kind} kind
 * @param {string} cwd
 * @returns {Block | null}
 */
function broadSearchVerdict(command, kind, cwd) {
  if (!/(?:^|[^\w-])(?:[ef]?grep|rg)(?:\.exe)?(?![\w-])/i.test(command)) return null;
  try {
    return broadSearchLine(command, kind, cwd, 0);
  } catch (err) {
    return block(`fleet-guard：钩子没看懂这条搜内容的命令（${messageOf(err) ?? err}），按拦处理`);
  }
}

/**
 * 跑命令的工具在各家叫什么。登记在 ~/.claude/settings.json 的这条钩子，Grok、Devin、Cursor 默认也借道读，
 * 送进来的是它们自己的工具名：Grok 是 run_terminal_command（输入是 camelCase 的 toolName、toolInput），Devin 是 exec
 * （它按自己的名字匹配，靠 targets.ts 里锚定的那组 matcher 才进得来），Cursor 是 Shell。
 * bash 语法的检查（反引号）只对确定是 bash 的 Bash 做：别家的终端在 Windows 上未必是 bash。
 * @type {Record<string, Kind>}
 */
export const SHELL_TOOLS = {
  Bash: 'bash',
  PowerShell: 'powershell',
  run_terminal_command: 'shell',
  exec: 'shell',
  Shell: 'shell',
};

/**
 * 读文件、搜内容的工具在各家叫什么（登记在哪、各家怎么对上 matcher 见 packages/agents-sync/src/targets.ts 的 HOOK_TARGETS）：
 * Claude Code、Cursor 是 Read、Grep；Grok 是 read_file、grep；Devin 是 read、grep。值：read 读一个文件的内容；search 在目录
 * 或文件里搜内容，它的 pattern 是要搜的正则、不是路径。Glob 只列路径（和 ls 一样放行），不登记。
 * 登记了、这里却认不得的名字，按「认不出按拦处理」会把那个工具的每次调用都拦下：两边一起改（agents-sync 的测试逐个核对）。
 * @type {Record<string, 'read' | 'search'>}
 */
export const READ_TOOLS = {
  Read: 'read',
  Grep: 'search',
  read_file: 'read',
  read: 'read',
  grep: 'search',
};

/**
 * 输入里的字符串（数组里的也算），跳过 skip 里的字段
 * @param {Record<string, unknown>} args
 * @param {Set<string>} skip
 * @returns {string[]}
 */
function inputStrings(args, skip) {
  /** @type {string[]} */
  const out = [];
  for (const [k, v] of Object.entries(args)) {
    if (skip.has(k)) continue;
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) out.push(...v.filter((/** @type {unknown} */ x) => typeof x === 'string'));
  }
  return out;
}

/** @param {string} p */
const isAbsolutePath = (p) => /^(?:[\\/~$%]|[A-Za-z]:)/.test(p);

/**
 * 读文件、搜内容的工具碰到密钥路径就拦（和命令那条同一张名单）。路径在哪个字段各家不一样（file_path、path、target_file、
 * glob……），所以除了搜内容的 pattern，输入里每个字符串都看；相对路径接上会话目录再看一遍；搜内容没给路径的，看会话目录。
 * @param {string} tool
 * @param {'read' | 'search'} what
 * @param {Record<string, unknown>} input
 * @param {string} fallbackCwd
 * @returns {Verdict}
 */
function readVerdict(tool, what, input, fallbackCwd) {
  const args = prop(input, 'tool_input') ?? prop(input, 'toolInput');
  if (!isObjectLike(args) || Array.isArray(args)) {
    return block(`fleet-guard：${tool} 的输入认不出（${JSON.stringify(args)}），按拦处理`);
  }
  const values = inputStrings(args, new Set(what === 'search' ? ['pattern'] : []));
  if (what === 'read' && values.length === 0) {
    return block(`fleet-guard：${tool} 的输入里认不出要读的路径，按拦处理`);
  }
  const cwd = String(prop(input, 'cwd') ?? prop(input, 'workspaceRoot') ?? fallbackCwd);
  const where = typeof args.path === 'string' ? args.path : cwd;
  const seen = [
    ...values,
    ...values.filter((v) => cwd && !isAbsolutePath(v)).map((v) => `${cwd}/${v}`),
    ...(what === 'search'
      ? [where, ...(typeof args.glob === 'string' ? [`${where}/${args.glob}`] : [])]
      : []),
  ];
  for (const v of seen) {
    const label = secretMention(v);
    if (label !== null) {
      return block(
        [
          `fleet-guard：${tool} 要${what === 'read' ? '读' : '搜'}的是${label}，按拦处理（密钥、令牌、口令的值不进对话）；${SECRET_WAY}（在终端跑）。`,
          '查看脚本认 JSON、env、PEM；只要文件列表用 Glob、ls。',
          '在代码里搜这些名字：Grep 的 path 指到代码目录、名字写在 pattern 里，别把 path、glob 指到密钥文件上。',
        ].join('\n'),
      );
    }
  }
  // 从上层目录往下搜（上面「从上层目录往下搜」那一段）。Claude 的 Grep 不写 output_mode 时只列文件名，别家的默认打内容：
  // 不写的一律按打内容算，写明 files_with_matches、count 的放行
  const mode = args.output_mode ?? args.outputMode;
  const globs = typeof args.glob === 'string' ? [args.glob] : [];
  const types = typeof args.type === 'string' ? [args.type] : [];
  if (
    what === 'search' &&
    mode !== 'files_with_matches' &&
    mode !== 'count' &&
    broadRoot(where, cwd, globs, types)
  ) {
    return block(
      [
        `fleet-guard：${tool} 从「${where}」往下搜、又要打出匹配的内容，它连点开头的隐藏文件一起搜，${BROAD_WHY}；path 指到具体的目录，或者用 glob 限定文件类型（比如 *.ts），只要文件名写明 output_mode: files_with_matches。`,
        `要看密钥文件的结构：node ${SHAPE} <文件>（在终端跑，只打字段名、类型、长度，一个值都不打）。`,
      ].join('\n'),
    );
  }
  return { code: 0 };
}

/** 判一条钩子输入（原文）：{ code: 0 } 放行，{ code: 2, message } 拦下。 */
// 前台等待上限（创始人 2026-10-04「选 1」）：他在我干活时发的话只在两次工具调用的间隙送到，一条前台长等待中间没有间隙，
// 话就卡在那儿、进程一断还会丢。所以单次前台等待不许超过这个数（无人值守不无人值守都一样，他随时可能插话）；
// 更长的活用 run_in_background（跑完会重新叫醒我）、或拆成多次短等。后台跑的不受限。
export const MAX_FOREGROUND_WAIT_SECONDS = 60;
export const FRAMEWORK_DEFAULT_TIMEOUT_MS = 120_000;

/**
 * 这次调用在前台最多要等几秒：超过上限返回 { seconds, what }，没超过、后台跑的、认不出的都是 null（认不出不当超了拦人）。
 * @param {unknown} toolInput
 * @param {string} cmd
 * @param {Kind} kind
 * @returns {{ seconds: number, what: string } | null}
 */
export function foregroundWait(toolInput, cmd, kind) {
  if (prop(toolInput, 'run_in_background') === true) return null;
  const t = prop(toolInput, 'timeout');
  // 120000 是框架给没写 timeout 的调用自动补的默认值（#827 合进来当天撞到：钩子把每条普通命令都拦了），
  // 钩子分不出「没写」和「写了 120000」，只能放过这个数；显式写的 61000~119999、超过 120000 的照拦。
  if (
    typeof t === 'number' &&
    Number.isFinite(t) &&
    t > MAX_FOREGROUND_WAIT_SECONDS * 1000 &&
    t !== FRAMEWORK_DEFAULT_TIMEOUT_MS
  ) {
    return { seconds: Math.round(t / 1000), what: `timeout=${t}ms` };
  }
  /** @type {Record<string, number>} */
  const units = { '': 1, s: 1, m: 60, h: 3600, d: 86400 };
  if (kind === 'bash') {
    for (const m of cmd.matchAll(/(?:^|[;&|\n(]|&&|\|\|)\s*sleep\s+(\d+(?:\.\d+)?)([smhd]?)\b/g)) {
      const seconds = Number(m[1]) * (units[m[2] ?? ''] ?? Number.NaN);
      if (seconds > MAX_FOREGROUND_WAIT_SECONDS) return { seconds, what: m[0].trim() };
    }
  } else {
    for (const m of cmd.matchAll(/\bStart-Sleep\b([^;&|\n)]*)/gi)) {
      const args = m[1] ?? '';
      const ms = /-m(?:illiseconds)?\s+(\d+)/i.exec(args);
      const sec = /-s(?:econds)?\s+(\d+(?:\.\d+)?)/i.exec(args) ?? /^\s+(\d+(?:\.\d+)?)\b/.exec(args);
      const seconds = ms ? Number(ms[1]) / 1000 : sec ? Number(sec[1]) : 0;
      if (seconds > MAX_FOREGROUND_WAIT_SECONDS) return { seconds, what: m[0].trim() };
    }
  }
  return null;
}

/**
 * 这次调用是不是子代理（Agent 工具起的）发的：Claude Code 只在子代理里的钩子调用带 agent_id（code.claude.com/docs/en/hooks
 * 「When running with --agent or inside a subagent」：「Present only when the hook fires inside a subagent call. Use this to
 * distinguish subagent hook calls from main-thread calls」）。空串、不是字符串都不算，宁可按主会话的规矩多拦一次。
 * 为什么要分（创始人 2026-10-06「这种方式不太正确……把不合理的 subagent 方式改掉」）：前台等待上限、欠账催送、起后台活自动开无人值守，
 * 全是为了创始人的话能在两次调用之间送到**主会话**；子代理不和他对话，这几条套在它身上只剩代价——一次跑测试被拆成「后台起 + 每 55 秒
 * 醒一次看日志」，一个活 143 次调用、25 分钟、31 万 token（2026-10-06 #1118 实测）。密钥护栏、危险命令那些照旧管子代理。
 * @param {unknown} input
 */
export function isSubagentCall(input) {
  const id = prop(input, 'agent_id');
  return typeof id === 'string' && id.trim() !== '';
}

/**
 * @param {string} raw
 * @param {string} [fallbackCwd]
 * @returns {Verdict}
 */
export function decide(raw, fallbackCwd = '') {
  /** @type {unknown} */
  let parsed;
  try {
    // Cursor CLI（借道读这份钩子登记，targets.ts 的注释）在 Windows 上喂给钩子的 stdin 有时带 UTF-8 BOM
    // （社区已知的坑，forum.cursor.com「On Windows, Cursor's hook stdin JSON payload includes a UTF-8 BOM…」）：
    // Node 的 readFileSync(0,'utf8') 不会替你摘掉，打头那个字符（U+FEFF）会让 JSON.parse 直接炸。
    // 这里摘掉不算放松拦截——摘不掉、后面还是解不出 JSON 照样按拦处理；只是不让「读得懂的 JSON 前面多一个字符」
    // 变成把这次调用也一律拦掉。不直接在源码里写那个字符（容易和真的文件头 BOM 搞混、也不好认），用字符码判断。
    const noBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    parsed = JSON.parse(noBom);
  } catch {
    return block('fleet-guard：钩子输入不是 JSON，按拦处理');
  }
  // 不是对象的（null、数字、字符串）原来取什么字段都是 undefined；换成空对象，后面一样认不出、一样拦
  /** @type {Record<string, unknown>} */
  const input = isObjectLike(parsed) ? parsed : {};
  const tool = input.tool_name ?? input.toolName;
  // 只为记「起了后台活」才登记的工具（main 里已经记过）：这里不判，放行
  if (typeof tool === 'string' && (BACKGROUND_ONLY_TOOLS.has(tool) || DELIVERY_TOOLS.has(tool)))
    return { code: 0 };
  const readKind = typeof tool === 'string' && Object.hasOwn(READ_TOOLS, tool) ? READ_TOOLS[tool] : undefined;
  if (typeof tool === 'string' && readKind !== undefined) {
    return readVerdict(tool, readKind, input, fallbackCwd);
  }
  const kind = typeof tool === 'string' && Object.hasOwn(SHELL_TOOLS, tool) ? SHELL_TOOLS[tool] : undefined;
  if (kind === undefined) {
    return block(`fleet-guard：钩子输入里认不出工具名（${JSON.stringify(tool)}），按拦处理`);
  }
  const toolInput = prop(input, 'tool_input') ?? prop(input, 'toolInput');
  const command =
    prop(prop(input, 'tool_input'), 'command') ?? prop(prop(input, 'toolInput'), 'command') ?? input.command;
  if (typeof command !== 'string') {
    return block(`fleet-guard：${tool} 的输入里认不出命令（${JSON.stringify(command)}），按拦处理`);
  }
  const cmd = command;
  // 子代理不和创始人对话，前台等多久都不影响他的话送达：不设上限（isSubagentCall 的注释）
  const wait = isSubagentCall(input) ? null : foregroundWait(toolInput, cmd, kind);
  if (wait) {
    return block(
      `这条调用要在前台等约 ${wait.seconds} 秒（${wait.what}），超过单次上限 ${MAX_FOREGROUND_WAIT_SECONDS} 秒：创始人在这期间发的话要等它跑完才送到我手上，进程一断还会丢。长命令加 run_in_background: true（跑完会重新叫醒你），要等就拆成多次不超过 ${MAX_FOREGROUND_WAIT_SECONDS} 秒的短等；要跑几个小时的活交给 worker.mjs 脱离会话去跑。`,
    );
  }
  const rawCwd = String(input.cwd ?? input.workspaceRoot ?? fallbackCwd);
  const cwd = rawCwd.split('\\').join('/').toLowerCase();
  const inFleet = cwd.includes('fleet-dao') || /fleet-dao/i.test(cmd);
  // 密钥文件的内容不进对话（上面「密钥文件」「从上层目录往下搜」两段）。不分仓，全机都拦；别家的终端按 bash 的写法切。
  const secret = secretVerdict(cmd, kind) ?? broadSearchVerdict(cmd, kind, rawCwd);
  if (secret) return secret;
  // 命令的输出里带密钥：打印进程命令行（上面那一段）。密钥文件那条只看输入、看不到输出，所以单独判。
  const listing = processListingVerdict(cmd, kind);
  if (listing) return listing;
  // 2026-09-26 撞过两回：子代理拼命令时反引号误跑了切号登录；总指挥 node -e "…`specs/…/需求.md`…" 把整份需求文档当脚本执行了。
  // PowerShell 里反引号是转义符，不归这条管；别家的终端是不是 bash 说不准，也不管。不分仓，全机都拦。
  if (kind === 'bash' && bashBacktickSubst(cmd)) {
    return block(
      "这条 bash 命令里有会被当成命令执行的反引号（在双引号里、没加引号、或 <<EOF 不带引号的 heredoc 里）：bash 会先把反引号里的内容当命令跑掉。Markdown 的 `代码` 写法放进单引号里、用 <<'EOF' 的 heredoc，或者先用 Write 写进文件再用 --body-file / -F / 读文件；真要取命令输出用 $(…)。",
    );
  }
  // -R/--repo 指到 fleet-dao 以外的仓（比如巡检仓 fleet-dao-canary 的验收单）不归 issue:new 管，放行
  const repoFlag = /(?:^|\s)(?:-R|--repo)[\s=]+['"]?([^\s'"]+)/.exec(cmd)?.[1];
  const otherRepo = repoFlag !== undefined && !/(?:^|\/)fleet-dao$/i.test(repoFlag);
  // 下面这句用法是照 packages/conventions/src/issue-new.ts 的 USAGE 抄的（钩子装到各台机器上单独跑，引用不了仓里的包）：
  // 开单脚本的参数一改，这里跟着改——#654 删了 --specs 这里漏改过，照着做被拒（agents/test/pretool-bom.test.ts 钉着）。
  if (inFleet && /\bgh\s+issue\s+create\b/.test(cmd) && !otherRepo) {
    return block(
      'fleet-dao 开单一律用 `pnpm issue:new --kind <需求|缺陷|杂项> --milestone <版本全名|v<N>|未排期> --title "一句话" --body-file 正文.md`（正文要有写了字的「## 场景」「## 原话」「## 已知的模块」「## 怎么算做完」四节；母单加 --mother，子单加 --parent <母单号>，留给本机做的加 --local、开单那一刻就贴），不直接 gh issue create（会漏类别标签、里程碑和正文四节的检查）。',
    );
  }
  // 本机有 Claude 会话在跑时，在本机切号、登录、退出会让所有会话当场断掉（全局规矩「我的机器与模型」）。
  // 经 ssh 到别的机器上跑的放行。不分仓，全机都拦。
  // ssh 开头也不放行反引号、$( ) 里的：本机 bash 会先把它们执行掉，根本到不了远端。
  const rc = String.raw`\breclaude\s+(?:login|logout|org\s+use)\b`;
  const localSubst = new RegExp(String.raw`\x60[^\x60]*${rc}[^\x60]*\x60|\$\([^)]*${rc}`);
  if (new RegExp(rc).test(cmd) && (!/^\s*ssh\s/.test(cmd) || localSubst.test(cmd))) {
    return block(
      "本机有 Claude 会话在跑：不许在本机跑 reclaude login / logout / org use（会让本机所有会话当场断掉）。要切号请创始人自己来；要在别的机器上跑，用 ssh <机器> '…'。",
    );
  }
  // stash 栈是整个仓（所有工作树）共用一个：两个会话同时 stash/pop 会拿到对方的改动（2026-09-26 撞过）
  if (inFleet && /\bgit\b[^|;&\n]*\sstash\b(?!\s+(?:list|show)\b)/.test(cmd)) {
    return block(
      'fleet-dao 里不用 git stash：stash 栈所有工作树共用，并行会话会互相拿错改动。临时存改动用 `git diff > 文件` / `git apply 文件`，或先提交到自己分支。',
    );
  }
  // 2026-10-05 撞过：git reset --hard 把主检出一份还没验证的活回滚丢了。限制 fleet 仓的 Bash/PowerShell
  // 两条钩子管得着的壳，和「不用 git stash」那条并列。要回滚先提交个工作分支再 reset；
  // 想放下不要的活用 `git diff > 文件` 或 `git stash push -u -m '<tag>'`（stash 栈的坑见上一条，别合并到它）。
  if (inFleet && /\bgit\b[^|;&\n]*\sreset\b[^|;&\n]*\s--hard\b/.test(cmd)) {
    return block(
      "fleet-dao 里不用 git reset --hard：会把工作区覆盖掉，过去把主检出还没验证的活丢过。要回滚某个提交：先把当前进度 `git commit` 到分支或工作树，要丢弃改动用 `git stash push -u -m '<tag>'`，或先 `git diff > 文件` 再决定要不要真扔。",
    );
  }
  return { code: 0 };
}

/**
 * 起子代理前先把 origin/main 取到最新（子代理的工作树从它切）；要建工作树又取不成才拦（fresh-main.mjs 的 freshBeforeSubagent）。
 * 这一步自己出错不拦，但返回一句不拦的话给调用方写进 stderr：原来整段吞掉，子代理会从旧主线切工作树，没有任何提示（全仓审查第 4 路 S9）。
 * 输入认不出不算它出错（返回 null），由 decide 按拦处理。
 * @param {string} raw 钩子的原始输入
 * @param {{ fresh?: typeof freshBeforeSubagent, cwd?: string }} [deps] 测试换掉取远端那一步
 * @returns {{ block: boolean, message: string } | null}
 */
export function subagentFreshness(raw, { fresh = freshBeforeSubagent, cwd = process.cwd() } = {}) {
  /** @type {unknown} */
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return null;
  }
  try {
    const given = prop(input, 'cwd');
    return fresh({
      tool: prop(input, 'tool_name') ?? prop(input, 'toolName'),
      toolInput: prop(input, 'tool_input') ?? prop(input, 'toolInput'),
      cwd: typeof given === 'string' && given ? given : cwd,
      git: gitRunner(SUBAGENT_FETCH_MS, SUBAGENT_DIRECT_MS),
      okOf: gitOk,
      whyOf: gitWhy,
    });
  } catch (err) {
    return {
      block: false,
      message:
        `fleet-guard：起子代理前把 origin/main 取到最新这一步自己出错了（${err instanceof Error ? err.message : String(err)}），没取成、也没拦；` +
        '子代理的工作树可能从旧主线切，交代里写明开工先 git fetch origin main 再 git rebase origin/main。',
    };
  }
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  const norm = (/** @type {string} */ p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  return norm(resolve(entry)) === norm(fileURLToPath(import.meta.url));
}

if (isMain()) {
  /** @type {string} */
  let raw;
  try {
    raw = readFileSync(0, 'utf8');
  } catch (err) {
    process.stderr.write(`fleet-guard：读不到钩子输入（${errCode(err) ?? err}），按拦处理\n`);
    process.exit(2);
  }
  let backgroundOnly = false;
  try {
    /** @type {unknown} */
    const input = JSON.parse(raw);
    const id = cleanId(prop(input, 'session_id')) ?? cleanId(process.env.CLAUDE_CODE_SESSION_ID);
    // 决定 0026：不再因起后台活自动开无人值守。Agent、Monitor、Workflow 仍登记在这条钩子上，
    // 见到就放行（decide 不认识它们的名字，不放行会被拦）。
    const sub = isSubagentCall(input);
    const tool = prop(input, 'tool_name') ?? prop(input, 'toolName');
    backgroundOnly =
      typeof tool === 'string' && (BACKGROUND_ONLY_TOOLS.has(tool) || DELIVERY_TOOLS.has(tool));
    // 送达类工具清账。不再因欠账拦工具（决定 0026）。欠账文件坏了只往 stderr 写一句，不拦。
    const nag = id && !sub ? nagIfOwed({ dir: stateDir(), sessionId: id, tool }) : null;
    if (nag) process.stderr.write(`${nag.message}\n`);
    if (nag?.block) process.exit(2);
  } catch {
    // 输入认不出由下面的 decide 按拦处理
  }
  const fresh = subagentFreshness(raw);
  if (fresh) process.stderr.write(`${fresh.message}\n`);
  if (fresh?.block) process.exit(2);
  if (backgroundOnly) process.exit(0);
  // Devin 的输入里没有会话目录：钩子进程的工作目录就是会话目录
  const verdict = decide(raw, process.cwd());
  if (verdict.code !== 0) process.stderr.write(`${verdict.message}\n`);
  process.exit(verdict.code);
}
