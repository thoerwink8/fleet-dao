// 本机 ADE 的账号和中转（#3925）。文件在数据目录，不进仓，也不读法国的路由。
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AdeAgentInfo } from './agents.ts';

export const AGENT_IDS = ['claude', 'grok', 'codex', 'pi'] as const;
export type AgentId = (typeof AGENT_IDS)[number];
export const TIERS = ['default', 'low', 'high'] as const;
export type Tier = (typeof TIERS)[number];

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:=,[\]-]{0,80}$/;
const ID = /^[a-z][a-z0-9]{0,16}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** 能推代码的凭据不进会话环境。模型 key 可以，那是中转要用的。 */
const PUSH_ENV = /^(?:GH_|GITHUB_)|^GIT_ASKPASS$|^GIT_CONFIG_|^SSH_AUTH_SOCK$/i;

export interface AccountSlot {
  id: string;
  label: string;
  /** 起这个账号时合并进进程环境。值只活在数据目录。 */
  env: Record<string, string>;
}

export interface RelaySlot {
  id: string;
  name: string;
  baseUrl: string;
  key: string;
  models: string[];
}

export interface AccountsFile {
  agent: AgentId;
  tier: Tier;
  accounts: Record<AgentId, AccountSlot[]>;
  /** null 表示用机器上 CLI 自己的登录，不额外塞环境。 */
  active: Record<AgentId, string | null>;
  relays: RelaySlot[];
}

export function emptyAccounts(): AccountsFile {
  const accounts = {} as Record<AgentId, AccountSlot[]>;
  const active = {} as Record<AgentId, string | null>;
  for (const id of AGENT_IDS) {
    accounts[id] = [];
    active[id] = null;
  }
  return { agent: 'claude', tier: 'default', accounts, active, relays: [] };
}

export function accountsPath(dataDir: string): string {
  return join(dataDir, 'accounts.json');
}

export async function loadAccounts(dataDir: string): Promise<AccountsFile> {
  let raw: string;
  try {
    raw = await readFile(accountsPath(dataDir), 'utf8');
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
    if (code === 'ENOENT') return emptyAccounts();
    throw new Error('账号配置读不到');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('账号配置不是 JSON');
  }
  return normalize(parsed);
}

export async function saveAccounts(dataDir: string, file: AccountsFile): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const path = accountsPath(dataDir);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(normalize(file), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, path);
}

function isAgent(v: string): v is AgentId {
  return (AGENT_IDS as readonly string[]).includes(v);
}

function isTier(v: string): v is Tier {
  return (TIERS as readonly string[]).includes(v);
}

function normalize(value: unknown): AccountsFile {
  const base = emptyAccounts();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return base;
  const raw = value as Record<string, unknown>;
  if (typeof raw.agent === 'string' && isAgent(raw.agent)) base.agent = raw.agent;
  if (typeof raw.tier === 'string' && isTier(raw.tier)) base.tier = raw.tier;
  const accounts = raw.accounts;
  const active = raw.active;
  if (accounts && typeof accounts === 'object' && !Array.isArray(accounts)) {
    for (const id of AGENT_IDS) {
      const list = (accounts as Record<string, unknown>)[id];
      base.accounts[id] = Array.isArray(list) ? list.map(slotOf).filter((s): s is AccountSlot => !!s) : [];
    }
  }
  if (active && typeof active === 'object' && !Array.isArray(active)) {
    for (const id of AGENT_IDS) {
      const cur = (active as Record<string, unknown>)[id];
      base.active[id] = typeof cur === 'string' && base.accounts[id].some((s) => s.id === cur) ? cur : null;
    }
  }
  base.relays = Array.isArray(raw.relays) ? raw.relays.map(relayOf).filter((r): r is RelaySlot => !!r) : [];
  return base;
}

function slotOf(value: unknown): AccountSlot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || !ID.test(raw.id)) return null;
  if (typeof raw.label !== 'string' || !raw.label.trim()) return null;
  return { id: raw.id, label: raw.label.trim().slice(0, 80), env: envOf(raw.env) };
}

function envOf(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!ENV_KEY.test(key) || PUSH_ENV.test(key) || typeof item !== 'string' || !item) continue;
    out[key] = item;
  }
  return out;
}

function relayOf(value: unknown): RelaySlot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || !ID.test(raw.id)) return null;
  if (typeof raw.name !== 'string' || !raw.name.trim()) return null;
  if (typeof raw.baseUrl !== 'string' || !baseUrlOf(raw.baseUrl)) return null;
  if (typeof raw.key !== 'string' || !raw.key) return null;
  const models = Array.isArray(raw.models)
    ? raw.models.filter((m): m is string => typeof m === 'string' && MODEL.test(m))
    : [];
  if (!models.length) return null;
  return { id: raw.id, name: raw.name.trim().slice(0, 40), baseUrl: raw.baseUrl, key: raw.key, models };
}

