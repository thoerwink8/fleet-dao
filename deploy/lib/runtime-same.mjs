#!/usr/bin/env node
// 比两版目录里，fleet-engine 或 fleet-api 运行时会加载的内容变没变。
// 用法：node deploy/lib/runtime-same.mjs fleet-engine|fleet-api 旧目录 新目录
// 打一行：same、changed，或 unknown 加原因。退出码 0 表示这行说得清；起不来由调用方当 unknown。
//
// 算进去的（宁多算不漏算；下面任何一步读不出、对不上、路径跑出版本目录，都是 unknown，调用方照常重启）：
// - 入口：fleet-engine = packages/engine/src/main.ts，fleet-api = packages/api/src/main.ts。
//   顺着静态 import / export from（含 type）、字面量 import()、require()、require.resolve()、
//   createRequire().resolve() 走。node: 内建不算。别的裸说明符不跟进去，整份 pnpm-lock.yaml 盖住它们。
//   @fleet-dao/* 按各包 package.json 的 exports 解：import 和 require 两种引用方式各按 Node 的条件表解一遍，
//   两边解到的文件都算（同一个包两组入口都写了时，只认一组会把另一组改动的漏掉；带 * 的通配解不开就是 unknown）。
// - 字面量 new URL('相对路径', import.meta.url)：文件算进去，是源码再接着走；目录里每个文件都算
//   （跳过 node_modules、.git），但不把目录里没被 import 的源码再当入口解析。指到版本目录本身、或跑出去，是 unknown。
//   第二个参数不是 import.meta.url 的 new URL（拼 http 地址那种）不算。参数不是字面量的 import()、require()、
//   .resolve()、new URL(..., import.meta.url) 是 unknown。
// - 再整份算上该服务自己的 src/（packages/engine/src 或 packages/api/src），没被 import 的文件也算，但不解析它们。
// - 根 package.json、该服务的 package.json、pnpm-lock.yaml、pnpm-workspace.yaml。有 .npmrc、patches/ 就整份算。
//   走到的每个 workspace 包的 package.json。.units/<单元>.service 必须有。.units/<单元>.socket 有就算。
// - 比较：每个文件一行「权限位 相对路径 内容 sha256」（符号链接用它自己的权限位、目标的内容；目标跑出去是 unknown），
//   排好序再对这一整份做 sha256。两边摘要一样是 same，否则 changed。不看修改时间，不把 node_modules 算进去。

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const UNITS = {
  'fleet-engine': { entry: 'packages/engine/src/main.ts', src: 'packages/engine/src' },
  'fleet-api': { entry: 'packages/api/src/main.ts', src: 'packages/api/src' },
};

const PARSE_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);
const TRY_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json'];
const REGEX_AFTER = new Set([
  'return',
  'throw',
  'case',
  'typeof',
  'void',
  'delete',
  'await',
  'in',
  'of',
  'else',
  'do',
  'yield',
  'instanceof',
  'new',
]);

