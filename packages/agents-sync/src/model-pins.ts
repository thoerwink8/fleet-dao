// 设置里钉死的模型别名（决定 0119）：Claude Code 设置的 env 里有 ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL、ANTHROPIC_SMALL_FAST_MODEL，
// 就把 opus、sonnet、haiku 这些别名钉到写死的型号上；新型号出来它们还钉在旧的上，子代理传 model: "haiku" 悄悄跑旧型号。
// 这几个键不归仓里任何一份源文件管，见到就算漂移：--check 报出哪个文件、哪个键、钉的是什么；正常同步先备份再删。
// 扫两处：~/.claude/settings.json，和 reclaude 各账号目录 ~/.rec/claude/accounts/<号>/config/settings.json（reclaude 起的 Claude 读这份）。
// 子代理默认模型 CLAUDE_CODE_SUBAGENT_MODEL 不在这里：它归 permissions.ts 管（决定 0034、0092）。
// 哪一份读不了、不是 JSON，报没查成、不动它，接着扫别的，不中断同步；env 里别的变量一个不碰。
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Backups } from './backup.ts';
import { readSettings } from './hooks.ts';
import { type Line, line } from './report.ts';
import { type Ctx, code, writeAtomic } from './sync.ts';
import { placeOn } from './targets.ts';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 改别名指向的键：设了就把别名钉死在某个型号上 */
export const MODEL_PIN_KEYS = [
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
] as const;

const WHY =
  '钉死的型号新版出来不会跟，按别名派的子代理悄悄跑旧型号；子代理型号只在三个角色定义里钉完整 id（决定 0119）';

/** reclaude 各账号的 Claude 配置目录都在它下面（相对家目录） */
const ACCOUNTS = { win32: '.rec\\claude\\accounts', linux: '.rec/claude/accounts' };

/** 要扫的一份设置：rel 相对家目录、/ 分隔（报告和备份照它摆） */
interface Target {
  rel: string;
  abs: string;
}

/** 要扫的几份；账号目录列不出来（不是没有）单独报一行没查成，~/.claude 那份照扫 */
function targets(ctx: Ctx): { files: Target[]; lines: Line[] } {
  const files: Target[] = [{ rel: '.claude/settings.json', abs: join(ctx.home, '.claude', 'settings.json') }];
  const root = join(ctx.home, placeOn(ACCOUNTS, ctx.platform));
  let ids: string[];
  try {
    ids = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch (err) {
    if (code(err) === 'ENOENT') return { files, lines: [] };
    return {
      files,
      lines: [line('unknown', '~/.rec/claude/accounts', `没查成——列不出账号目录（${code(err)}）`)],
    };
  }
  for (const id of ids)
    files.push({
      rel: `.rec/claude/accounts/${id}/config/settings.json`,
      abs: join(root, id, 'config', 'settings.json'),
    });
  return { files, lines: [] };
}

type Scan =
  | { kind: 'none' }
  | { kind: 'unknown'; why: string }
  | { kind: 'ok'; text: string; root: Obj; pins: [string, unknown][] };

function scan(abs: string): Scan {
  let read: ReturnType<typeof readSettings>;
  try {
    read = readSettings(abs);
  } catch (err) {
    return { kind: 'unknown', why: `读不了（${code(err)}）` };
  }
  if (read.kind === 'none') return { kind: 'none' };
  if (read.kind === 'bad') return { kind: 'unknown', why: read.why };
  if (!isObj(read.root)) return { kind: 'unknown', why: '整份不是一个 JSON 对象' };
  const env = read.root.env;
  if (env !== undefined && !isObj(env)) return { kind: 'unknown', why: 'env 不是对象' };
  const pins = MODEL_PIN_KEYS.filter((k) => env?.[k] !== undefined).map((k): [string, unknown] => [
    k,
    env?.[k],
  ]);
  return { kind: 'ok', text: read.text, root: read.root, pins };
}

const keyOf = (t: Target): string => `~/${t.rel}#env`;
const pinText = (pins: [string, unknown][]): string =>
  pins.map(([k, v]) => `env.${k} 钉在 ${JSON.stringify(v)}`).join('、');

export function checkModelPins(ctx: Ctx): Line[] {
  const { files, lines } = targets(ctx);
  for (const t of files) {
    const s = scan(t.abs);
    if (s.kind === 'none') continue;
    if (s.kind === 'unknown') lines.push(line('unknown', keyOf(t), `没查成——${s.why}`));
    else if (s.pins.length) lines.push(line('drift', keyOf(t), `漂移——${pinText(s.pins)}：${WHY}`));
    else lines.push(line('ok', keyOf(t), '没有钉死的模型别名'));
  }
  return lines;
}

export function applyModelPins(ctx: Ctx, backups: Backups): Line[] {
  const { files, lines } = targets(ctx);
  for (const t of files) {
    const s = scan(t.abs);
    if (s.kind === 'none') continue;
    if (s.kind === 'unknown') {
      lines.push(line('unknown', keyOf(t), `没查成——${s.why}，没动`));
      continue;
    }
    if (s.pins.length === 0) {
      lines.push(line('ok', keyOf(t), '没有钉死的模型别名'));
      continue;
    }
    try {
      const next = structuredClone(s.root);
      const env = next.env as Obj;
      for (const [k] of s.pins) delete env[k];
      const eol = s.text.includes('\r\n') ? '\r\n' : '\n';
      const saved = backups.saveFile(t.abs, t.rel);
      writeAtomic(t.abs, `${JSON.stringify(next, null, 2)}\n`.replaceAll('\n', eol), undefined);
      lines.push(line('changed', keyOf(t), `删了 ${pinText(s.pins)}（${WHY}），原文件备份在 ${saved}`));
    } catch (err) {
      lines.push(line('failed', keyOf(t), `没做成——${code(err)}`));
    }
  }
  return lines;
}
