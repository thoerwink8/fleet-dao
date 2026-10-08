// 把各家命令行的模型列表收成模型串。认不出、空名单都是没读成，不当成「一个模型都没有」。
// 模型串原样留下：方括号里的参数是 Cursor 路由的一部分，剥掉会跟目录对错（D9）。
import type { QuotaErrorCode } from '../quota/types.ts';
import { isRecord, redact } from '../quota/util.ts';

export type RosterFailure = { ok: false; code: QuotaErrorCode; message: string };

export type RosterParse =
  | { ok: true; models: string[]; executors?: { modelKey: string; executor: string }[] }
  | RosterFailure;

const EMPTY_ROSTER = '渠道回了空名单，不当成一个模型都没有';
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g');
const SKIP_LINE = /^(available models|default model|tip:|you are |no models|failed to load|error:|usage:)/i;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

export function uniqueModels(ids: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function looksLikeModelId(id: string): boolean {
  if (id.length < 2 || id.length > 400) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/+[\]=,{}-]{1,399}$/.test(id)) return false;
  if (/^(available|models|default|current|tip|error|usage)$/i.test(id)) return false;
  return true;
}

function idFromLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed || SKIP_LINE.test(trimmed)) return undefined;
  const body = trimmed.replace(/^[-*•]\s+/, '');
  const token = (body.split(/\s+/)[0] ?? '').replace(/[,:：]$/, '');
  return looksLikeModelId(token) ? token : undefined;
}

export function linesToModelIds(text: string): string[] {
  const ids: string[] = [];
  for (const line of text.split('\n')) {
    const id = idFromLine(line);
    if (id) ids.push(id);
  }
  return ids;
}

function jsonIds(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    const ids: string[] = [];
    for (const item of value) {
      if (typeof item === 'string') ids.push(item);
      else if (isRecord(item)) {
        if (typeof item.id === 'string') ids.push(item.id);
        else if (typeof item.name === 'string') ids.push(item.name);
      }
    }
    return ids;
  }
  if (isRecord(value)) {
    if (Array.isArray(value.models)) return jsonIds(value.models) ?? [];
    if (Array.isArray(value.data)) return jsonIds(value.data) ?? [];
  }
  return null;
}

/** 整段或从第一个 { / [ 起能解析成模型列表时返回那些 id（可以是空数组）。不是列表就返回 null，交给按行认。 */
export function modelsFromJsonText(text: string): string[] | null {
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  try {
    return jsonIds(JSON.parse(text.slice(start)) as unknown);
  } catch {
    return null;
  }
}

export interface CommandStatus {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError?: string;
  killed: boolean;
}

/**
 * 退出码和报错先归类。返回 'parse' 才去认名单：非零、起不来、被杀掉都不拿输出里偶然出现的词当模型。
 */
export function classifyModelCommand(kind: 'cursor' | 'grok', run: CommandStatus): RosterFailure | 'parse' {
  if (run.spawnError) {
    const code = /ENOENT|not found|EACCES/i.test(run.spawnError) ? 'config' : 'unreachable';
    return { ok: false, code, message: `起不来：${redact(run.spawnError)}` };
  }
  if (run.killed) return { ok: false, code: 'timeout', message: '读模型表超时被停' };
  const text = stripAnsi(`${run.stderr}\n${run.stdout}`);
  if (kind === 'cursor' && (run.code === 78 || text.includes('Cursor 密钥没放好'))) {
    return { ok: false, code: 'no_credentials', message: `Cursor 密钥没放好：${redact(text) || '没有输出'}` };
  }
  if (run.code === 127 || /ENOENT|command not found/i.test(text)) {
    return { ok: false, code: 'config', message: `命令不在：${redact(text) || '没有输出'}` };
  }
  if (/unknown command|unrecognized command|not a valid command/i.test(text)) {
    return {
      ok: false,
      code: 'bad_response',
      message: `这个渠道的命令行不认 models 子命令：${redact(text) || '没有输出'}`,
    };
  }
  if (run.code !== 0) {
    if (/not logged in|not authenticated|unauthori[sz]ed|\b401\b|login required|invalid.*token/i.test(text)) {
      return { ok: false, code: 'auth', message: `登录失效：${redact(text) || '没有输出'}` };
    }
    return {
      ok: false,
      code: 'upstream',
      message: `退出码 ${run.code ?? '空'}：${redact(text) || '没有输出'}`,
    };
  }
  return 'parse';
}

/** 退出码 0 之后认名单。空的、声明没有模型的，都是 bad_response。 */
export function parseListedModels(kind: 'cursor' | 'grok', stdout: string): RosterParse {
  const text = stripAnsi(stdout).replace(/\r\n/g, '\n');
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, code: 'bad_response', message: EMPTY_ROSTER };

  const fromJson = modelsFromJsonText(trimmed);
  if (fromJson) {
    const models = uniqueModels(fromJson);
    if (models.length === 0) return { ok: false, code: 'bad_response', message: EMPTY_ROSTER };
    return { ok: true, models };
  }

  if (kind === 'cursor' && /no models available|failed to load models/i.test(trimmed)) {
    return { ok: false, code: 'bad_response', message: `Cursor 没有给出模型表：${redact(trimmed)}` };
  }
  if (/unknown command|unrecognized command/i.test(trimmed)) {
    return {
      ok: false,
      code: 'bad_response',
      message: `这个渠道的命令行不认 models 子命令：${redact(trimmed)}`,
    };
  }

  if (kind === 'grok') {
    const at = trimmed.search(/available models\s*:/i);
    if (at < 0) {
      if (/not authenticated|not logged in|\b401\b/i.test(trimmed)) {
        return { ok: false, code: 'auth', message: `Grok 没登录：${redact(trimmed)}` };
      }
      return {
        ok: false,
        code: 'bad_response',
        message: `Grok 的输出里没有 Available models：${redact(trimmed)}`,
      };
    }
    const section = trimmed.slice(at).split('\n').slice(1).join('\n');
    const models = uniqueModels(linesToModelIds(section));
    if (models.length === 0) {
      return { ok: false, code: 'bad_response', message: 'Grok 的 Available models 下面一个模型都没有' };
    }
    return { ok: true, models };
  }

  const models = uniqueModels(linesToModelIds(trimmed));
  if (models.length === 0) {
    return {
      ok: false,
      code: 'bad_response',
      message: `${kind} 的输出里一个模型串都没认出来：${redact(trimmed)}`,
    };
  }
  return { ok: true, models };
}