function sha(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function fail(why) {
  const err = new Error(why);
  err.runtimeUnknown = true;
  throw err;
}

function inside(root, abs) {
  const rel = relative(root, abs);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function relOf(root, abs) {
  const rel = relative(root, abs);
  return rel.split(sep).join('/');
}

/** 扫一份源码里的静态引用。注释和字符串里的字不算。 */
function scanSource(text) {
  const specs = [];
  const urls = [];
  let computed = '';
  const n = text.length;
  let i = 0;
  /** @type {{ kind: 'code' | 'template'; brace: number | null }[]} */
  const stack = [{ kind: 'code', brace: null }];

  const isIdent = (c) => /[A-Za-z0-9_$]/.test(c);
  const skipWs = (at) => {
    while (at < n && /\s/.test(text[at])) at += 1;
    return at;
  };

  function skipString(at) {
    const q = text[at];
    at += 1;
    while (at < n) {
      if (text[at] === '\\') {
        at += 2;
        continue;
      }
      if (text[at] === q) return at + 1;
      at += 1;
    }
    return at;
  }

  function skipLine(at) {
    while (at < n && text[at] !== '\n') at += 1;
    return at;
  }

  function skipBlock(at) {
    at += 2;
    while (at < n && !(text[at] === '*' && text[at + 1] === '/')) at += 1;
    return Math.min(at + 2, n);
  }

  function skipRegex(at) {
    at += 1;
    let klass = false;
    while (at < n) {
      const c = text[at];
      if (c === '\\') {
        at += 2;
        continue;
      }
      if (c === '\n') return at;
      if (c === '[' && !klass) klass = true;
      else if (c === ']' && klass) klass = false;
      else if (c === '/' && !klass) {
        at += 1;
        while (at < n && /[a-z]/i.test(text[at])) at += 1;
        return at;
      }
      at += 1;
    }
    return at;
  }

  function isRegexSlash(at) {
    let j = at - 1;
    while (j >= 0 && text[j] !== '\n' && /\s/.test(text[j])) j -= 1;
    if (j < 0 || text[j] === '\n') return true;
    const p = text[j];
    if (p === ')' || p === ']' || p === '}' || (p >= '0' && p <= '9')) return false;
    if (p === "'" || p === '"' || p === '`') return false;
    if (isIdent(p)) {
      let k = j;
      while (k >= 0 && isIdent(text[k])) k -= 1;
      return REGEX_AFTER.has(text.slice(k + 1, j + 1));
    }
    return true;
  }

  function unescapeLit(body) {
    let out = '';
    for (let k = 0; k < body.length; k += 1) {
      if (body[k] === '\\' && k + 1 < body.length) {
        out += body[k + 1];
        k += 1;
      } else out += body[k];
    }
    return out;
  }

  /** 从引号起读一个静态字面量。模板里有 ${} 就不是静态。 */
  function readLiteral(at) {
    const q = text[at];
    if (q === "'" || q === '"') {
      const end = skipString(at);
      return { ok: true, value: unescapeLit(text.slice(at + 1, end - 1)), end };
    }
    if (q === '`') {
      let k = at + 1;
      let body = '';
      while (k < n) {
        if (text[k] === '\\') {
          body += text[k + 1] ?? '';
          k += 2;
          continue;
        }
        if (text[k] === '`') return { ok: true, value: body, end: k + 1 };
        if (text[k] === '$' && text[k + 1] === '{') return { ok: false, end: k };
        body += text[k];
        k += 1;
      }
    }
    return { ok: false, end: at };
  }

  // 跳过模板（含 ${}）。插值里的代码另外扫，免得 new URL(`http://${...}`) 这种被当成「路径算不出」。
  function skipTemplateNested(at) {
    let k = at + 1;
    while (k < n) {
      if (text[k] === '\\') {
        k += 2;
        continue;
      }
      if (text[k] === '`') return k + 1;
      if (text[k] === '$' && text[k + 1] === '{') {
        const start = k + 2;
        k += 2;
        let depth = 1;
        while (k < n && depth > 0) {
          if (text[k] === '/' && text[k + 1] === '/') {
            k = skipLine(k);
            continue;
          }
          if (text[k] === '/' && text[k + 1] === '*') {
            k = skipBlock(k);
            continue;
          }
          if (text[k] === "'" || text[k] === '"') {
            k = skipString(k);
            continue;
          }
          if (text[k] === '`') {
            k = skipTemplateNested(k);
            continue;
          }
          if (text[k] === '{') depth += 1;
          else if (text[k] === '}') {
            depth -= 1;
            if (depth === 0) {
              const sub = scanSource(text.slice(start, k));
              specs.push(...sub.specs);
              urls.push(...sub.urls);
              if (sub.computed) computed = computed || sub.computed;
              k += 1;
              break;
            }
          }
          k += 1;
        }
        continue;
      }
      k += 1;
    }
    return k;
  }

  function parseArgs(parenAt) {
    const args = [];
    let at = parenAt + 1;
    let start = at;
    let paren = 1;
    let brace = 0;
    let bracket = 0;
    while (at < n) {
      const c = text[at];
      if (c === '/' && text[at + 1] === '/') {
        at = skipLine(at);
        continue;
      }
      if (c === '/' && text[at + 1] === '*') {
        at = skipBlock(at);
        continue;
      }
      if (c === "'" || c === '"') {
        at = skipString(at);
        continue;
      }
      if (c === '`') {
        at = skipTemplateNested(at);
        continue;
      }
      if (c === '(') paren += 1;
      else if (c === ')') {
        paren -= 1;
        if (paren === 0) {
          const raw = text.slice(start, at).trim();
          if (raw !== '' || args.length > 0) args.push(raw);
          return { args, end: at + 1 };
        }
      } else if (c === '{') brace += 1;
      else if (c === '}') brace -= 1;
      else if (c === '[') bracket += 1;
      else if (c === ']') bracket -= 1;
      else if (c === ',' && paren === 1 && brace === 0 && bracket === 0) {
        args.push(text.slice(start, at).trim());
        start = at + 1;
      }
      at += 1;
    }
    return { args: null, end: at };
  }

  function readLiteralFrom(raw) {
    const lit = readLiteralAt(raw, 0);
    if (!lit.ok) return null;
    if (lit.end !== raw.length && raw.slice(lit.end).trim() !== '') return null;
    return lit.value;
  }

  function readLiteralAt(raw, at) {
    const q = raw[at];
    if (q !== "'" && q !== '"' && q !== '`') return { ok: false, end: at, value: '' };
    let k = at + 1;
    let body = '';
    while (k < raw.length) {
      if (raw[k] === '\\') {
        body += raw[k + 1] ?? '';
        k += 2;
        continue;
      }
      if (q === '`' && raw[k] === '$' && raw[k + 1] === '{') return { ok: false, end: k, value: '' };
      if (raw[k] === q) return { ok: true, value: body, end: k + 1 };
      body += raw[k];
      k += 1;
    }
    return { ok: false, end: k, value: '' };
  }

  function noteSpecCall(parenAt, why) {
    const parsed = parseArgs(parenAt);
    if (!parsed.args) {
      computed = computed || why;
      return parsed.end;
    }
    if (parsed.args.length === 0) {
      computed = computed || why;
      return parsed.end;
    }
    const value = readLiteralFrom(parsed.args[0]);
    if (value === null) computed = computed || why;
    else specs.push(value);
    return parsed.end;
  }

  function noteUrlCall(parenAt) {
    const parsed = parseArgs(parenAt);
    if (!parsed.args) {
      computed = computed || 'new URL 的参数没有收口';
      return parsed.end;
    }
    if (parsed.args.length >= 2 && parsed.args[1].replace(/\s+/g, '') === 'import.meta.url') {
      const value = readLiteralFrom(parsed.args[0]);
      if (value === null) computed = computed || 'new URL 的路径不是字面量';
      else urls.push(value);
    }
    return parsed.end;
  }

  while (i < n) {
    const frame = stack[stack.length - 1];
    const c = text[i];
    if (frame.kind === 'template') {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '`') {
        stack.pop();
        i += 1;
        continue;
      }
      if (c === '$' && text[i + 1] === '{') {
        stack.push({ kind: 'code', brace: 1 });
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      i = skipLine(i);
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i = skipBlock(i);
      continue;
    }
    if (c === '/' && isRegexSlash(i)) {
      i = skipRegex(i);
      continue;
    }
    if (c === "'" || c === '"') {
      i = skipString(i);
      continue;
    }
    if (c === '`') {
      stack.push({ kind: 'template' });
      i += 1;
      continue;
    }
    if (c === '{') {
      if (frame.brace !== null) frame.brace += 1;
      i += 1;
      continue;
    }
    if (c === '}') {
      if (frame.brace !== null) {
        frame.brace -= 1;
        if (frame.brace === 0) {
          stack.pop();
          i += 1;
          continue;
        }
      }
      i += 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(c) && (i === 0 || !isIdent(text[i - 1])) && text[i - 1] !== '.') {
      let j = i + 1;
      while (j < n && isIdent(text[j])) j += 1;
      const word = text.slice(i, j);
      if (word === 'from') {
        const k = skipWs(j);
        if (text[k] === "'" || text[k] === '"' || text[k] === '`') {
          const lit = readLiteral(k);
          if (!lit.ok) computed = computed || 'from 后面不是静态字面量';
          else specs.push(lit.value);
          i = lit.ok ? lit.end : k + 1;
          continue;
        }
      } else if (word === 'import') {
        const k = skipWs(j);
        if (text[k] === '(') {
          i = noteSpecCall(k, 'import() 的参数不是字面量');
          continue;
        }
        if (text[k] === "'" || text[k] === '"' || text[k] === '`') {
          const lit = readLiteral(k);
          if (!lit.ok) computed = computed || 'import 后面不是静态字面量';
          else specs.push(lit.value);
          i = lit.ok ? lit.end : k + 1;
          continue;
        }
      } else if (word === 'require') {
        const k = skipWs(j);
        if (text.startsWith('.resolve', k)) {
          const p = skipWs(k + '.resolve'.length);
          if (text[p] === '(') {
            i = noteSpecCall(p, 'require.resolve 的参数不是字面量');
            continue;
          }
        } else if (text[k] === '(') {
          i = noteSpecCall(k, 'require() 的参数不是字面量');
          continue;
        }
      } else if (word === 'createRequire') {
        const k = skipWs(j);
        if (text[k] === '(') {
          const after = parseArgs(k);
          const r = skipWs(after.end);
          if (text.startsWith('.resolve', r)) {
            const p = skipWs(r + '.resolve'.length);
            if (text[p] === '(') {
              i = noteSpecCall(p, 'createRequire().resolve 的参数不是字面量');
              continue;
            }
          }
          i = after.end;
          continue;
        }
      } else if (word === 'new') {
        const k = skipWs(j);
        if (text.startsWith('URL', k) && !isIdent(text[k + 3] ?? '')) {
          const p = skipWs(k + 3);
          if (text[p] === '(') {
            i = noteUrlCall(p);
            continue;
          }
        }
      }
      i = j;
      continue;
    }
    i += 1;
  }
  return { specs, urls, computed };
}

function loadNames(root) {
  const map = new Map();
  const dir = join(root, 'packages');
  if (!existsSync(dir)) fail('没有 packages/');
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    fail(`packages/ 读不出：${e instanceof Error ? e.message : e}`);
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const pkgPath = join(dir, ent.name, 'package.json');
    if (!existsSync(pkgPath)) continue;
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    } catch (e) {
      fail(`packages/${ent.name}/package.json 读不出：${e instanceof Error ? e.message : e}`);
    }
    if (typeof pkg.name !== 'string' || !pkg.name) continue;
    if (map.has(pkg.name)) fail(`工作区里 ${pkg.name} 有两份`);
    map.set(pkg.name, join(dir, ent.name));
  }
  return map;
}

