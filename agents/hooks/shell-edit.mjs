// 拦下「用 Bash 改仓里的文件」（单 #2844）：sed -i、perl -i、node -e / python -c / heredoc 里写文件、> >> tee 写进仓里的文件。
// 为什么：派工交代里每次写「改代码只用 Edit/Write」，工人还是用 sed -i、node -e、cat >> 改文件；Bash 会吞反斜杠和 ${}，
// 一次 sed 改坏过一行注释。交代拦不住，要在工具调用前当场拦（pretool.mjs 的 decide 只在 Bash 工具调用时接上这里）。
// 判法：只看命令文字和文件系统，不跑 git，不联网（钩子每次调用都跑，要快）。
// 「仓里」：从 cwd 往上找 .git（目录或文件都算）定仓根；目标在仓根下、又不在任何一层 _tmp/ 下，才算改仓里的文件。
// 宁可漏拦，不许误拦：路径是变量拼的、命令替换、cd 到看不清的地方之后的相对路径、仓根找不到、命令切不清，一律放行。
// 只放行不拦的写法：目标在 _tmp/、仓外（含系统临时目录）、/dev/*；只读命令；heredoc 喂给 git、gh 这类不落盘的命令（正文不看）。
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/** @typedef {{ value: string, unres: boolean }} Word 一个词：value 是去掉引号转义后的值；unres 为真是里面有 $、反引号、$( )，值认不全 */
/** @typedef {{ words: Word[], redirects: Word[] }} Stmt 一条简单命令的词和往文件写的重定向目标 */
/** @typedef {{ code: 2, message: string }} Block */
/** @typedef {'repo' | 'tmp' | 'safe' | 'unknown'} Place 路径在仓里 / 仓里的 _tmp/ / 仓外或设备文件 / 认不清 */

// biome-ignore lint/suspicious/noTemplateCurlyInString: 提示里要原样写出 ${}
const ADVICE = '改仓里的文件只用 Edit/Write：Bash 会吞反斜杠和 ${}；临时文件放 _tmp/';

/** 快路：命令里连这些字都没有，就不可能是上面那几类写法 */
const QUICK = /[>]|\b(?:sed|perl|node|nodejs|python[\d.]*|py|pypy3?|tee|bash|sh|zsh|dash)\b/;

/**
 * @param {string} snippet 认出来的那一段
 * @returns {Block}
 */
function blockFor(snippet) {
  const s = snippet.replace(/\s+/g, ' ').trim();
  return {
    code: 2,
    message: `fleet-guard：${ADVICE}。认出的写法：${s.length > 160 ? `${s.slice(0, 160)}…` : s}`,
  };
}

// —— 切命令 ——

/**
 * heredoc 拆开：outer 是命令行本身（正文换成空行），docs 是每段正文和它所在的那一行。<<< 不是 heredoc。认不出结束行的，后面全算正文。
 * @param {string} text
 * @returns {{ outer: string, docs: { head: string, at: number, body: string }[] }}
 */
function splitDocs(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  /** @type {string[]} */
  const outer = [];
  /** @type {{ delim: string, strip: boolean, head: string, at: number, body: string[] }[]} */
  const pending = [];
  /** @type {typeof pending} */
  const done = [];
  for (const line of lines) {
    const cur = pending[0];
    if (cur) {
      const cmp = cur.strip ? line.replace(/^\t+/, '') : line;
      if (cmp === cur.delim) {
        pending.shift();
        done.push(cur);
        outer.push(line);
      } else {
        cur.body.push(line);
        outer.push('');
      }
      continue;
    }
    outer.push(line);
    for (const m of line.matchAll(
      /(?<!<)<<(?!<)(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([A-Za-z_][\w.-]*))/g,
    )) {
      const delim = m[2] ?? m[3] ?? m[4];
      if (delim) pending.push({ delim, strip: m[1] === '-', head: line, at: m.index ?? 0, body: [] });
    }
  }
  done.push(...pending);
  return {
    outer: outer.join('\n'),
    docs: done.map((d) => ({ head: d.head, at: d.at, body: d.body.join('\n') })),
  };
}

/** 反斜杠后面跟这些字符才是转义（bash 不带引号时）；别的（D:\frank 里的 \f）原样留着，好认 Windows 路径 */
const ESCAPABLE = new Set([
  ' ',
  '\t',
  '"',
  "'",
  '$',
  '`',
  ';',
  '&',
  '|',
  '<',
  '>',
  '(',
  ')',
  '*',
  '?',
  '[',
  ']',
  '#',
  '!',
  '~',
  '\\',
  '{',
  '}',
]);

