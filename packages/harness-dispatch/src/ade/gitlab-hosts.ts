// 自建 GitLab 的主机名和令牌只放数据目录（#3944）。
// 主机名清单里没有令牌。令牌一个主机一个文件，不进仓、不进 outbox。
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const HOST =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;

export function gitlabHostsPath(dataDir: string): string {
  return join(dataDir, 'gitlab-hosts.json');
}

export function gitlabTokenPath(dataDir: string, host: string): string {
  return join(dataDir, 'gitlab-tokens', `${host}.token`);
}

/** 只收主机名。带协议、路径、用户名的直接拒，避免把令牌写进清单。 */
export function normalizeGitlabHost(raw: string): string {
  const text = raw.trim().toLowerCase();
  if (!text) throw new Error('主机名是空的');
  if (/[:/@\\]/.test(text)) throw new Error('只登记主机名，不要带地址和令牌');
  if (!HOST.test(text)) throw new Error('主机名不对');
  return text;
}

export function normalizeGitlabToken(raw: string): string {
  const text = raw.trim();
  if (text.length < 8 || text.length > 200) throw new Error('令牌长度不对');
  if (/[\s\r\n\0]/.test(text)) throw new Error('令牌不对');
  return text;
}

export async function loadGitlabHosts(dataDir: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(gitlabHostsPath(dataDir), 'utf8');
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
    if (code === 'ENOENT') return [];
    throw new Error('GitLab 主机名读不到');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('GitLab 主机名不是 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('GitLab 主机名不合法');
  const obj = parsed as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key !== 'hosts') throw new Error(`GitLab 主机名不认「${key.slice(0, 40)}」`);
  }
  if (!Array.isArray(obj.hosts)) throw new Error('GitLab 主机名不合法');
  return obj.hosts.map((item) => {
    if (typeof item !== 'string') throw new Error('GitLab 主机名不合法');
    return normalizeGitlabHost(item);
  });
}

async function writeHosts(dataDir: string, hosts: readonly string[]): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const path = gitlabHostsPath(dataDir);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ hosts }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, path);
}

export async function addGitlabHost(dataDir: string, raw: string): Promise<string[]> {
  const host = normalizeGitlabHost(raw);
  const hosts = await loadGitlabHosts(dataDir);
  if (!hosts.includes(host)) hosts.push(host);
  await writeHosts(dataDir, hosts);
  return hosts;
}

export async function removeGitlabHost(dataDir: string, raw: string): Promise<string[]> {
  const host = normalizeGitlabHost(raw);
  const hosts = (await loadGitlabHosts(dataDir)).filter((item) => item !== host);
  await writeHosts(dataDir, hosts);
  await rm(gitlabTokenPath(dataDir, host), { force: true });
  return hosts;
}

export async function readGitlabToken(dataDir: string, host: string): Promise<string | null> {
  const name = normalizeGitlabHost(host);
  try {
    const text = (await readFile(gitlabTokenPath(dataDir, name), 'utf8')).trim();
    return text ? normalizeGitlabToken(text) : null;
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
    if (code === 'ENOENT') return null;
    throw new Error('GitLab 令牌读不到');
  }
}

export async function saveGitlabToken(dataDir: string, rawHost: string, rawToken: string): Promise<void> {
  const host = normalizeGitlabHost(rawHost);
  const token = normalizeGitlabToken(rawToken);
  if (host !== 'gitlab.com') {
    const hosts = await loadGitlabHosts(dataDir);
    if (!hosts.includes(host)) await writeHosts(dataDir, [...hosts, host]);
  }
  const path = gitlabTokenPath(dataDir, host);
  await mkdir(join(dataDir, 'gitlab-tokens'), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, token, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, path);
}

export interface GitlabHostRow {
  host: string;
  hasToken: boolean;
  builtin: boolean;
}

/** 给设置页。gitlab.com 始终在，不用登记。不返回令牌。 */
export async function gitlabHostRows(dataDir: string): Promise<GitlabHostRow[]> {
  const registered = await loadGitlabHosts(dataDir);
  const names = ['gitlab.com', ...registered.filter((host) => host !== 'gitlab.com')];
  const rows: GitlabHostRow[] = [];
  for (const host of names) {
    rows.push({
      host,
      hasToken: (await readGitlabToken(dataDir, host)) !== null,
      builtin: host === 'gitlab.com',
    });
  }
  return rows;
}
