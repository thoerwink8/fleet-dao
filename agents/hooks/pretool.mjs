// PreToolUse 钩子（agents-sync 装进 ~/.fleet-dao/hooks/，Claude Code 每次调 Bash、PowerShell、Read、Grep 之前跑）：
// 拦住绕过仓里脚本、会把本机会话全弄断、会把密钥文件的内容读进对话的调用。只是止血：正式的强制点在仓里
// （packages/conventions、卫生检查），这里挡的是会话自己手滑。
// 协议：stdin 一份 JSON（tool_name、tool_input、cwd）；退出码 2 = 拦下，stderr 给模型看；0 = 放行。
// 输入认不出一律按拦处理（退出码 2），不当成没事放行。
// 规矩本身由 agents/test/rules/pretool.rules.test.ts 钉住：改这里的判断改了规矩，那边会红。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// bash 里反引号是「先把里面当命令跑」（命令替换）：只有单引号里、带引号的 heredoc（<<'EOF'）里才是普通字符。
// 双引号里、不带引号、不带引号的 heredoc 里出现没转义的反引号，就返回 true。
// 认 $( ) 套在双引号里的写法（git commit -m "$(cat <<'EOF' … EOF)" 这种不误拦）；算术 << 之类极少见的写法认错时只会漏拦、不会误拦。
export function bashBacktickSubst(cmd) {
  const s = String(cmd).replace(/\r\n/g, '\n');
  const n = s.length;
  const stack = [{ k: 'none', d: 0 }];
  const pending = [];
  let i = 0;
  while (i < n) {
    const f = stack[stack.length - 1];
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
      stack.push({ k: 'sq' });
      i++;
      continue;
    }
    if (c === '"') {
      stack.push({ k: 'dq' });
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
    if (c === '#' && (i === 0 || /[\s;&|(]/.test(s[i - 1]))) {
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
      while (j < n && !/[\s;&|<>()]/.test(s[j])) {
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
 */
function globRegexes(glob) {
  const expanded = [];
  const expand = (g, depth) => {
    const m = /\{([^{}]*)\}/.exec(g);
    if (!m || depth > 4) expanded.push(g);
    else {
      for (const alt of m[1].split(','))
        expand(g.slice(0, m.index) + alt + g.slice(m.index + m[0].length), depth + 1);
    }
  };
  expand(glob, 0);
  // 花括号不配对：多半是命令里的逗号把路径词截断了（~/.ssh/{id_rsa,config}），看不清
  if (expanded.length > 64 || expanded.some((g) => /[{}]/.test(g))) return null;
  const out = [];
  for (const g of expanded) {
    let re = '';
    for (let i = 0; i < g.length; i++) {
      const c = g[i];
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

/** 这个通配能不能匹配上 names 里的名字；认不出按能 */
function globHits(glob, names) {
  const res = globRegexes(glob);
  return res === null || res.some((re) => names.some((n) => re.test(n)));
}

/** 目录下的路径算不算碰到密钥：目录本身、子目录、通配、变量、. 和 .. 都算；写死的文件名交给 isSecret 判 */
function secretUnder(rest, isSecret) {
  if (!rest || rest === '/' || rest.endsWith('/') || /[*?[\]{}$~\x60]/.test(rest)) return true;
  const parts = rest.split('/').filter(Boolean);
  return parts.some((p) => p === '.' || p === '..') || isSecret(parts.map((p) => p.toLowerCase()));
}

/** 这段文字碰到了哪类密钥路径（给提示用的说法）；没碰到返回 null。反斜杠当路径分隔、再去掉转义和引号各看一遍 */
export function secretMention(text) {
  const s = String(text);
  for (const v of [s.replace(/\\/g, '/').replace(/\/{2,}/g, '/'), s.replace(/[\\'"\x60]/g, '')]) {
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
      const dir = /** @type {keyof typeof DOTDIR_SECRETS} */ (m.groups?.dir.toLowerCase());
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
 */
function scanCommand(text, kind) {
  const ps = kind === 'powershell';
  const s = String(text).replace(/\r\n?/g, '\n');
  const n = s.length;
  const complex = [];
  const pipelines = [];
  let pipe = [];
  let cmd = { words: [], redirects: [] };
  let word = null;
  let redirect = false;
  let afterPipe = false;
  let inTest = false;
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
    const c = s[i];
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
        while (j < n && /[\d-]/.test(s[j])) j++;
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

/** 简单命令的头一个词为什么看不清（循环、赋值、拿变量当命令），看得清返回 null */
function headProblem(words, kind) {
  const head = words[0];
  if (head === undefined) return null;
  if (kind !== 'powershell' && BASH_KEYWORDS.has(head.raw)) return `${head.raw} 这类循环、判断`;
  if (kind !== 'powershell' && /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/.test(head.raw)) return '变量赋值';
  if (head.value.startsWith('$')) return kind === 'powershell' ? '变量、表达式' : '拿变量当命令';
  return null;
}

function cmdName(value) {
  return (String(value).split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/, '');
}

/** 跳过选项，返回头一个不是选项的词的下标；argOpts 里的选项吃掉下一个词（-u fleet；-ufleet 不吃） */
function afterOptions(words, argOpts) {
  let i = 0;
  while (i < words.length) {
    const v = words[i].value;
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

const opts = (list) => new Set(list.split(' '));
const SUDO_ARGS = opts(
  '-u -g -h -p -C -D -R -T -U -r -t --user --group --host --prompt --chdir --role --type',
);
const XARGS_ARGS = opts(
  '-a -d -E -I -L -n -P -s --arg-file --delimiter --eof --replace --max-lines --max-args --max-procs --max-chars',
);
const SSH_ARGS = opts('-B -b -c -D -E -e -F -I -i -J -L -l -m -O -o -P -p -Q -R -S -W -w');
const SCP_ARGS = opts('-c -D -F -i -J -l -o -P -S -X');
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
const PWSH_ARGS = opts(
  '-executionpolicy -ex -ep -workingdirectory -wd -outputformat -of -o -inputformat -if -windowstyle -w -version -v -configurationname -config -custompipename -settingsfile',
);

/**
 * 剥掉 sudo、env、xargs 这类前缀，拿到真正跑的命令：{ leaf }；ssh、bash -c、pwsh -Command、cmd /c 里的命令另算一条命令行：
 * { nested }；看不清：{ complex }。exclude 是不算「碰到」的词：ssh、scp 自己的选项（-i 指的钥匙是拿来用的，不打出来）和主机名。
 */
function unwrap(words) {
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
        const v = rest[i].value;
        if (v === '-S' || v.startsWith('--split-string')) return { complex: 'env -S', exclude };
        if (v === '-u' || v === '-C' || v === '--unset' || v === '--chdir') i += 2;
        else if (v.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(v)) i++;
        else break;
      }
      w = rest.slice(i);
    } else if (Object.hasOwn(PREFIX_ARGS, name)) {
      let i = afterOptions(rest, PREFIX_ARGS[name]);
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
      return { nested: { text: remote.map((x) => x.value).join(' '), kind: 'bash' }, name, exclude };
    } else if (SH_NAMES.has(name)) {
      let i = 0;
      let dashC = false;
      while (i < rest.length) {
        const v = rest[i].value;
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
        const v = rest[i].value.toLowerCase();
        if (/^-(?:e|ec|en|enc|enco|encod|encode|encoded\w*)$/.test(v))
          return { complex: '-EncodedCommand', exclude };
        if (
          /^-c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?$/.test(v) ||
          (!v.startsWith('-') && name === 'powershell')
        ) {
          const from = v.startsWith('-') ? i + 1 : i;
          const text = rest
            .slice(from)
            .map((x) => x.value)
            .join(' ');
          return { nested: { text, kind: 'powershell' }, name, exclude };
        }
        if (!v.startsWith('-') || /^-f(?:ile)?$/.test(v)) break;
        i += PWSH_ARGS.has(v) ? 2 : 1;
      }
      return { leaf: { name, args: rest, viaXargs }, exclude };
    } else if (name === 'cmd') {
      const at = rest.findIndex((x) => /^\/[ck]$/i.test(x.value));
      if (at < 0) return { leaf: { name, args: rest, viaXargs }, exclude };
      const text = rest
        .slice(at + 1)
        .map((x) => x.value)
        .join(' ');
      return { nested: { text, kind: 'shell' }, name, exclude };
    } else {
      if (name === 'scp' || name === 'sftp') {
        rest.forEach((x, i) => {
          if (SCP_ARGS.has(x.value) && rest[i + 1]) exclude.add(rest[i + 1]);
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

/** node 跑的是不是 secret-shape.mjs：node <…/secret-shape.mjs> …，或者经管道喂进去的 node -（stdinViewer） */
function isViewerRun(args, ctx) {
  for (let i = 0; i < args.length; i++) {
    const v = args[i].value;
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
function gitNonReading(args) {
  let i = 0;
  while (i < args.length && args[i].value.startsWith('-')) {
    i += /^(?:-C|-c|--git-dir|--work-tree|--namespace)$/.test(args[i].value) ? 2 : 1;
  }
  const sub = args[i]?.value ?? '';
  if (!['ls-files', 'check-ignore', 'status', 'add', 'rm', 'mv'].includes(sub)) return false;
  return !args
    .slice(i + 1)
    .some((x) => /^(?:-[A-Za-z]*[pie][A-Za-z]*|--patch|--interactive|--edit)$/.test(x.value));
}

/** grep、rg 只列文件名、只数个数、不出声（-l、-L、-c、-q 和长写法）：内容不上屏幕（ops 第五节 grep -c '^KEY=' 那样读回） */
function quietSearch(leaf) {
  const isGrep = ['grep', 'egrep', 'fgrep'].includes(leaf.name);
  if (!isGrep && leaf.name !== 'rg') return false;
  const argShort = isGrep ? GREP_ARG_SHORT : RG_ARG_SHORT;
  const argLong = isGrep ? GREP_ARG_LONG : RG_ARG_LONG;
  for (let i = 0; i < leaf.args.length; i++) {
    const v = leaf.args[i].value;
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

const COPY_ARGS = {
  cp: opts('-t -S --target-directory --suffix'),
  mv: opts('-t -S --target-directory --suffix'),
  install: opts('-m -o -g -t -S --mode --owner --group --target-directory --suffix'),
  scp: SCP_ARGS,
  rsync: opts('-e --rsh --exclude --include --filter -f'),
};

/** cp、mv、install、scp、rsync 只往密钥路径里写（碰到密钥路径的只有最后那个目标）：值不上屏幕，放密钥就是这么放的 */
function copiesInto(leaf) {
  const argOpts = COPY_ARGS[/** @type {keyof typeof COPY_ARGS} */ (leaf.name)];
  if (!argOpts) return false;
  const words = leaf.args;
  if (words.some((x) => /^(?:-t|--target-directory)(?:=|$)/.test(x.value))) return false;
  const positional = [];
  for (let i = 0; i < words.length; i++) {
    const v = words[i].value;
    if (v === '--') {
      positional.push(...words.slice(i + 1));
      break;
    }
    if (v.startsWith('-') && v !== '-') {
      if (argOpts.has(v)) i++;
      continue;
    }
    positional.push(words[i]);
  }
  // 选项的值（scp -i 指的钥匙、rsync -e 里的 ssh -i）是拿来用的，不算读；源里碰到密钥路径就是往外拷，不算
  if (positional.length < 2) return false;
  return positional.slice(0, -1).every((x) => (secretMention(x.raw) ?? secretMention(x.value)) === null);
}

function nonReading(leaf, ctx) {
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
function isViewerFeeder(info) {
  const leaf = info.u.leaf;
  if (!leaf || !['cat', 'type', 'gc', 'get-content'].includes(leaf.name)) return false;
  const files = leaf.args.filter((x) => !x.value.startsWith('-'));
  return files.length === 1 && VIEWER_RE.test(files[0].value);
}

/** 值往这里送就不过屏幕：ssh 到别的机器（ops 第九节「值不过屏幕」那几条管道）、只出摘要的 */
function isSink(info) {
  return info.u.name === 'ssh' ? info.u.nested !== undefined : HASHES.has(info.u.leaf?.name ?? '');
}

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

function secretBlock(label, why) {
  return block(
    [
      `fleet-guard：这条命令碰到了${label}${why ? `，又${why}` : ''}，按拦处理（密钥、令牌、口令的值不进对话）；${SECRET_WAY}。`,
      '碰到密钥文件只放行不读内容的：ls、stat、test、Test-Path、Get-Item 这类看在不在、看权限的，单独一条跑（别 cd 进去、别赋给变量、别套循环或 $( )）。',
      `查看脚本认 JSON、env、PEM；别的机器上的文件：cat ${SHAPE} | ssh <机器> 'node --input-type=module - <文件>'。`,
      '提交信息、PR 正文里要写这些路径：先用 Write 写进文件，再 -F / --body-file；在代码里搜这些名字用 Grep 工具。',
    ].join('\n'),
  );
}

/** checkLine 的结论：碰到了、都不读内容，放行 */
const CLEAN = { code: 0 };

/** 管道那头的远端脚本里，命令前面这些词剥掉再看后面那条命令 */
const RECEIVER_SKIP = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!']);

/**
 * 一条命令行里碰到密钥路径的命令是不是都不读内容：每条碰到的叶子命令不读内容（或者它的输出直接送进 ssh、摘要）；
 * 和它接在一个管道里的只能是不读内容的、只处理文字的（xargs 后面那条得不读内容）。ctx.stdoutSafe：这条命令行的输出
 * 本身就送进了 ssh、摘要；ctx.stdinViewer：标准输入是 secret-shape.mjs。
 * 返回 null：一处都没碰到；CLEAN：碰到了、放行；否则是 block。
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
      while (n < c.words.length && RECEIVER_SKIP.has(c.words[n].raw)) n++;
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
  if (unclear) return secretBlock(hit.label, `用了钩子看不清的写法（${unclear}）`);
  for (const p of infos) {
    const last = p.length - 1;
    for (let i = 0; i <= last; i++) {
      const x = p[i];
      if (x.label === null) continue;
      if (receiver && (x.head !== null || x.u.complex)) continue;
      const toSink = (i < last && isSink(p[i + 1])) || (i === last && ctx.stdoutSafe === true);
      if (x.u.nested) {
        if ((x.u.extra ?? []).some((a) => secretMention(a.raw) ?? secretMention(a.value))) {
          return secretBlock(x.label, `把它当参数传给 ${x.u.name} -c 里的脚本`);
        }
        const viewer = i > 0 && isViewerFeeder(p[i - 1]);
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
    for (let j = 0; j <= last; j++) {
      const x = p[j];
      if (x.label !== null || isViewerFeeder(x)) continue;
      if (j > 0 && p[j - 1].label !== null && isSink(x)) continue;
      if (x.u.nested) {
        if (x.u.name === 'ssh') continue;
        return secretBlock(first.label, `把它接进管道交给 ${x.u.name}`);
      }
      const leaf = x.u.leaf;
      const ok =
        nonReading(leaf, ctx) ||
        (!leaf.viaXargs && (FILTERS.has(leaf.name) || (kind === 'bash' && leaf.name === 'cat')));
      if (!ok)
        return secretBlock(
          first.label,
          `把它接进管道交给 ${leaf.viaXargs ? `xargs ${leaf.name}` : leaf.name}`,
        );
    }
  }
  return CLEAN;
}

/** 碰到密钥文件的命令判一下：没碰到、或者只列目录看权限，返回 null；要把内容打出来的返回 block */
function secretVerdict(command, kind) {
  const label = secretMention(command);
  if (label === null) return null;
  try {
    const r = checkLine(command, kind, {}, 0);
    return r === null || r === CLEAN ? null : r;
  } catch (err) {
    return secretBlock(label, `钩子没看懂这条命令（${err?.message ?? err}）`);
  }
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

/** 搜的起点规整成 / 分隔、去掉 . 和 ..、末尾不带 /；相对路径接在 cwd 后面，cwd 也没有返回 null（看不出来） */
function normRoot(p, cwd) {
  let s = String(p).replace(/['"]/g, '').replace(/\\/g, '/');
  if (!isAbsolutePath(s)) {
    if (!cwd) return null;
    s = `${String(cwd).replace(/['"]/g, '').replace(/\\/g, '/')}/${s}`;
  }
  const lead = s.startsWith('/') ? '/' : '';
  const out = [];
  for (const part of s.split('/')) {
    if (part === '' || part === '.') continue;
    if (part !== '..') out.push(part);
    else if (out.length > (lead ? 0 : 1)) out.pop();
    else return '/';
  }
  return lead + out.join('/') || '/';
}

/** 起点是不是上层目录；限定到碰不到密钥文件名的 glob、文件类型不算（有一个限定够了就放行，rg 取交集） */
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
 */
function recursiveSearch(leaf, cwd) {
  const isGrep = ['grep', 'egrep', 'fgrep'].includes(leaf.name);
  if (!isGrep && leaf.name !== 'rg') return null;
  const argShort = isGrep ? GREP_ARG_SHORT : RG_ARG_SHORT;
  const argLong = isGrep ? GREP_ARG_LONG : RG_ARG_LONG;
  let recursive = !isGrep;
  let quiet = false;
  let patternGiven = false;
  const globs = [];
  const types = [];
  const positional = [];
  const words = leaf.args.map((x) => x.value);
  for (let i = 0; i < words.length; i++) {
    const v = words[i];
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
      const c = v[k];
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

/** 命令行里有没有从上层目录往下递归搜、又要打出内容的；有返回 block。ssh 到别的机器上跑的，没写起点就是那头的家目录 */
function broadSearchLine(text, kind, cwd, depth) {
  if (depth > 4) return null;
  for (const c of scanCommand(text, kind).pipelines.flat()) {
    const u = unwrap(c.words);
    if (u.nested) {
      const r = broadSearchLine(u.nested.text, u.nested.kind, u.name === 'ssh' ? '~' : cwd, depth + 1);
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

/** 从上层目录往下搜的命令判一下：不是这类返回 null */
function broadSearchVerdict(command, kind, cwd) {
  if (!/(?:^|[^\w-])(?:[ef]?grep|rg)(?:\.exe)?(?![\w-])/i.test(command)) return null;
  try {
    return broadSearchLine(command, kind, cwd, 0);
  } catch (err) {
    return block(`fleet-guard：钩子没看懂这条搜内容的命令（${err?.message ?? err}），按拦处理`);
  }
}

/**
 * 跑命令的工具在各家叫什么。登记在 ~/.claude/settings.json 的这条钩子，Grok、Devin、Cursor 默认也借道读，
 * 送进来的是它们自己的工具名：Grok 是 run_terminal_command（输入是 camelCase 的 toolName、toolInput），Devin 是 exec
 * （它按自己的名字匹配，靠 targets.ts 里锚定的那组 matcher 才进得来），Cursor 是 Shell。
 * bash 语法的检查（反引号）只对确定是 bash 的 Bash 做：别家的终端在 Windows 上未必是 bash。
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
 */
export const READ_TOOLS = {
  Read: 'read',
  Grep: 'search',
  read_file: 'read',
  read: 'read',
  grep: 'search',
};

/** 输入里的字符串（数组里的也算），跳过 skip 里的字段 */
function inputStrings(args, skip) {
  const out = [];
  for (const [k, v] of Object.entries(args)) {
    if (skip.has(k)) continue;
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) out.push(...v.filter((x) => typeof x === 'string'));
  }
  return out;
}

const isAbsolutePath = (p) => /^(?:[\\/~$%]|[A-Za-z]:)/.test(p);

/**
 * 读文件、搜内容的工具碰到密钥路径就拦（和命令那条同一张名单）。路径在哪个字段各家不一样（file_path、path、target_file、
 * glob……），所以除了搜内容的 pattern，输入里每个字符串都看；相对路径接上会话目录再看一遍；搜内容没给路径的，看会话目录。
 */
function readVerdict(tool, what, input, fallbackCwd) {
  const args = input?.tool_input ?? input?.toolInput;
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return block(`fleet-guard：${tool} 的输入认不出（${JSON.stringify(args)}），按拦处理`);
  }
  const values = inputStrings(args, new Set(what === 'search' ? ['pattern'] : []));
  if (what === 'read' && values.length === 0) {
    return block(`fleet-guard：${tool} 的输入里认不出要读的路径，按拦处理`);
  }
  const cwd = String(input?.cwd ?? input?.workspaceRoot ?? fallbackCwd);
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
export function decide(raw, fallbackCwd = '') {
  let input;
  try {
    // Cursor CLI 在 Windows 上喂给钩子的 stdin 有时带 UTF-8 BOM（社区已知的坑，
    // forum.cursor.com「On Windows, Cursor's hook stdin JSON payload includes a UTF-8 BOM…」）：
    // Node 的 readFileSync(0,'utf8') 不会替你摘掉，打头那个字符（U+FEFF）会让 JSON.parse 直接炸。
    // 这里摘掉不算放松拦截——摘不掉、后面还是解不出 JSON 照样按拦处理；只是不让「读得懂的 JSON 前面多一个字符」
    // 变成把所有 Cursor 原生钩子的调用一律拦掉。不直接在源码里写那个字符（容易和真的文件头 BOM 搞混、也不好认），
    // 用字符码判断。
    const noBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    input = JSON.parse(noBom);
  } catch {
    return block('fleet-guard：钩子输入不是 JSON，按拦处理');
  }
  const tool = input?.tool_name ?? input?.toolName;
  if (typeof tool === 'string' && Object.hasOwn(READ_TOOLS, tool)) {
    return readVerdict(tool, READ_TOOLS[tool], input, fallbackCwd);
  }
  // Cursor CLI 自己的原生钩子（~/.cursor/hooks.json，packages/agents-sync 的 targets.ts HOOK_TARGETS 那条 format:'flat'
  // 的登记）：没有 tool_name，靠 hook_event_name 认，字段名和 Claude 那套（tool_input 套一层）不一样。
  // beforeReadFile：payload 只有 file_path（没有 cwd，Cursor 给的就是绝对路径，见 ntorres.dev/blog/cursor-hooks-json-guide）。
  const hookEvent = input?.hook_event_name;
  if (tool === undefined && hookEvent === 'beforeReadFile') {
    const filePath = input?.file_path;
    if (typeof filePath !== 'string') {
      return block('fleet-guard：beforeReadFile 的输入里认不出要读的路径，按拦处理');
    }
    const label = secretMention(filePath);
    if (label === null) return { code: 0 };
    return block(
      [
        `fleet-guard：要读的是${label}，按拦处理（密钥、令牌、口令的值不进对话）；${SECRET_WAY}（在终端跑）。`,
        '查看脚本认 JSON、env、PEM；只要文件列表用 ls。',
      ].join('\n'),
    );
  }
  // beforeShellExecution：payload 只有 command、cwd（没有 tool_name），跑的是哪个壳（cmd/PowerShell/bash）没有字段说，
  // 按最保守的 'shell' 判（和借道 Claude 钩子时 Cursor 把 Bash 翻成的 Shell 同一个 kind）：反引号那条 bash 专属检查
  // 不适用，密钥路径、从上层目录搜这几条通用检查照样跑。
  const kind =
    typeof tool === 'string' && Object.hasOwn(SHELL_TOOLS, tool)
      ? SHELL_TOOLS[tool]
      : tool === undefined && hookEvent === 'beforeShellExecution' && typeof input?.command === 'string'
        ? 'shell'
        : undefined;
  if (kind === undefined) {
    return block(`fleet-guard：钩子输入里认不出工具名（${JSON.stringify(tool)}），按拦处理`);
  }
  const command = input?.tool_input?.command ?? input?.toolInput?.command ?? input?.command;
  if (typeof command !== 'string') {
    return block(`fleet-guard：${tool} 的输入里认不出命令（${JSON.stringify(command)}），按拦处理`);
  }
  const cmd = command;
  const rawCwd = String(input?.cwd ?? input?.workspaceRoot ?? fallbackCwd);
  const cwd = rawCwd.split('\\').join('/').toLowerCase();
  const inFleet = cwd.includes('fleet-dao') || /fleet-dao/i.test(cmd);
  // 密钥文件的内容不进对话（上面「密钥文件」「从上层目录往下搜」两段）。不分仓，全机都拦；别家的终端按 bash 的写法切。
  const secret = secretVerdict(cmd, kind) ?? broadSearchVerdict(cmd, kind, rawCwd);
  if (secret) return secret;
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
  if (inFleet && /\bgh\s+issue\s+create\b/.test(cmd) && !otherRepo) {
    return block(
      'fleet-dao 开单一律用 `pnpm issue:new --kind <需求|缺陷|杂项> --milestone <版本全名|v<N>|未排期> --specs`（母单加 --mother，子单加 --parent <母单号>），不直接 gh issue create（会漏类别标签、里程碑、需求文档）。',
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
  return { code: 0 };
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  return norm(resolve(entry)) === norm(fileURLToPath(import.meta.url));
}

if (isMain()) {
  let raw;
  try {
    raw = readFileSync(0, 'utf8');
  } catch (err) {
    process.stderr.write(`fleet-guard：读不到钩子输入（${err?.code ?? err}），按拦处理\n`);
    process.exit(2);
  }
  // Devin 的输入里没有会话目录：钩子进程的工作目录就是会话目录
  const verdict = decide(raw, process.cwd());
  if (verdict.code !== 0) process.stderr.write(`${verdict.message}\n`);
  process.exit(verdict.code);
}
