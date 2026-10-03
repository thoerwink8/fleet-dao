// 会话的思考档位（#470）：叫法、没配用哪档、各执行方式认哪些档、一条路由能配哪几档。
// 引擎起会话（engine 的 hosts.ts applySessionEffort）、路由骨架装进库和驾驶舱改档位（db 的 routing-apply.ts、
// setRoutingEffort）都照这一份判，不各写一份：这里说能配的，起会话时不会因为档位起不来。
// 改这里之前必须知道：各家命令行的参数在 adapters（claude-code/args.ts、grok/args.ts、mirasim/run.ts）里再认一次，
// 这里加一档或给哪家放开一档，那边的参数要跟着认，否则这里放行、起会话时插头照样拒。
import type { HostId } from './domain.ts';

/** 认的写法，从低到高（和 `claude --effort` 的 help 一致）。不在这里的一律不认识。 */
export const SESSION_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type SessionEffort = (typeof SESSION_EFFORTS)[number];

/**
 * 没配用这一档。创始人 2026-09-28 傍晚拍（specs/169-Fusion形态/需求.md「各家模型干活的会话思考档位默认 high」）：
 * 总是显式传，不靠各家命令行自己的默认（Grok 自己默认 xhigh）。
 */
export const DEFAULT_SESSION_EFFORT: SessionEffort = 'high';

/** Grok 命令行 `--reasoning-effort` 认的档。help 不列取值；max 是 Claude Code `--effort` 才有的。 */
export const GROK_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const satisfies readonly SessionEffort[];

export function isSessionEffort(value: unknown): value is SessionEffort {
  return typeof value === 'string' && (SESSION_EFFORTS as readonly string[]).includes(value);
}

/** 从低到高第几档（low 是 0）。 */
export function effortRank(effort: SessionEffort): number {
  return SESSION_EFFORTS.indexOf(effort);
}

/**
 * 各执行方式起会话时怎么收档位：
 * - flag：有单独的参数，只认 allowed 里的档（Claude Code 的 --effort、Grok 的 --reasoning-effort、Mirasim 的 effort）；
 * - bracket：没有单独的参数，档位写进模型串的方括号（cursor-agent：`composer-2.5[fast=true,effort=high]`）；
 * - none：不收档位，why 接在执行方式的名字后面说为什么。
 */
export type HostEffortSupport =
  | { kind: 'flag'; allowed: readonly SessionEffort[] }
  | { kind: 'bracket' }
  | { kind: 'none'; why: string };

export const HOST_EFFORT_SUPPORT: Readonly<Record<HostId, HostEffortSupport>> = {
  'claude-code': { kind: 'flag', allowed: SESSION_EFFORTS },
  grok: { kind: 'flag', allowed: GROK_EFFORTS },
  mirasim: { kind: 'flag', allowed: SESSION_EFFORTS },
  'cursor-agent': { kind: 'bracket' },
  codex: { kind: 'none', why: '引擎还没接上，起不了会话' },
  'api-shell': { kind: 'none', why: '跑的是判断题小模型，不起会话' },
};

/** 模型串方括号里表示档位的键（cursor / ACP，docs/reference/adapters.md）。 */
const MODEL_EFFORT_KEYS = ['effort', 'reasoning_effort', 'reasoning', 'thought_level'] as const;

/** 模型串带不带方括号（`composer-2.5[fast=true]`）。 */
export function hasModelBrackets(model: string): boolean {
  return /\[[^\]]*\]/.test(model);
}

/** 方括号里已经写了的档位（原样给出，认不认另判）。写了两处还对不上就抛错。没有方括号、或方括号里没有档位键，返回 undefined。 */
export function modelBracketEffort(model: string): string | undefined {
  let found: string | undefined;
  for (const group of model.matchAll(/\[([^\]]*)\]/g)) {
    for (const part of (group[1] ?? '').split(',')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      const key = part.slice(0, eq).trim();
      if (!(MODEL_EFFORT_KEYS as readonly string[]).includes(key)) continue;
      const value = part.slice(eq + 1).trim();
      if (found !== undefined && found !== value) {
        throw new Error(`模型串里的思考档位写了两处还对不上：${JSON.stringify(model)}`);
      }
      found = value;
    }
  }
  return found;
}

/**
 * 一条路由能配哪几档。model 是起会话时发给执行体的模型串（路由的 upstream_model，没有就是模型 id）；who 是给人看的执行方式名，
 * 拼进原因里。choices：能配的，从低到高；fixed：配不了，why 说为什么（模型串方括号里已经写了档位的，embedded 是写的那一档）。
 */
export type RouteEffortChoices =
  | { kind: 'choices'; values: readonly SessionEffort[] }
  | { kind: 'fixed'; why: string; embedded?: string };

export function routeEffortChoices(hostId: HostId, model: string, who: string = hostId): RouteEffortChoices {
  const support = HOST_EFFORT_SUPPORT[hostId];
  if (support.kind === 'none') return { kind: 'fixed', why: `${who}${support.why}` };
  let embedded: string | undefined;
  try {
    embedded = modelBracketEffort(model);
  } catch (error) {
    return { kind: 'fixed', why: (error as Error).message };
  }
  if (embedded !== undefined) {
    return { kind: 'fixed', why: `模型串 ${model} 的方括号里已经写了档位 ${embedded}`, embedded };
  }
  if (support.kind === 'bracket') {
    return hasModelBrackets(model)
      ? { kind: 'choices', values: SESSION_EFFORTS }
      : {
          kind: 'fixed',
          why: `${who} 没有单独的档位参数，模型串 ${model} 不带方括号（是上游目录里的整串，档位已经在名字里）`,
        };
  }
  return { kind: 'choices', values: support.allowed };
}

/**
 * 这条路由能不能配这一档：能配回 null，不能回一句白话原因。驾驶舱改档位、骨架装进库时照它拒；引擎起会话前照它判。
 * 方括号里已经写了同一档的不算错（等于没另配）。
 */
export function routeEffortProblem(
  hostId: HostId,
  model: string,
  effort: string,
  who: string = hostId,
): string | null {
  if (!isSessionEffort(effort)) {
    return `思考档位（effort）不认识：${JSON.stringify(effort)}（只有 ${SESSION_EFFORTS.join(' / ')}）`;
  }
  const choices = routeEffortChoices(hostId, model, who);
  if (choices.kind === 'fixed') {
    if (choices.embedded !== undefined) {
      return choices.embedded === effort
        ? null
        : `思考档位写了两处：模型串方括号里是 ${choices.embedded}，路由上又配了 ${JSON.stringify(effort)}。方括号里已经有的不再另传`;
    }
    return `${who} 不支持单独传思考档位（effort）${JSON.stringify(effort)}：${choices.why}`;
  }
  if (!choices.values.includes(effort)) {
    return `${who} 不支持思考档位（effort）${effort}（只认 ${choices.values.join(' / ')}）`;
  }
  return null;
}