/**
 * 把命令切成简单命令：只认词、引号、; & && || | 换行 ( )、往文件写的重定向（> >> >| &> >&文件）；< 读入和 heredoc 的词吞掉。
 * $( ) 里的命令另算一条；反引号、$变量、${ } 记成「认不全」的词。看不懂的写法宁可当普通字符，不抛。
 * @param {string} text
 * @returns {Stmt[]}
 */
function tokenize(text) {
  const s = text.replace(/\r\n?/g, '\n');
  const n = s.length;
  /** @type {Stmt[]} */
  const stmts = [];
  /** @type {Stmt} */
  let stmt = { words: [], redirects: [] };
  /** @type {Word | null} */
  let word = null;
  /** @type {'out' | 'in' | null} */
  let pending = null;
  /** @param {string} v @param {boolean} [unres] */
  const add = (v, unres = false) => {
    word ??= { value: '', unres: false };
    word.value += v;
    if (unres) word.unres = true;
  };
  const endWord = () => {
    if (word === null) return;
    if (pending === 'out') stmt.redirects.push(word);
    else if (pending === null) stmt.words.push(word);
    pending = null;
    word = null;
  };
  const endStmt = () => {
    endWord();
    pending = null;
    if (stmt.words.length > 0 || stmt.redirects.length > 0) stmts.push(stmt);
    stmt = { words: [], redirects: [] };
  };
  let i = 0;
  while (i < n) {
    const c = s[i] ?? '';
    const d = s[i + 1] ?? '';
    if (c === ' ' || c === '\t') {
      endWord();
      i++;
    } else if (c === '\n' || c === ';' || c === '|' || c === '(' || c === ')') {
      endStmt();
      i++;
    } else if (c === '&') {
      if (d === '>') {
        endWord();
        pending = 'out';
        i += s[i + 2] === '>' ? 3 : 2;
      } else {
        endStmt();
        i += d === '&' ? 2 : 1;
      }
    } else if (c === '#' && word === null) {
      while (i < n && s[i] !== '\n') i++;
    } else if (c === '\\') {
      if (d === '\n') i += 2;
      else if (ESCAPABLE.has(d)) {
        add(d);
        i += 2;
      } else {
        add(c);
        i++;
      }
    } else if (c === "'") {
      const k = s.indexOf("'", i + 1);
      const end = k < 0 ? n : k;
      add(s.slice(i + 1, end));
      word ??= { value: '', unres: false };
      i = end + 1;
    } else if (c === '"') {
      let j = i + 1;
      let v = '';
      let unres = false;
      while (j < n && s[j] !== '"') {
        const e = s[j] ?? '';
        const f = s[j + 1] ?? '';
        if (e === '\\' && '$`"\\\n'.includes(f)) {
          if (f !== '\n') v += f;
          j += 2;
        } else {
          if (e === '$' || e === '`') unres = true;
          v += e;
          j++;
        }
      }
      add(v, unres);
      word ??= { value: '', unres: false };
      i = j + 1;
    } else if (c === '$' && d === "'") {
      let j = i + 2;
      let v = '';
      while (j < n && s[j] !== "'") {
        v += s[j] === '\\' ? (s[j + 1] ?? '') : s[j];
        j += s[j] === '\\' ? 2 : 1;
      }
      add(v);
      i = j + 1;
    } else if (c === '$' && d === '(' && s[i + 2] === '(') {
      // 算术 $(( )): 整段跳过，里面的 > 不是重定向
      const k = s.indexOf('))', i + 3);
      add('$((', true);
      i = k < 0 ? n : k + 2;
    } else if (c === '$' && d === '(') {
      add('$(', true);
      endWord();
      endStmt();
      i += 2;
    } else if (c === '$' && d === '{') {
      const k = s.indexOf('}', i + 2);
      add('${', true);
      i = k < 0 ? n : k + 1;
    } else if (c === '$') {
      add('$', true);
      i++;
    } else if (c === '`') {
      const k = s.indexOf('`', i + 1);
      add('`', true);
      i = k < 0 ? n : k + 1;
    } else if (c === '<') {
      endWord();
      let j = i + 1;
      if (s[j] === '<') j++;
      if (s[j] === '<' || s[j] === '-') j++;
      if (s[j] === '&') j++;
      pending = 'in';
      i = j;
    } else if (c === '>') {
      if (word !== null && /^\d+$/.test(/** @type {Word} */ (word).value)) word = null;
      endWord();
      let j = i + 1;
      if (s[j] === '>' || s[j] === '|') j++;
      if (s[j] === '&') {
        j++;
        // >&2、>&- 是复制文件描述符；>&文件 是把两路输出都写进文件
        if (/[\d-]/.test(s[j] ?? '')) {
          while (j < n && /[\d-]/.test(s[j] ?? '')) j++;
        } else pending = 'out';
      } else pending = 'out';
      i = j;
    } else {
      add(c);
      i++;
    }
  }
  endStmt();
  return stmts;
}

