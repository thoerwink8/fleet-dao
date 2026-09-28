// PreToolUse 钩子（agents-sync 装进 ~/.fleet-dao/hooks/，Claude Code 每次调 Bash、PowerShell 之前跑）。
// 只拦两件真正会执行的命令：本机 reclaude login / logout / org use（会把本机 Claude 会话全断）；
// 直接 gh issue create（绕开 pnpm issue:new）。heredoc 正文、引号里的字、注释里提到这些字样的不拦——
// 2026-09-28 傍晚整段字符串包含把写进临时文件的正文误拦了。创始人同日把拦读密钥文件的整段删了。
// 协议：stdin 一份 JSON（tool_name、tool_input、cwd）；退出码 2 = 拦下，stderr 给模型看；0 = 放行。
// 输入认不出一律按拦处理（退出码 2），不当成没事放行。
// 规矩本身由 agents/test/rules/pretool.rules.test.ts 钉住：改这里的判断改了规矩，那边会红。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const block = (message) => ({ code: 2, message });

/**
 * 跑命令的工具在各家叫什么。登记在 ~/.claude/settings.json 的这条钩子，Grok、Devin、Cursor 默认也借道读，
 * 送进来的是它们自己的工具名：Grok 是 run_terminal_command（输入是 camelCase 的 toolName、toolInput），Devin 是 exec，
 * Cursor 是 Shell。登记了、这里却认不得的名字，按「认不出按拦处理」会把那个工具的每次调用都拦下。
 */
export const SHELL_TOOLS = {
  Bash: 'bash',
  PowerShell: 'powershell',
  run_terminal_command: 'shell',
  exec: 'shell',
  Shell: 'shell',
};

const RC_MSG =
  "本机有 Claude 会话在跑：不许在本机跑 reclaude login / logout / org use（会让本机所有会话当场断掉）。要切号请创始人自己来；要在别的机器上跑，用 ssh <机器> '…'。";
const GH_MSG =
  'fleet-dao 开单一律用 `pnpm issue:new --kind <需求|缺陷|杂项> --milestone <版本全名|v<N>|未排期> --specs`（母单加 --mother，子单加 --parent <母单号>），不直接 gh issue create（会漏类别标签、里程碑、需求文档）。';

const SH_NAMES = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash']);
const WRAPPERS = new Set(['sudo', 'env', 'command', 'builtin', 'nohup', 'nice', 'setsid', 'doas']);
const SUDO_ARG = new Set([
  '-u',
  '-g',
  '-h',
  '-p',
  '-C',
  '-D',
  '-R',
  '-T',
  '-U',
  '-r',
  '-t',
  '--user',
  '--group',
  '--host',
  '--prompt',
  '--chdir',
  '--role',
  '--type',
]);

function baseName(value) {
  const leaf =
    String(value ?? '')
      .split(/[/\\]/)
      .pop() ?? '';
  return leaf.toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/, '');
}