// Node 解 exports 条件表：按对象里键的顺序、第一个「键在这个加载方式认的集合里」的就是它（default 永远算认得，
// 所以写在 default 后面的键到头来用不上——和 Node 一样，不替包的作者改顺序）。
// ESM 的 import（静态 import / export … from / import()）走 import 那一组，require() / require.resolve /
// createRequire().resolve 走 require 那一组：同一个包里两组入口都写了时，实际加载哪一个看调用方用哪种方式引，
// 只按一组解会把另一组改动的漏掉（见 resolveExport，宁多算不漏算——两边都算，解不开就 unknown、照常重启）。
// node / node-addons / default 两组都认（它们和引用方式无关）；只写 import 的包换 require 引就加载不到，反之亦然。
const IMPORT_CONDITIONS = new Set(['import', 'node', 'node-addons', 'default']);
const REQUIRE_CONDITIONS = new Set(['require', 'module-sync', 'node', 'node-addons', 'default']);

// 一个 exports 子项下、按某种加载方式会加载到的文件（相对包目录）。条件表按 Node 的规矩挑一个；
// 数组取第一个解得开的；通配、认不出的键、类型不对、空数组都算解不开，返回 null（调用方按 unknown 算，照常重启）。
function pickExport(target, kind, depth = 0) {
  if (depth > 20) return null;
  if (typeof target === 'string') return target.includes('*') ? null : [target];
  if (Array.isArray(target)) {
    for (const item of target) {
      const got = pickExport(item, kind, depth + 1);
      if (got) return got;
    }
    return null;
  }
  if (!target || typeof target !== 'object') return null;
  // 子路径表（键以 . 开头）在这一层挑不出东西——它要的是子路径，不是一个加载方式
  if (Object.keys(target).some((k) => k.startsWith('.'))) return null;
  const allowed = kind === 'import' ? IMPORT_CONDITIONS : REQUIRE_CONDITIONS;
  for (const key of Object.keys(target)) {
    if (!allowed.has(key)) continue;
    const got = pickExport(target[key], kind, depth + 1);
    if (got) return got;
  }
  return null;
}