const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', 'time']);
const PREFIX = new Set(['sudo', 'env', 'command', 'nohup', 'exec', 'nice', 'setsid', 'builtin']);

/** @param {string} v */
const baseName = (v) => (v.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.(?:exe|cmd|bat)$/, '');

/**
 * 剥掉赋值、关键字、sudo 这类前缀，得到真正跑的命令；看不清（头一个词有 $、反引号）返回 null。
 * @param {Word[]} words
 * @returns {{ name: string, args: Word[] } | null}
 */
function head(words) {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (w === undefined) break;
    if (/^[A-Za-z_]\w*=/.test(w.value) || KEYWORDS.has(w.value)) {
      i++;
      continue;
    }
    if (w.unres) return null;
    const name = baseName(w.value);
    if (PREFIX.has(name)) {
      i++;
      while (i < words.length && (words[i]?.value ?? '').startsWith('-')) i++;
      continue;
    }
    return { name, args: words.slice(i + 1) };
  }
  return null;
}

// —— 路径在不在仓里 ——

/** 仓根：从 cwd 往上找 .git（目录或文件），找不到返回 null。只查文件系统，不跑 git */
/** @param {string} cwd */
function findRoot(cwd) {
  let dir = cwd;
  for (let k = 0; k < 64; k++) {
    if (existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

/**
 * 路径写法统一：反斜杠换成 /；Git Bash 的 /d/… 在 Windows 上换成 D:/…；~ 换成家目录；通配和花括号只留前面确定的那一截目录。
 * 认不清返回 null。
 * @param {string} p
 * @param {boolean} [globs] 为假时不截通配（cwd 是真目录名，名字里的 [ 不是通配）
 * @returns {string | null}
 */
function normalize(p, globs = true) {
  let v = p.replace(/\\/g, '/');
  if (v === '') return null;
  if (v === '~' || v.startsWith('~/')) v = `${homedir().replace(/\\/g, '/')}${v.slice(1)}`;
  else if (v.startsWith('~')) return null;
  const g = globs ? v.search(/[*?[{]/) : -1;
  if (g >= 0) v = v.slice(0, v.lastIndexOf('/', g) + 1) || './';
  if (process.platform === 'win32') {
    const m = /^\/([A-Za-z])(?=\/|$)/.exec(v);
    if (m) v = `${(m[1] ?? '').toUpperCase()}:${v.slice(2) || '/'}`;
  } else if (/^[A-Za-z]:\//.test(v)) return null;
  return v;
}

/**
 * 一个目标路径在哪。
 * @param {Word} w
 * @param {string | null} vcwd 命令跑的目录（cd 之后的）；null 是看不清，相对路径一律认不清
 * @param {string | null} root 起始 cwd 的仓根；null 是 cwd 不在仓里
 * @returns {Place}
 */
function place(w, vcwd, root) {
  if (w.unres) return 'unknown';
  if (w.value === '-' || w.value.startsWith('/dev/')) return 'safe';
  const v = normalize(w.value);
  if (v === null) return 'unknown';
  let abs;
  if (isAbsolute(v)) abs = resolve(v);
  else if (vcwd === null) return 'unknown';
  else abs = resolve(vcwd, v);
  /** @param {string} r */
  const under = (r) => {
    const rel = relative(r, abs).replace(/\\/g, '/');
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return null;
    // .gitignore 的 `_tmp/` 没写前导斜杠，任何一层的 _tmp 目录都是忽略的临时目录，不算仓里的文件（#3631：cd 进子目录写 _tmp/ 被误拦）
    return rel.split('/').includes('_tmp') ? 'tmp' : 'repo';
  };
  const mine = root === null ? null : under(root);
  if (mine !== null) return mine;
  // 不在 cwd 所在的仓里：cd 进了别的仓、或用绝对路径写别的工作树，按目标自己所在的仓判（家目录自己有 .git 的不算，免得家里的配置文件全被当成仓里）
  const own = findRoot(dirname(abs));
  if (own !== null && own !== root && own !== resolve(homedir())) return under(own) ?? 'safe';
  return 'safe';
}

// —— 各类写法 ——

/**
 * sed、perl 的选项：认 -i（连写 -ni、-pi.bak 里的 i）和 --in-place，返回要改的文件词；没有 -i 返回 null（只读）。
 * e、f（sed 还有 l）后面跟脚本，perl 的 e、E 后面跟代码：不当成选项继续往后认。
 * @param {Word[]} args
 * @param {'sed' | 'perl'} tool
 * @returns {Word[] | null}
 */
function inPlaceFiles(args, tool) {
  let inplace = false;
  let script = false;
  /** @type {Word[]} */
  const pos = [];
  const takesCode = tool === 'sed' ? 'efl' : 'eE';
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (w === undefined) continue;
    const v = w.value;
    if (v === '--') {
      pos.push(...args.slice(i + 1));
      break;
    }
    if (v.startsWith('--')) {
      if (/^--in-place(?:=|$)/.test(v)) inplace = true;
      else if (/^--(?:expression|file)(?:=|$)/.test(v)) {
        script = true;
        if (!v.includes('=')) i++;
      }
      continue;
    }
    if (v.length > 1 && v.startsWith('-')) {
      for (let k = 1; k < v.length; k++) {
        const ch = v[k] ?? '';
        if (ch === 'i') {
          inplace = true;
          break;
        }
        if (takesCode.includes(ch)) {
          script = true;
          if (k === v.length - 1) i++;
          break;
        }
        if (tool === 'perl' && /[IMmFx]/.test(ch)) break;
      }
      continue;
    }
    pos.push(w);
  }
  if (!inplace) return null;
  return script ? pos : pos.slice(1);
}

/**
 * 代码文字里写文件的地方。path 是写死的路径字面量；null 是路径写成了表达式（认不清）。
 * @param {string} code
 * @param {'node' | 'python'} lang
 * @returns {{ at: string, path: string | null }[]}
 */
function codeWrites(code, lang) {
  /** @type {{ at: string, path: string | null }[]} */
  const hits = [];
  if (lang === 'node') {
    for (const m of code.matchAll(
      /\b(writeFileSync|appendFileSync|writeFile|appendFile|createWriteStream)\s*\(\s*(?:(['"`])((?:(?!\2).)*)\2)?/g,
    )) {
      // 第一个参数是数字（文件描述符 1、2）或 process.stdout 这类：不是写文件
      const after = code.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 12);
      if (m[2] === undefined && /^\s*(?:\d|process\.std)/.test(after)) continue;
      hits.push({ at: m[1] ?? 'write', path: m[3] === undefined || m[3].includes('${') ? null : m[3] });
    }
  } else {
    for (const m of code.matchAll(
      /\bopen\(\s*(?:(['"])([^'"]*)\1|([^,()]+?))\s*,\s*(?:mode\s*=\s*)?(['"])([^'"]*)\4/g,
    )) {
      if (!/[wax+]/.test(m[5] ?? '')) continue;
      hits.push({ at: `open(…, '${m[5]}')`, path: m[2] ?? null });
    }
    for (const m of code.matchAll(/\.(write_text|write_bytes)\s*\(/g)) {
      const before = code.slice(Math.max(0, (m.index ?? 0) - 200), m.index ?? 0);
      const lit = /Path\(\s*(['"])([^'"]*)\1\s*\)\s*$/.exec(before);
      hits.push({ at: m[1] ?? 'write_text', path: lit?.[2] ?? null });
    }
  }
  return hits;
}

/**
 * 一段代码（node -e、python -c、喂给解释器的 heredoc）是不是在写仓里的文件。
 * 写文件的调用里路径是字面量就照字面量判；路径写成了表达式（变量）时，看代码里别处写死的路径字面量（const f='src/a.ts'）：
 * 有落在仓里的就算，一个都没有（路径全是运算出来的、拼出来的）认不清，放行。
 * @param {string} code
 * @param {'node' | 'python'} lang
 * @param {string | null} vcwd
 * @param {string | null} root
 * @returns {string | null} 认出来的那一段；没有返回 null
 */
function codeEdit(code, lang, vcwd, root) {
  for (const h of codeWrites(code, lang)) {
    if (h.path !== null) {
      if (place({ value: h.path, unres: false }, vcwd, root) === 'repo') return `${h.at} 写 ${h.path}`;
      continue;
    }
    for (const m of code.matchAll(/(['"`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)) {
      const lit = m[2] ?? '';
      if (!/^[^\s${}]+$/.test(lit) || !/[\\/]|\.\w{1,5}$/.test(lit)) continue;
      if (place({ value: lit, unres: false }, vcwd, root) === 'repo')
        return `${h.at}（路径是变量），代码里写死了 ${lit}`;
    }
  }
  return null;
}

const PY = /^(?:python[\d.]*|py|pypy3?)$/;
const JS = /^(?:node|nodejs)$/;
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);

/**
 * 命令名是不是解释器，是哪种
 * @param {string} name
 * @returns {'node' | 'python' | 'shell' | null}
 */
function interpreter(name) {
  if (JS.test(name)) return 'node';
  if (PY.test(name)) return 'python';
  if (SHELLS.has(name)) return 'shell';
  return null;
}

/**
 * @param {string} command
 * @param {string} cwd
 * @param {string | null} root
 * @param {number} depth bash -c 套了几层
 * @returns {string | null} 认出来的写法；没有返回 null
 */
function scan(command, cwd, root, depth) {
  const { outer, docs } = splitDocs(command);
  /** @type {string | null} */
  let vcwd = cwd;
  for (const st of tokenize(outer)) {
    const text = [...st.words.map((w) => w.value), ...st.redirects.map((w) => `> ${w.value}`)].join(' ');
    const h = head(st.words);
    if (h !== null) {
      const { name, args } = h;
      if (name === 'cd' || name === 'pushd') {
        const target = args.find((a) => !a.value.startsWith('-'));
        if (target === undefined || target.unres || target.value === '-') vcwd = null;
        else {
          const v = normalize(target.value);
          vcwd = v === null ? null : isAbsolute(v) ? resolve(v) : vcwd === null ? null : resolve(vcwd, v);
        }
      } else if (name === 'sed' || name === 'perl') {
        const files = inPlaceFiles(args, name);
        if (files?.some((f) => place(f, vcwd, root) === 'repo')) return text;
      } else if (name === 'tee') {
        const files = args.filter((a) => !a.value.startsWith('-') || a.value === '-');
        if (files.some((f) => place(f, vcwd, root) === 'repo')) return text;
      } else {
        const kind = interpreter(name);
        if (kind === 'node' || kind === 'python') {
          const flag = kind === 'node' ? /^(?:-[a-z]*[ep][a-z]*|--eval|--print)$/ : /^-[A-Za-z]*c$/;
          const at = args.findIndex((a) => flag.test(a.value));
          if (at >= 0) {
            const code = args
              .slice(at + 1)
              .map((a) => a.value)
              .join(' ');
            const hit = codeEdit(code, kind, vcwd, root);
            if (hit !== null) return `${name} ${args[at]?.value ?? ''} …${hit}`;
          }
        } else if (kind === 'shell' && depth < 3) {
          const at = args.findIndex((a) => /^-[A-Za-z]*c$/.test(a.value));
          const script = at >= 0 ? args[at + 1] : undefined;
          if (script !== undefined) {
            const hit = scan(script.value, vcwd ?? '', vcwd === null ? null : root, depth + 1);
            if (hit !== null) return hit;
          }
        }
      }
    }
    for (const r of st.redirects) {
      if (place(r, vcwd, root) === 'repo') return text;
    }
  }
  for (const doc of docs) {
    const seg =
      doc.head
        .slice(0, doc.at)
        .split(/[;&|(]/)
        .pop() ?? '';
    const h = head(tokenize(seg)[0]?.words ?? []);
    const kind = h === null ? null : interpreter(h.name);
    if (kind === 'node' || kind === 'python') {
      const hit = codeEdit(doc.body, kind, vcwd, root);
      if (hit !== null) return `${h?.name} <<heredoc …${hit}`;
    } else if (kind === 'shell' && depth < 3) {
      const hit = scan(doc.body, vcwd ?? '', vcwd === null ? null : root, depth + 1);
      if (hit !== null) return hit;
    }
  }
  return null;
}

/**
 * 这条 Bash 命令是不是在改仓里的文件（sed -i、perl -i、node -e / python 写文件、> >> tee 写进仓里）：是就返回拦下的结论
 * （退出码 2，提示改用 Edit/Write 并带上认出来的那一段），不是、认不清、出任何错都返回 null（放行）。
 * @param {unknown} command
 * @param {unknown} cwd 命令跑的目录；不是字符串或空，就没法认仓，放行
 * @returns {Block | null}
 */
export function shellEditVerdict(command, cwd) {
  if (typeof command !== 'string' || typeof cwd !== 'string' || cwd === '') return null;
  if (!QUICK.test(command)) return null;
  try {
    const start = normalize(cwd, false);
    if (start === null || !isAbsolute(start)) return null;
    const abs = resolve(start);
    const hit = scan(command, abs, findRoot(abs), 0);
    return hit === null ? null : blockFor(hit);
  } catch {
    return null;
  }
}