/** 命令替换 $( )：从 `$` 起，配平括号，引号里的括号不算。 */
function readSubst(s, i) {
  let j = i + 2;
  let depth = 1;
  while (j < s.length && depth > 0) {
    const c = s[j];
    if (c === "'" || c === '"') {
      const q = c;
      j++;
      while (j < s.length && s[j] !== q) j += s[j] === '\\' ? 2 : 1;
      j++;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    j++;
  }
  return { inner: s.slice(i + 2, Math.max(i + 2, j - (depth === 0 ? 1 : 0))), end: j };
}

/** bash 反引号命令替换：从反引号起，到下一个没转义的反引号。单引号里的不算，调用方已经避开。 */
function readBacktick(s, i) {
  let j = i + 1;
  let inner = '';
  while (j < s.length && s[j] !== '`') {
    if (s[j] === '\\') {
      inner += s[j + 1] ?? '';
      j += 2;
      continue;
    }
    inner += s[j++];
  }
  return { inner, end: j < s.length ? j + 1 : j };
}

/**
 * 把一条命令切成「会执行的简单命令」（每个是去掉引号后的词）。
 * 命令位置：开头、`;` `&&` `||` `|` `&` 换行之后。`$( )` 和 bash 反引号里的另算一条。
 * heredoc 正文、PowerShell here-string、注释整段跳过：那里的字不会被执行。
 * ps：PowerShell 里反引号是转义，不是命令替换。
 */
function scan(text, ps) {
  const s = String(text).replace(/\r\n/g, '\n');
  const n = s.length;
  const commands = [];
  const nested = [];
  const pending = [];
  let words = [];
  let word = '';
  let inWord = false;
  const endWord = () => {
    if (!inWord) return;
    words.push(word);
    word = '';
    inWord = false;
  };
  const endCmd = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  const add = (ch) => {
    inWord = true;
    word += ch;
  };
  const eatHeredocs = (from) => {
    let i = from;
    for (const h of pending.splice(0)) {
      while (i < n) {
        let e = s.indexOf('\n', i);
        if (e < 0) e = n;
        const line = h.strip ? s.slice(i, e).replace(/^\t+/, '') : s.slice(i, e);
        i = e < n ? e + 1 : n;
        if (line === h.delim) break;
      }
    }
    return i;
  };

  let i = 0;
  while (i < n) {
    const c = s[i];
    const d = s[i + 1] ?? '';
    if (!ps && c === '\\' && d === '\n') {
      i += 2;
      continue;
    }
    if (c === ' ' || c === '\t') {
      endWord();
      i++;
      continue;
    }
    if (c === '\n') {
      endCmd();
      i = eatHeredocs(i + 1);
      continue;
    }
    if (c === '#' && !inWord) {
      while (i < n && s[i] !== '\n') i++;
      continue;
    }
    if (!inWord && c === '@' && (d === "'" || d === '"')) {
      const nl = s[i + 2] === '\n' ? i + 2 : s[i + 2] === '\r' && s[i + 3] === '\n' ? i + 3 : -1;
      if (nl >= 0) {
        const close = `${d}@`;
        i = nl + 1;
        while (i < n) {
          let e = s.indexOf('\n', i);
          if (e < 0) e = n;
          const line = s.slice(i, e).replace(/\r$/, '');
          i = e < n ? e + 1 : n;
          if (line === close) break;
        }
        continue;
      }
    }
    if (!ps && c === '<' && d === '<') {
      if (s[i + 2] === '<') {
        i += 3;
        continue;
      }
      let j = i + 2;
      const strip = s[j] === '-';
      if (strip) j++;
      while (s[j] === ' ' || s[j] === '\t') j++;
      let delim = '';
      if (s[j] === "'" || s[j] === '"') {
        const q = s[j++];
        while (j < n && s[j] !== q && s[j] !== '\n') delim += s[j++];
        if (s[j] === q) j++;
      } else {
        while (j < n && !/[\s;|&<>()]/.test(s[j])) {
          if (s[j] === '\\') {
            delim += s[j + 1] ?? '';
            j += 2;
          } else delim += s[j++];
        }
      }
      if (delim) pending.push({ delim, strip });
      i = j;
      continue;
    }
    if (c === '>' || (c === '<' && d !== '<')) {
      endWord();
      i++;
      if (s[i] === '>' || s[i] === '|') i++;
      if (s[i] === '&') {
        i++;
        while (i < n && /[\d-]/.test(s[i])) i++;
      }
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      let v = '';
      while (j < n) {
        if (s[j] === "'") {
          if (ps && s[j + 1] === "'") {
            v += "'";
            j += 2;
            continue;
          }
          j++;
          break;
        }
        v += s[j++];
      }
      add(v);
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let v = '';
      while (j < n) {
        const e = s[j];
        const f = s[j + 1] ?? '';
        if (e === '"') {
          if (ps && f === '"') {
            v += '"';
            j += 2;
            continue;
          }
          j++;
          break;
        }
        if (!ps && e === '\\') {
          v += f === '\n' ? '' : f;
          j += f ? 2 : 1;
          continue;
        }
        if (ps && e === '`') {
          v += f;
          j += 2;
          continue;
        }
        if (e === '$' && f === '(') {
          const sub = readSubst(s, j);
          nested.push(sub.inner);
          j = sub.end;
          continue;
        }
        if (!ps && e === '`') {
          const sub = readBacktick(s, j);
          nested.push(sub.inner);
          j = sub.end;
          continue;
        }
        v += e;
        j++;
      }
      add(v);
      i = j;
      continue;
    }
    if (c === '$' && d === '(') {
      const sub = readSubst(s, i);
      nested.push(sub.inner);
      i = sub.end;
      continue;
    }
    if (!ps && c === '`') {
      const sub = readBacktick(s, i);
      nested.push(sub.inner);
      i = sub.end;
      continue;
    }
    if (!ps && c === '\\') {
      if (d && d !== '\n') add(d);
      i += d ? 2 : 1;
      continue;
    }
    if (ps && c === '`') {
      if (d) add(d);
      i += 2;
      continue;
    }
    if (c === ';') {
      endCmd();
      i++;
      continue;
    }
    if (c === '&' && d === '&') {
      endCmd();
      i += 2;
      continue;
    }
    if (c === '|' && d === '|') {
      endCmd();
      i += 2;
      continue;
    }
    if (c === '|') {
      endCmd();
      i += d === '&' ? 2 : 1;
      continue;
    }
    if (c === '&') {
      endCmd();
      i++;
      continue;
    }
    add(c);
    i++;
  }
  endCmd();
  return { commands, nested };
}

/** 剥掉行首的变量赋值和 sudo、env 这类前缀，剩下的才是要跑的命令。 */
function stripPrefixes(words) {
  let w = words;
  for (let hop = 0; hop < 8 && w.length > 0; hop++) {
    let i = 0;
    while (i < w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i])) i++;
    if (i >= w.length) return w.slice(i);
    const name = baseName(w[i]);
    if (!WRAPPERS.has(name)) return w.slice(i);
    i++;
    if (name === 'sudo' || name === 'doas') {
      while (i < w.length && w[i].startsWith('-')) {
        const opt = w[i++];
        if (SUDO_ARG.has(opt)) i++;
      }
    } else if (name === 'env') {
      while (i < w.length) {
        const v = w[i];
        if (v === '-u' || v === '--unset' || v === '-C' || v === '--chdir') i += 2;
        else if (v.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(v)) i++;
        else break;
      }
    } else {
      while (i < w.length && w[i].startsWith('-')) i++;
    }
    w = w.slice(i);
  }
  return w;
}