export function baseUrlOf(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (url.username || url.password) return false;
    return true;
  } catch {
    return false;
  }
}

export function checkEnv(env: Record<string, string>): void {
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_KEY.test(key)) throw new Error(`环境变量名不合法：${key}`);
    if (PUSH_ENV.test(key)) throw new Error(`这个变量不能放进会话：${key}`);
    if (typeof value !== 'string' || !value || value.length > 4000)
      throw new Error(`${key} 的值不能空，也不能超过 4000 字`);
  }
}

export function relayModelId(relayId: string, model: string): string {
  return `relay.${relayId}.${model}`;
}

export function parseRelayModel(model: string): { relayId: string; model: string } | null {
  const m = /^relay\.([a-z][a-z0-9]{0,16})\.([A-Za-z0-9][A-Za-z0-9._:=,[\]-]{0,80})$/.exec(model);
  if (!m?.[1] || !m[2]) return null;
  return { relayId: m[1], model: m[2] };
}

function tiered(model: string, tier: Tier, available: readonly string[]): string {
  if (tier === 'default') return model;
  for (const hit of [`${model}:${tier}`, `${model}-${tier}`]) {
    if (available.includes(hit)) return hit;
  }
  return model;
}

export interface SpawnPlan {
  /** 交给 CLI 的模型名。中转前缀已去掉，档位后缀在名单里有才加上。 */
  model: string;
  accountId: string;
  env: Record<string, string>;
}

/** tried 为空用当前账号；否则用刚用过的那个的下一个。没有下一个返回 null。 */
export function planSpawn(
  file: AccountsFile,
  agent: string,
  model: string,
  available: readonly string[],
  tried: readonly string[],
): SpawnPlan | null {
  if (!isAgent(agent)) throw new Error(`不认识的 agent：${agent}`);
  const slot = pickSlot(file, agent, tried);
  if (tried.length > 0 && !slot) return null;
  const relayRef = parseRelayModel(model);
  const inner = relayRef?.model ?? model;
  if (!MODEL.test(inner)) throw new Error(`模型名不合法：${model}`);
  const relay = relayRef ? file.relays.find((r) => r.id === relayRef.relayId) : undefined;
  if (relayRef && !relay) throw new Error('没有这个中转');
  const env: Record<string, string> = { FLEET2_TIER: file.tier, ...(slot?.env ?? {}) };
  if (relay) {
    env.OPENAI_BASE_URL = relay.baseUrl;
    env.OPENAI_API_KEY = relay.key;
    if (agent === 'claude') {
      env.ANTHROPIC_BASE_URL = relay.baseUrl;
      env.ANTHROPIC_API_KEY = relay.key;
    }
  }
  checkEnv(env);
  return { model: tiered(inner, file.tier, available), accountId: slot?.id ?? '', env };
}

function pickSlot(file: AccountsFile, agent: AgentId, tried: readonly string[]): AccountSlot | null {
  const list = file.accounts[agent];
  if (tried.length === 0) {
    const id = file.active[agent];
    if (!id) return null;
    return list.find((s) => s.id === id) ?? null;
  }
  const last = tried[tried.length - 1] ?? '';
  if (!last) return list[0] ?? null;
  const index = list.findIndex((s) => s.id === last);
  if (index < 0) return null;
  return list[index + 1] ?? null;
}

/** 工人环境已经过推送凭据禁表。这里只把账号文件里的变量补上去，推送凭据仍然拒绝。 */
export function mergeAccountEnv(
  workerEnv: Record<string, string>,
  extra: Record<string, string>,
): Record<string, string> {
  checkEnv(extra);
  return { ...workerEnv, ...extra };
}

export function withRelayModels(list: readonly AdeAgentInfo[], file: AccountsFile): AdeAgentInfo[] {
  const extra = file.relays.flatMap((r) => r.models.map((m) => relayModelId(r.id, m)));
  if (!extra.length) return list.map((a) => ({ ...a }));
  return list.map((a) => {
    if (a.ready === false) return { ...a };
    const models = [...a.models];
    for (const id of extra) if (!models.includes(id)) models.push(id);
    return { ...a, models };
  });
}

export function newAccountId(): string {
  return `a${randomBytes(4).toString('hex')}`;
}

