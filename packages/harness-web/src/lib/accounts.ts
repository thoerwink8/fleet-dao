// 设置页「模型与账号」（#3925）。接口不回密钥。
import { adeGet, adeSend } from './ade';

export interface SavedAccount {
  id: string;
  label: string;
  active: boolean;
}

export interface AccountAgent {
  id: string;
  ready: boolean;
  login: string;
  account: string;
  models: string[];
  modelsNote: string;
  saved: SavedAccount[];
}

export interface AccountRelay {
  id: string;
  name: string;
  baseUrl: string;
  hasKey: boolean;
  models: string[];
}

export interface AccountsView {
  agent: string;
  tier: string;
  agents: AccountAgent[];
  relays: AccountRelay[];
}

export const TIERS = [
  { id: 'default', label: '默认' },
  { id: 'low', label: '快' },
  { id: 'high', label: '深' },
] as const;

export function quotaText(value: string | undefined): string {
  const text = value?.trim();
  return text ? text : '读不到';
}

export function loadAccountsView(): Promise<AccountsView> {
  return adeGet('/accounts');
}

export function loadQuota(): Promise<Record<string, string>> {
  return adeGet('/quota');
}

export function saveSelection(agent: string, tier: string): Promise<AccountsView> {
  return adeSend('/accounts', 'POST', { agent, tier });
}

export function saveActive(agent: string, id: string | null): Promise<AccountsView> {
  return adeSend(`/accounts/${agent}/active`, 'POST', { id });
}

export function createAccount(
  agent: string,
  label: string,
  envKey: string,
  envValue: string,
): Promise<AccountsView> {
  return adeSend(`/accounts/${agent}`, 'POST', { label, env: { [envKey]: envValue } });
}

export function deleteAccount(agent: string, id: string): Promise<AccountsView> {
  return adeSend(`/accounts/${agent}/${encodeURIComponent(id)}`, 'DELETE');
}

export function createRelay(input: {
  name: string;
  baseUrl: string;
  key: string;
  models: string;
}): Promise<AccountsView> {
  return adeSend('/relays', 'POST', input);
}

export function deleteRelay(id: string): Promise<AccountsView> {
  return adeSend(`/relays/${encodeURIComponent(id)}`, 'DELETE');
}
