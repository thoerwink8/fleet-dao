// deploy/test 不许直接同步起子进程（#264）：spawnSync / execFileSync / execSync 只留在 child.mjs。
// 扫本目录所有 .mjs。先去掉注释和引号里的字符串再找这三个名字：注释和引号里的字是在提这个词，不是调用。
// 只豁免本目录根上的 child.mjs 和这份 static-child.test.mjs；子目录里同名文件照样扫。
// 跑法：node --test deploy/test/static-child.test.mjs（deploy/test/run.sh 会跑）。
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';

const TEST = import.meta.dirname;

/**
 * 去掉注释和引号里的字符串（反引号 ${} 里的代码留下：那是代码，不是字面量）。
 * @param {string} code
 * @returns {string}
 */
function stripCommentsAndStrings(code) {
  let out = '';
  let i = 0;
  while (i < code.length) {
    const c = code[i] ?? '';
    const n = code[i + 1] ?? '';
    if (c === '/' && n === '/') {
      const nl = code.indexOf('\n', i);
      i = nl === -1 ? code.length : nl;
      continue;
    }
    if (c === '/' && n === '*') {
      const end = code.indexOf('*/', i + 2);
      i = end === -1 ? code.length : end + 2;
      out += ' ';
      continue;
    }
    if (c === "'" || c === '"') {
      i = endOfQuote(code, i + 1, c);
      continue;
    }
    if (c === '`') {
      const template = readTemplate(code, i + 1);
      out += stripCommentsAndStrings(template.inner);
      i = template.end;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * @param {string} code
 * @param {number} i
 * @param {string} quote
 */
function endOfQuote(code, i, quote) {
  while (i < code.length) {
    const c = code[i] ?? '';
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    if (c === '\n') return i;
    i++;
  }
  return i;
}

/**
 * 从模板内容起点读到闭合反引号；${} 里的源码拼进 inner，交给外层再扫。
 * 表达式前后各留一个空格：`${prefix}${execFileSync(...)}` 不能粘成 `prefixexecFileSync`，否则词边界扫不到。
 * @param {string} code
 * @param {number} i
 * @returns {{ inner: string, end: number }}
 */
function readTemplate(code, i) {
  let inner = '';
  while (i < code.length) {
    const c = code[i] ?? '';
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '`') return { inner, end: i + 1 };
    if (c === '$' && code[i + 1] === '{') {
      const expr = readBalanced(code, i + 1);
      inner += ` ${expr.body} `;
      i = expr.end;
      continue;
    }
    i++;
  }
  return { inner, end: i };
}

/**
 * @param {string} code
 * @param {number} open
 * @returns {{ body: string, end: number }}
 */
function readBalanced(code, open) {
  let depth = 0;
  let i = open;
  const start = open + 1;
  while (i < code.length) {
    const c = code[i] ?? '';
    if (c === "'" || c === '"') {
      i = endOfQuote(code, i + 1, c);
      continue;
    }
    if (c === '`') {
      i = readTemplate(code, i + 1).end;
      continue;
    }
    if (c === '/' && code[i + 1] === '/') {
      const nl = code.indexOf('\n', i);
      i = nl === -1 ? code.length : nl;
      continue;
    }
    if (c === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      i = end === -1 ? code.length : end + 2;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return { body: code.slice(start, i), end: i + 1 };
    }
    i++;
  }
  return { body: code.slice(start), end: i };
}

const BANNED = /\b(spawnSync|execFileSync|execSync)\b/;

/** 一段源码里命中的调用名（先去掉注释和引号字符串）。 @param {string} code */
function scanSyncChildSpawns(code) {
  const found = stripCommentsAndStrings(code).match(BANNED);
  return found?.[0] === undefined ? [] : [found[0]];
}

/** 相对 deploy/test 的路径（统一用 /）。 @param {string} file */
function rel(file) {
  return relative(TEST, file).split(sep).join('/');
}

/** 只有 deploy/test 根上的这两份豁免；`x/child.mjs` 这类不算。 @param {string} file */
function isExempt(file) {
  const path = rel(file);
  return path === 'child.mjs' || path === 'static-child.test.mjs';
}

/** deploy/test 下要扫的 .mjs（豁免的两份不进名单）。 */
function testSources() {
  /** @type {string[]} */
  const out = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.mjs') || isExempt(path)) continue;
      out.push(path);
    }
  };
  walk(TEST);
  return out;
}

test('spawnSync / execFileSync / execSync 只许在 child.mjs；字符串里提到的不算', () => {
  const files = testSources();
  assert.ok(files.length > 0, '一个 .mjs 都没扫到，不能当没问题');
  assert.equal(isExempt(join(TEST, 'child.mjs')), true);
  assert.equal(isExempt(join(TEST, 'static-child.test.mjs')), true);
  assert.equal(isExempt(join(TEST, 'nested', 'child.mjs')), false);
  assert.equal(isExempt(join(TEST, 'nested', 'static-child.test.mjs')), false);
  for (const name of ['auto-release.test.mjs', 'release-request.test.mjs']) {
    const text = readFileSync(join(TEST, name), 'utf8');
    assert.match(text, /\bspawnSync\b/, `${name} 里应当在字符串里提到 spawnSync`);
    assert.equal(
      files.some((file) => rel(file) === name),
      true,
      `${name} 要在扫描名单里`,
    );
    assert.deepEqual(scanSyncChildSpawns(text), [], `${name} 只在字符串里提到，不该报`);
  }
  const hits = files.filter((file) => scanSyncChildSpawns(readFileSync(file, 'utf8')).length > 0).map(rel);
  assert.deepEqual(hits, []);
});

test('故意放一行违规的样本，扫得出来', () => {
  assert.deepEqual(scanSyncChildSpawns(`execFileSync('git', []);`), ['execFileSync']);
});
