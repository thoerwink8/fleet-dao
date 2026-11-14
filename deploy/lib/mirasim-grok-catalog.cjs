'use strict';
// 本机 grok 清单残缺（Mirasim 0.0.425 的 server.cjs，getCatalog {agent:'grok'}）。
//
// 原因：本机名单靠 `grok agent --no-leader stdio` 的 initialize 里 availableModels，只放内存。
// 探测失败不改这份内存，时间戳却先记上；refresh 再来时如果已经有一次在飞，就并进同一次，不会另开。
// 失败后 getCatalog 仍回这份旧名单；内存里没有时回内置的 grok-4.7 / 4.6 / 4.5。平台名单里多出来的
// （tier builtin、不在内置表里）被判成只走平台，route:local 开会话回「这个模型只有平台提供」。
// 成功结果不落盘，进程一重启就没了；失败也不会把上一份成功清掉。refresh 本身是等探测结束才回帧的，
// 残的不是「没等」，是失败仍拿旧名单或内置/平台名单冒充本机清单。`grok models` 列得出的
// grok-4.7、grok-4.7-build-fast 等，ACP 那一跳经常列不全。
//
// 补丁打在 server.cjs 进内存之前（本文件由 mirasim-stream-guard.cjs 在 --require 里装上）：
// 清单和开会话前现跑 `grok models` 并等它结束。失败就清空名单、帧上写 probeError，不回内置表、
// 也不把平台模型标成本机。列出来的模型 routeByModel 写 local，开会话时不再判成只走平台。

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const TTL_MS = 60_000;
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g');
const SKIP_LINE = /^(available models|default model|tip:|you are |no models|failed to load|error:|usage:)/i;

const NATIVE_RE =
  /if\((_0x[0-9a-f]+)==='grok'\)\{let (_0x[0-9a-f]+)=([A-Za-z_$][\w$]*)\(\);if\(\2\?\.\['length'\]\)return \2;\}/;
const REFRESH_RE =
  /if\((_0x[0-9a-f]+)\['agent'\]==='grok'\)\{let (_0x[0-9a-f]+)=([A-Za-z_$][\w$]*)\(!!\1\['refresh'\]\);\(\1\['refresh'\]\|\|![A-Za-z_$][\w$]*\(\)\)&&await \2;\}/;
const SEND_RE = /\{'type':'catalog','agent':(_0x[0-9a-f]+)\['agent'\],\.\.\.(_0x[0-9a-f]+)\}/;
const ED_RE =
  /function ([A-Za-z_$][\w$]*)\((_0x[0-9a-f]+),(_0x[0-9a-f]+)\)\{if\(!\2\)return(!\([^)]*\));let (_0x[0-9a-f]+)=\2\['trim'\]\(\);return ([A-Za-z_$][\w$]*)\['some'\]\((_0x[0-9a-f]+)=>\7\['id'\]===\5\)\?!\3\|\|!([A-Za-z_$][\w$]*)\(\3,\5\):(!\([^)]*\));\}/;
const COMPUTE_RE =
  /async\['compute'\]\((_0x[0-9a-f]+),(_0x[0-9a-f]+),(_0x[0-9a-f]+),(_0x[0-9a-f]+)\)\{let (_0x[0-9a-f]+)=([A-Za-z_$][\w$]*)\(\1\),(_0x[0-9a-f]+)=([A-Za-z_$][\w$]*)\(\3,\1\),/;

function looksLikeModelId(id) {
  if (id.length < 2 || id.length > 400) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/+[\]=,{}-]{1,399}$/.test(id)) return false;
  if (/^(available|models|default|current|tip|error|usage)$/i.test(id)) return false;
  return true;
}