export function newRelayId(): string {
  return `r${randomBytes(4).toString('hex')}`;
}

export function withSelection(file: AccountsFile, agent: string, tier: string): AccountsFile {
  if (!isAgent(agent)) throw new Error(`不认识的 agent：${agent}`);
  if (!isTier(tier)) throw new Error(`不认识的档位：${tier}`);
  return { ...file, agent, tier };
}

export function withActive(file: AccountsFile, agent: string, activeId: string | null): AccountsFile {
  if (!isAgent(agent)) throw new Error(`不认识的 agent：${agent}`);
  if (activeId !== null && !file.accounts[agent].some((s) => s.id === activeId))
    throw new Error('没有这个账号');
  return { ...file, active: { ...file.active, [agent]: activeId } };
}

export function addAccount(
  file: AccountsFile,
  agent: string,
  label: string,
  env: Record<string, string>,
): AccountsFile {
  if (!isAgent(agent)) throw new Error(`不认识的 agent：${agent}`);
  const name = label.trim();
  if (!name || name.length > 80) throw new Error('账号名要有，并且不超过 80 字');
  checkEnv(env);
  if (!Object.keys(env).length) throw new Error('要有一个环境变量，换号时才知道用哪一份');
  const slot: AccountSlot = { id: newAccountId(), label: name, env };
  return { ...file, accounts: { ...file.accounts, [agent]: [...file.accounts[agent], slot] } };
}

export function removeAccount(file: AccountsFile, agent: string, id: string): AccountsFile {
  if (!isAgent(agent)) throw new Error(`不认识的 agent：${agent}`);
  if (!file.accounts[agent].some((s) => s.id === id)) throw new Error('没有这个账号');
  const accounts = file.accounts[agent].filter((s) => s.id !== id);
  const active = file.active[agent] === id ? null : file.active[agent];
  return {
    ...file,
    accounts: { ...file.accounts, [agent]: accounts },
    active: { ...file.active, [agent]: active },
  };
}

export function modelList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const models = raw.map((m) => (typeof m === 'string' ? m.trim() : '')).filter((m) => MODEL.test(m));
  if (!models.length) throw new Error('至少要一个模型名');
  if (models.length > 20) throw new Error('一个中转最多 20 个模型');
  return models;
}

export function addRelay(
  file: AccountsFile,
  input: { name: string; baseUrl: string; key: string; models: string[] },
): AccountsFile {
  const name = input.name.trim();
  if (!name || name.length > 40) throw new Error('中转名要有，并且不超过 40 字');
  if (!baseUrlOf(input.baseUrl)) throw new Error('中转地址要是 http 或 https，地址里不能带账号密码');
  if (!input.key || input.key.length > 4000) throw new Error('密钥不能空');
  const models = modelList(input.models);
  const relay: RelaySlot = { id: newRelayId(), name, baseUrl: input.baseUrl, key: input.key, models };
  return { ...file, relays: [...file.relays, relay] };
}

export function removeRelay(file: AccountsFile, id: string): AccountsFile {
  if (!file.relays.some((r) => r.id === id)) throw new Error('没有这个中转');
  return { ...file, relays: file.relays.filter((r) => r.id !== id) };
}

export interface AccountsView {
  agent: AgentId;
  tier: Tier;
  agents: {
    id: AgentId;
    ready: boolean;
    login: string;
    account: string;
    models: string[];
    modelsNote: string;
    saved: { id: string; label: string; active: boolean }[];
  }[];
  relays: { id: string; name: string; baseUrl: string; hasKey: boolean; models: string[] }[];
}

export function toView(file: AccountsFile, discovered: readonly AdeAgentInfo[]): AccountsView {
  return {
    agent: file.agent,
    tier: file.tier,
    agents: AGENT_IDS.map((id) => {
      const info = discovered.find((a) => a.id === id);
      const ready = info?.ready !== false && !!info;
      const login = !info ? '没装' : info.ready === false ? (info.note ?? '未登录') : '已登录';
      const active = file.accounts[id].find((s) => s.id === file.active[id]) ?? null;
      const account = active?.label ?? (!info || info.ready === false ? login : info.account || '读不到');
      return {
        id,
        ready,
        login,
        account,
        models: info?.models ?? [],
        modelsNote: info?.modelsNote ?? '',
        saved: file.accounts[id].map((s) => ({ id: s.id, label: s.label, active: s.id === file.active[id] })),
      };
    }),
    relays: file.relays.map((r) => ({
      id: r.id,
      name: r.name,
      baseUrl: r.baseUrl,
      hasKey: r.key.length > 0,
      models: r.models,
    })),
  };
}