/** bash -c / pwsh -Command 的那个参数本身是要执行的命令。看不清就返回 null，不当成这两条。 */
function shellDashC(words) {
  if (words.length === 0) return null;
  const name = baseName(words[0]);
  if (SH_NAMES.has(name)) {
    let i = 1;
    let dashC = false;
    while (i < words.length) {
      const v = words[i];
      if (v === '--' || v === '-') {
        i++;
        break;
      }
      if (/^[-+][oO]$/.test(v) || v === '--rcfile' || v === '--init-file') {
        i += 2;
        continue;
      }
      if (v.startsWith('--')) {
        i++;
        continue;
      }
      if (v.startsWith('-') || v.startsWith('+')) {
        if (v.startsWith('-') && v.includes('c')) dashC = true;
        i++;
        if (dashC) break;
        continue;
      }
      break;
    }
    if (!dashC || words[i] === undefined) return null;
    return { text: words[i], ps: false };
  }
  if (name === 'pwsh' || name === 'powershell') {
    let i = 1;
    while (i < words.length) {
      const low = words[i].toLowerCase();
      if (/^-c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?$/.test(low)) {
        const rest = words.slice(i + 1);
        if (rest.length === 0) return null;
        return { text: rest.join(' '), ps: true };
      }
      if (!low.startsWith('-')) break;
      i++;
    }
  }
  return null;
}