function unique(ids) {
  const out = [];
  const seen = new Set();
  for (const raw of ids) {
    const id = String(raw).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function clip(text) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 180 ? `${flat.slice(0, 180)}…` : flat;
}

/** 认 `grok models` 的 Available models 段。空的、没有这段，都是没读成。 */
function parseGrokModels(text) {
  const cleaned = String(text).replace(ANSI, '').replace(/\r\n/g, '\n');
  const trimmed = cleaned.trim();
  if (!trimmed) return { ok: false, message: 'grok models 没有输出' };
  const at = trimmed.search(/available models\s*:/i);
  if (at < 0) {
    if (/not authenticated|not logged in|\b401\b/i.test(trimmed)) {
      return { ok: false, message: `grok 没登录：${clip(trimmed)}` };
    }
    return { ok: false, message: `grok models 的输出里没有 Available models：${clip(trimmed)}` };
  }
  const header = /default model\s*:\s*(\S+)/i.exec(trimmed.slice(0, at));
  const models = [];
  for (const line of trimmed.slice(at).split('\n').slice(1)) {
    const body = line.trim().replace(/^[-*•]\s+/, '');
    if (!body || SKIP_LINE.test(body)) continue;
    const token = (body.split(/\s+/)[0] ?? '').replace(/[,:：]$/, '');
    if (looksLikeModelId(token)) models.push(token);
  }
  const ids = unique(models);
  if (ids.length === 0) return { ok: false, message: 'grok models 的 Available models 下面一个模型都没有' };
  const marked = header && looksLikeModelId(header[1]) ? header[1] : null;
  return { ok: true, models: ids, defaultModel: marked && ids.includes(marked) ? marked : ids[0] };
}

function modelRows(ids) {
  return ids.map((id) => ({ id, label: id, contextWindow: null }));
}

/**
 * 清单状态。失败会盖掉上一份成功，不把旧名单继续当成这次的本机清单。
 * refresh 为假且还在有效期内才复用；开会话前用 refresh(false)，缓存空了或过期了会现跑并等完。
 */
function createGrokCatalog(opts) {
  const ttl = opts.ttlMs ?? TTL_MS;
  const now = opts.now ?? Date.now;
  let cache = null;
  let inflight = null;

  async function refresh(force) {
    const t = now();
    if (!force && cache && t - cache.at < ttl) return cache;
    if (inflight) return inflight;
    const job = (async () => {
      let result;
      try {
        result = await opts.run();
      } catch (err) {
        result = { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
      const models = result && result.ok ? unique(result.models ?? []) : [];
      const entry =
        result && result.ok && models.length > 0
          ? {
              at: now(),
              ok: true,
              models,
              defaultModel:
                result.defaultModel && models.includes(result.defaultModel) ? result.defaultModel : models[0],
            }
          : {
              at: now(),
              ok: false,
              models: [],
              message: `${(result && result.message) || 'grok models 没有列出模型'}。不拿平台清单当本机清单`,
            };
      cache = entry;
      return entry;
    })();
    inflight = job;
    try {
      return await job;
    } finally {
      if (inflight === job) inflight = null;
    }
  }

  function nativeModels() {
    if (!cache || !cache.ok) return [];
    return modelRows(cache.models);
  }

  function isLocal(agent, id) {
    return agent === 'grok' && !!cache && cache.ok && cache.models.includes(id);
  }

  function present(agent, catalog) {
    const base = catalog && typeof catalog === 'object' ? { ...catalog } : {};
    if (agent !== 'grok') return base;
    if (!cache || !cache.ok) {
      return {
        ...base,
        models: [],
        routeByModel: {},
        ownOnlyModels: [],
        defaultModel: null,
        probeError: (cache && cache.message) || '还没探测本机 grok 模型。不拿平台清单当本机清单',
      };
    }
    const out = {
      ...base,
      models: modelRows(cache.models),
      routeByModel: Object.fromEntries(cache.models.map((id) => [id, 'local'])),
      defaultModel: cache.defaultModel,
    };
    delete out.ownOnlyModels;
    delete out.probeError;
    delete out.tier;
    return out;
  }

  return { refresh, nativeModels, isLocal, present };
}

function grokBin() {
  if (process.env.MIRASIM_GROK_BIN) return process.env.MIRASIM_GROK_BIN;
  const home = process.env.HOME || os.homedir();
  const candidate = path.join(home, '.grok', 'bin', 'grok');
  if (fs.existsSync(candidate)) return candidate;
  return 'grok';
}

function interpretGrokModelsRun(run) {
  if (!run || run.error) {
    const err = run && run.error;
    const why = err && err.code === 'ETIMEDOUT' ? '超时' : (err && err.message) || '没有结果';
    return { ok: false, message: `grok models 起不来：${why}` };
  }
  if (run.status !== 0) {
    const text = clip(`${run.stdout || ''}\n${run.stderr || ''}`);
    return { ok: false, message: `grok models 退出 ${run.status ?? '空'}：${text || '没有输出'}` };
  }
  return parseGrokModels(`${run.stdout || ''}\n${run.stderr || ''}`);
}

function runGrokModelsCommand() {
  let run;
  try {
    run = spawnSync(grokBin(), ['models'], {
      encoding: 'utf8',
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, GROK_DISABLE_AUTOUPDATER: '1' },
    });
  } catch (err) {
    return { ok: false, message: `grok models 起不来：${err instanceof Error ? err.message : String(err)}` };
  }
  return interpretGrokModelsRun(run);
}

function replaceOne(src, re, build, name, missed) {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  const pattern = new RegExp(re.source, flags);
  let n = 0;
  const out = src.replace(pattern, (...args) => {
    n += 1;
    return build(...args);
  });
  if (n !== 1) missed.push(`${name}（${n} 处）`);
  return out;
}

/** 改 server.cjs 源码。对不上的位置记在 missed 里，原文留着，不让服务起不来。 */
function rewriteServerSource(src) {
  const missed = [];
  let code = src;
  code = replaceOne(
    code,
    NATIVE_RE,
    (full, agent) =>
      `if(${agent}==='grok'){let __mirasimGrokNative=global.__mirasimGrokNativeModels();if(__mirasimGrokNative)return __mirasimGrokNative;}`,
    '本机名单',
    missed,
  );
  code = replaceOne(
    code,
    REFRESH_RE,
    (full, req) =>
      `if(${req}['agent']==='grok'){await global.__mirasimRefreshGrokModels(!!${req}['refresh']);}`,
    'refresh',
    missed,
  );
  code = replaceOne(
    code,
    SEND_RE,
    (full, req, cat) =>
      `{'type':'catalog','agent':${req}['agent'],...global.__mirasimPresentCatalog(${req}['agent'],${cat})}`,
    '清单帧',
    missed,
  );
  code = replaceOne(
    code,
    ED_RE,
    (full, name, id, agent, earlyNo, trimmed, roster, item, native, no) =>
      `function ${name}(${id},${agent}){if(!${id})return ${earlyNo};let ${trimmed}=${id}['trim']();if(global.__mirasimGrokIsLocal&&global.__mirasimGrokIsLocal(${agent},${trimmed}))return ${no};return ${roster}['some'](${item}=>${item}['id']===${trimmed})?!${agent}||!${native}(${agent},${trimmed}):${no};}`,
    '只走平台',
    missed,
  );
  code = replaceOne(
    code,
    COMPUTE_RE,
    (full, agent, session, model, injected, info, lookup, relay, ed) =>
      `async['compute'](${agent},${session},${model},${injected}){if(${agent}==='grok'){await global.__mirasimRefreshGrokModels(false);}let ${info}=${lookup}(${agent}),${relay}=${ed}(${model},${agent}),`,
    '开会话',
    missed,
  );
  return { code, missed };
}

let installed = false;

function install() {
  if (installed) return;
  installed = true;
  const catalog = createGrokCatalog({ run: runGrokModelsCommand });
  global.__mirasimRefreshGrokModels = (force) => catalog.refresh(!!force);
  global.__mirasimGrokNativeModels = () => catalog.nativeModels();
  global.__mirasimGrokIsLocal = (agent, id) => catalog.isLocal(agent, id);
  global.__mirasimPresentCatalog = (agent, body) => catalog.present(agent, body);

  for (const ext of ['.js', '.cjs']) {
    const orig = Module._extensions[ext];
    if (!orig || orig.__mirasimGrokCatalog) continue;
    const wrapped = function (module, filename) {
      if (filename.endsWith(`${path.sep}server.cjs`)) {
        const src = fs.readFileSync(filename, 'utf8');
        const rewritten = rewriteServerSource(src);
        if (rewritten.missed.length > 0) {
          console.error(
            `[mirasim-grok-catalog] server.cjs 有的补丁没对上，这些位置仍是原样：${rewritten.missed.join('、')}`,
          );
        }
        module._compile(rewritten.code, filename);
        return;
      }
      return orig.call(this, module, filename);
    };
    wrapped.__mirasimGrokCatalog = true;
    Module._extensions[ext] = wrapped;
  }
}

module.exports = {
  createGrokCatalog,
  parseGrokModels,
  interpretGrokModelsRun,
  rewriteServerSource,
  install,
};