// 一个 @fleet-dao/* 说明符会加载到的文件，可能不止一个：同一个子项里 import 和 require 各有一个入口时，
// 两种引用方式都算上（宁多算不漏算——只认一个，另一个入口改了会漏判成 same，白白不重启）。
// 两种方式都解不开（认不出、通配、对不上文件）：unknown，调用方照常重启。
function resolveExport(pkgDir, sub) {
  const pkgPath = join(pkgDir, 'package.json');
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch (e) {
    fail(`${relSafe(pkgPath)} 读不出：${e instanceof Error ? e.message : e}`);
  }
  const exp = pkg.exports;
  const where = `${pkg.name ?? pkgDir} ${sub}`;
  let entry;
  if (typeof exp === 'string') {
    if (sub !== '.') fail(`${where} 没有这项导出`);
    entry = exp;
  } else {
    if (!exp || typeof exp !== 'object' || Array.isArray(exp)) fail(`${where} 的 exports 读不出`);
    if (Object.keys(exp).some((k) => k.includes('*')) && !(sub in exp)) fail(`${where} 的导出是通配，解不开`);
    if (!(sub in exp)) fail(`${where} 没有这项导出`);
    entry = exp[sub];
  }
  const targets = [];
  for (const kind of ['import', 'require']) {
    const got = pickExport(entry, kind);
    if (got) targets.push(...got);
  }
  if (targets.length === 0) fail(`${where} 的导出解不开`);
  return [...new Set(targets)].map((t) => join(pkgDir, t));
}