function collect(text, ps, depth, acc) {
  if (depth > 8) return;
  const { commands, nested } = scan(text, ps);
  for (const words of commands) {
    const stripped = stripPrefixes(words);
    acc.push(stripped);
    const inner = shellDashC(stripped);
    if (inner) collect(inner.text, inner.ps, depth + 1, acc);
  }
  for (const inner of nested) collect(inner, ps, depth + 1, acc);
}

function isReclaude(words) {
  if (baseName(words[0]) !== 'reclaude') return false;
  const a = (words[1] ?? '').toLowerCase();
  if (a === 'login' || a === 'logout') return true;
  return a === 'org' && (words[2] ?? '').toLowerCase() === 'use';
}

/** 是 `gh issue create` 就返回它的 -R/--repo（没有就是 undefined）；不是返回 null。 */
function ghIssue(words) {
  if (baseName(words[0]) !== 'gh') return null;
  let repo;
  let sawRepo = false;
  const pos = [];
  for (let i = 1; i < words.length; i++) {
    const a = words[i];
    if (a === '-R' || a === '--repo') {
      sawRepo = true;
      repo = words[++i];
      continue;
    }
    if (a.startsWith('--repo=')) {
      sawRepo = true;
      repo = a.slice('--repo='.length);
      continue;
    }
    if (/^-R=/.test(a)) {
      sawRepo = true;
      repo = a.slice(3);
      continue;
    }
    if (a.startsWith('-')) continue;
    pos.push(a);
  }
  if ((pos[0] ?? '').toLowerCase() !== 'issue' || (pos[1] ?? '').toLowerCase() !== 'create') return null;
  return { repo: sawRepo ? (repo ?? '') : undefined };
}

function fleetRepo(repo) {
  return /(?:^|\/)fleet-dao$/i.test(repo);
}

/** 判一条钩子输入（原文）：{ code: 0 } 放行，{ code: 2, message } 拦下。 */
export function decide(raw, fallbackCwd = '') {
  let input;
  try {
    // Cursor CLI 在 Windows 上喂的 stdin 有时带 UTF-8 BOM：打头那个字符会让 JSON.parse 直接炸。
    // 摘掉不算放松拦截——摘不掉、后面还是解不出 JSON 照样按拦处理。不直接在源码里写那个字符，用字符码判断。
    const text = typeof raw === 'string' ? raw : '';
    const noBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    input = JSON.parse(noBom);
  } catch {
    return block('fleet-guard：钩子输入不是 JSON，按拦处理');
  }
  const tool = input?.tool_name ?? input?.toolName;
  const kind = typeof tool === 'string' && Object.hasOwn(SHELL_TOOLS, tool) ? SHELL_TOOLS[tool] : undefined;
  if (kind === undefined) {
    return block(`fleet-guard：钩子输入里认不出工具名（${JSON.stringify(tool)}），按拦处理`);
  }
  const command = input?.tool_input?.command ?? input?.toolInput?.command ?? input?.command;
  if (typeof command !== 'string') {
    return block(`fleet-guard：${tool} 的输入里认不出命令（${JSON.stringify(command)}），按拦处理`);
  }
  const rawCwd = String(input?.cwd ?? input?.workspaceRoot ?? fallbackCwd);
  const cwd = rawCwd.split('\\').join('/').toLowerCase();
  // -R/--repo 指到 fleet-dao 以外的仓不归 issue:new 管。没写 -R 时，只在本仓（会话目录或命令里点到 fleet-dao）拦。
  const inFleet = cwd.includes('fleet-dao') || /fleet-dao/i.test(command);
  const acc = [];
  try {
    collect(command, kind === 'powershell', 0, acc);
  } catch (err) {
    return block(`fleet-guard：钩子没看懂这条命令（${err?.message ?? err}），按拦处理`);
  }
  for (const words of acc) {
    if (isReclaude(words)) return block(RC_MSG);
    const gh = ghIssue(words);
    if (gh && (gh.repo !== undefined ? fleetRepo(gh.repo) : inFleet)) return block(GH_MSG);
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
  const verdict = decide(raw, process.cwd());
  if (verdict.code !== 0) process.stderr.write(`${verdict.message}\n`);
  process.exit(verdict.code);
}
