// 法国现在有几个会话在跑：本机这头（#618）。经 ssh 把 france-sessions-query.mjs 喂给法国的 node、认回来的那一行。
// 复用 france-lib.mjs 的 ssh 名字读法（readTarget）、ssh 参数（sshArgs）、起 ssh 收输出（runRemote）、抹字（scrubText）。
// 读不到一律 { ok: false, kind, why }（kind 同 france-lib：not-configured、bad-config、no-script、ssh-failed、timeout、
// query-failed、bad-json、bad-shape）：调用方不许把它当成 0 个会话。
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTarget, runRemote, scrubText, sshArgs } from './france-lib.mjs';
import { APP, SCHEMA } from './france-sessions-query.mjs';

export const SESSIONS_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'france-sessions-query.mjs');
export const SESSIONS_REMOTE_COMMAND = 'node --input-type=module - --sessions';

/**
 * 法国回来的一行。成功 { ok: true, running, rows }（字都抹过）；认不出 { ok: false, kind, why }。
 * 法国那头自己报的失败（{ ok: false, why }）原样带回，kind 是 query-failed。
 * @param {unknown} text
 */
export function parseSessions(text) {
  const t = String(text ?? '').trim();
  if (t === '') return { ok: false, kind: 'bad-json', why: '法国上的查询脚本什么都没打出来' };
  let v;
  try {
    v = JSON.parse(t);
  } catch (e) {
    return {
      ok: false,
      kind: 'bad-json',
      why: `法国回来的不是 JSON（${e instanceof Error ? e.message : String(e)}；开头是「${scrubText(t.slice(0, 60))}」）`,
    };
  }
  if (typeof v !== 'object' || v === null || v.app !== APP || v.schema !== SCHEMA)
    return {
      ok: false,
      kind: 'bad-shape',
      why: '法国回来的 JSON 认不出：不是这份查询脚本打的，或版本对不上',
    };
  if (v.ok === false)
    return {
      ok: false,
      kind: 'query-failed',
      why: scrubText(typeof v.why === 'string' ? v.why : '没说为什么'),
    };
  if (v.ok !== true || !Number.isInteger(v.running) || v.running < 0 || !Array.isArray(v.rows))
    return { ok: false, kind: 'bad-shape', why: '法国回来的会话数认不出（要 running 非负整数和 rows 列表）' };
  return {
    ok: true,
    running: v.running,
    rows: v.rows.map((/** @type {unknown} */ r) => JSON.parse(scrubText(JSON.stringify(r)))),
  };
}

/**
 * 读一次法国在跑的会话数。回 { ok: true, running, rows } 或 { ok: false, kind, why }，不抛。
 * spawnImpl、command、argsFor 只给测试换（真的是 ssh）。
 * @param {{ home?: string, env?: Record<string, string | undefined>, scriptFile?: string, command?: string, argsFor?: (host: string) => string[], timeoutMs?: number, readText?: (file: string) => string, spawnImpl?: Parameters<typeof runRemote>[0]['spawnImpl'] }} [opts]
 */
export async function fetchRunningSessions({
  home = homedir(),
  env = process.env,
  scriptFile = SESSIONS_SCRIPT,
  command = 'ssh',
  argsFor = (host) => [...sshArgs(host).slice(0, -1), SESSIONS_REMOTE_COMMAND],
  timeoutMs = 60_000,
  readText = (f) => readFileSync(f, 'utf8'),
  spawnImpl,
} = {}) {
  const target = readTarget({ env, home, readText });
  if (!target.ok) return target;
  let script;
  try {
    script = readText(scriptFile);
  } catch (e) {
    return {
      ok: false,
      kind: 'no-script',
      why: `本机的查询脚本读不到（${scriptFile}：${e instanceof Error ? e.message : String(e)}）`,
    };
  }
  const r = await runRemote({
    command,
    args: argsFor(target.host),
    script,
    timeoutMs,
    ...(spawnImpl ? { spawnImpl } : {}),
  });
  if (!r.ok) return r;
  return parseSessions(r.stdout);
}