function relSafe(abs) {
  return abs;
}

function splitBare(spec) {
  if (spec.startsWith('@')) {
    const slash = spec.indexOf('/');
    if (slash < 0) return { name: spec, sub: '.' };
    const second = spec.indexOf('/', slash + 1);
    if (second < 0) return { name: spec, sub: '.' };
    return { name: spec.slice(0, second), sub: `./${spec.slice(second + 1)}` };
  }
  const slash = spec.indexOf('/');
  if (slash < 0) return { name: spec, sub: '.' };
  return { name: spec.slice(0, slash), sub: `./${spec.slice(slash + 1)}` };
}

function resolveRelative(fromFile, spec) {
  const raw = resolve(dirname(fromFile), spec);
  const candidates = [raw];
  if (!extname(raw)) {
    for (const ext of TRY_EXT) candidates.push(raw + ext);
    for (const ext of TRY_EXT) candidates.push(join(raw, `index${ext}`));
  }
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    try {
      const st = lstatSync(c);
      if (st.isFile() || st.isSymbolicLink()) return c;
    } catch {
      // 下一个
    }
  }
  return null;
}

function fingerprint(rawRoot, unitName) {
  const unit = UNITS[unitName];
  if (!unit) fail(`不认识的单元 ${unitName}`);
  let root;
  try {
    root = realpathSync(rawRoot);
  } catch (e) {
    fail(`版本目录读不出：${e instanceof Error ? e.message : e}`);
  }
  const names = loadNames(root);
  /** @type {Map<string, { mode: number; hash: string }>} */
  const files = new Map();
  const parsed = new Set();
  /** @type {string[]} */
  const queue = [];

  function addHash(abs) {
    let real = abs;
    let st;
    try {
      st = lstatSync(abs);
    } catch (e) {
      fail(`${relOf(root, abs)} 读不出：${e instanceof Error ? e.message : e}`);
    }
    if (st.isSymbolicLink()) {
      try {
        real = realpathSync(abs);
      } catch (e) {
        fail(`${relOf(root, abs)} 的符号链接读不出：${e instanceof Error ? e.message : e}`);
      }
      if (!inside(root, real) || relative(root, real) === '')
        fail(`${relOf(root, abs)} 的符号链接跑出版本目录`);
    } else if (!st.isFile()) {
      fail(`${relOf(root, abs)} 不是普通文件`);
    }
    if (!inside(root, abs) || relative(root, abs) === '') fail(`${relOf(root, abs)} 跑出版本目录`);
    const key = relOf(root, abs);
    if (files.has(key)) return;
    let buf;
    try {
      buf = readFileSync(real);
    } catch (e) {
      fail(`${key} 读不出：${e instanceof Error ? e.message : e}`);
    }
    files.set(key, { mode: st.mode & 0o777, hash: sha(buf) });
  }

  function addTree(absDir) {
    let dir = absDir;
    try {
      const st = lstatSync(absDir);
      if (st.isSymbolicLink()) {
        dir = realpathSync(absDir);
        if (!inside(root, dir) || relative(root, dir) === '')
          fail(`${relOf(root, absDir)} 的目录跑出版本目录`);
      }
    } catch (e) {
      fail(`目录读不出：${e instanceof Error ? e.message : e}`);
    }
    const stack = [dir];
    const seen = new Set();
    while (stack.length > 0) {
      const cur = stack.pop();
      let realDir;
      try {
        realDir = realpathSync(cur);
      } catch (e) {
        fail(`目录读不出：${e instanceof Error ? e.message : e}`);
      }
      if (seen.has(realDir)) continue;
      seen.add(realDir);
      if (!inside(root, realDir) || relative(root, realDir) === '') fail('目录跑出版本目录');
      let ents;
      try {
        ents = readdirSync(realDir, { withFileTypes: true });
      } catch (e) {
        fail(`${relOf(root, realDir)} 读不出：${e instanceof Error ? e.message : e}`);
      }
      for (const ent of ents) {
        if (ent.name === 'node_modules' || ent.name === '.git') continue;
        const p = join(realDir, ent.name);
        if (ent.isSymbolicLink()) {
          let real;
          try {
            real = realpathSync(p);
          } catch (e) {
            fail(`${relOf(root, p)} 的符号链接读不出：${e instanceof Error ? e.message : e}`);
          }
          if (!inside(root, real)) fail(`${relOf(root, p)} 的符号链接跑出版本目录`);
          let rst;
          try {
            rst = statSync(real);
          } catch (e) {
            fail(`${relOf(root, p)} 读不出：${e instanceof Error ? e.message : e}`);
          }
          if (rst.isDirectory()) stack.push(real);
          else if (rst.isFile()) addHash(p);
          else fail(`${relOf(root, p)} 是特殊文件`);
        } else if (ent.isDirectory()) stack.push(p);
        else if (ent.isFile()) addHash(p);
        else fail(`${relOf(root, p)} 是特殊文件`);
      }
    }
  }

  function consider(abs) {
    if (!inside(root, abs) || relative(root, abs) === '') fail(`路径跑出版本目录：${abs}`);
    let st;
    try {
      st = lstatSync(abs);
    } catch (e) {
      fail(`${relOf(root, abs)} 读不出：${e instanceof Error ? e.message : e}`);
    }
    if (st.isSymbolicLink()) {
      let real;
      try {
        real = realpathSync(abs);
      } catch (e) {
        fail(`${relOf(root, abs)} 的符号链接读不出：${e instanceof Error ? e.message : e}`);
      }
      if (!inside(root, real) || relative(root, real) === '')
        fail(`${relOf(root, abs)} 的符号链接跑出版本目录`);
      let rst;
      try {
        rst = statSync(real);
      } catch (e) {
        fail(`${relOf(root, abs)} 读不出：${e instanceof Error ? e.message : e}`);
      }
      if (rst.isDirectory()) addTree(real);
      else if (rst.isFile()) queueFile(abs);
      else fail(`${relOf(root, abs)} 是特殊文件`);
      return;
    }
    if (st.isDirectory()) addTree(abs);
    else if (st.isFile()) queueFile(abs);
    else fail(`${relOf(root, abs)} 是特殊文件`);
  }

  function queueFile(abs) {
    addHash(abs);
    if (PARSE_EXT.has(extname(abs))) queue.push(abs);
  }

  function mustFile(rel) {
    const abs = join(root, rel);
    if (!existsSync(abs)) fail(`没有 ${rel}`);
    addHash(abs);
  }

  function onSpec(fromFile, spec) {
    if (spec.startsWith('.')) {
      const abs = resolveRelative(fromFile, spec);
      if (!abs) fail(`${relOf(root, fromFile)} 引用的 ${spec} 对不上文件`);
      consider(abs);
      return;
    }
    if (spec.startsWith('node:') || spec.startsWith('node:')) return;
    const { name, sub } = splitBare(spec);
    if (!name.startsWith('@fleet-dao/')) return;
    const pkgDir = names.get(name);
    if (!pkgDir) fail(`工作区里没有 ${name}`);
    addHash(join(pkgDir, 'package.json'));
    const targets = resolveExport(pkgDir, sub);
    for (const target of targets) {
      if (!existsSync(target)) fail(`${name} 的导出 ${sub} 对不上文件`);
      consider(target);
    }
  }

  function onUrl(fromFile, spec) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(spec) && !spec.startsWith('file:')) return;
    let u;
    try {
      u = new URL(spec, pathToFileURL(fromFile));
    } catch (e) {
      fail(`${relOf(root, fromFile)} 的 new URL(${spec}) 算不出：${e instanceof Error ? e.message : e}`);
    }
    if (u.protocol === 'http:' || u.protocol === 'https:') return;
    if (u.protocol !== 'file:') fail(`${relOf(root, fromFile)} 的 new URL 不是文件（${spec}）`);
    const abs = fileURLToPath(u);
    if (!inside(root, abs) || relative(root, abs) === '') {
      fail(`${relOf(root, fromFile)} 的 new URL(${spec}) 跑出版本目录`);
    }
    if (!existsSync(abs)) fail(`${relOf(root, fromFile)} 的 new URL(${spec}) 对不上文件`);
    consider(abs);
  }

  mustFile('package.json');
  mustFile('pnpm-lock.yaml');
  mustFile('pnpm-workspace.yaml');
  mustFile(unit.entry);
  const pkgJson = unit.entry.startsWith('packages/engine/')
    ? 'packages/engine/package.json'
    : 'packages/api/package.json';
  mustFile(pkgJson);
  mustFile(`.units/${unitName}.service`);
  const socketRel = `.units/${unitName}.socket`;
  if (existsSync(join(root, socketRel))) mustFile(socketRel);
  if (existsSync(join(root, '.npmrc'))) mustFile('.npmrc');
  if (existsSync(join(root, 'patches'))) consider(join(root, 'patches'));

  const srcAbs = join(root, unit.src);
  if (!existsSync(srcAbs)) fail(`没有 ${unit.src}`);
  addTree(srcAbs);

  queue.push(join(root, unit.entry));
  while (queue.length > 0) {
    const file = queue.pop();
    let real;
    try {
      real = realpathSync(file);
    } catch (e) {
      fail(`${relOf(root, file)} 读不出：${e instanceof Error ? e.message : e}`);
    }
    if (parsed.has(real)) continue;
    parsed.add(real);
    if (!inside(root, real)) fail(`${relOf(root, file)} 跑出版本目录`);
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (e) {
      fail(`${relOf(root, file)} 读不出：${e instanceof Error ? e.message : e}`);
    }
    const found = scanSource(text);
    if (found.computed) fail(`${relOf(root, file)}：${found.computed}`);
    for (const spec of found.specs) onSpec(file, spec);
    for (const spec of found.urls) onUrl(file, spec);
  }

  const lines = [...files.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([path, row]) => `${row.mode.toString(8)} ${path} ${row.hash}`);
  return { digest: sha(`${lines.join('\n')}\n`), files: lines.map((line) => line.split(' ')[1]) };
}

function main() {
  const [unit, oldDir, newDir, flag] = process.argv.slice(2);
  if (!UNITS[unit] || !oldDir || !newDir) {
    console.log('unknown 用法：runtime-same.mjs fleet-engine|fleet-api 旧目录 新目录');
    return;
  }
  const oldFp = fingerprint(oldDir, unit);
  const newFp = fingerprint(newDir, unit);
  if (flag === '--list') console.error(newFp.files.join('\n'));
  console.log(oldFp.digest === newFp.digest ? 'same' : 'changed');
}

try {
  main();
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.log(`unknown ${msg.replace(/\s+/g, ' ').slice(0, 240)}`);
}
