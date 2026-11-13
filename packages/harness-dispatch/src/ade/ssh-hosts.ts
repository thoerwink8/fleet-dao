// SSH 宿主登记（#3928）。文件在数据目录，不进仓。
// 一项只有别名、ssh 目标、密钥路径。密钥正文不读、不写进配置、不进事件。
// `ssh -T <别名>` 靠写进用户 ssh config 的 Host 块认目标和密钥路径，启动命令本身不加别的参数。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sshHostdLaunch } from '@fleet-dao/harness-runner';

const ALLOWED = new Set(['alias', 'target', 'keyPath']);
export const SSH_CONFIG_BEGIN = '# fleet2-hosts:begin';
export const SSH_CONFIG_END = '# fleet2-hosts:end';

export interface SshHost {
  alias: string;
  target: string;
  keyPath: string;
}

export interface SshTarget {
  user?: string;
  host: string;
  port?: string;
}

export function defaultSshDir(): string {
  return join(homedir(), '.ssh');
}

export function sshHostsPath(dataDir: string): string {
  return join(dataDir, 'ssh-hosts.json');
}

function keyPathOk(p: string): boolean {
  if (p.length < 1 || p.length > 1024) return false;
  if (/[\r\n\0]/.test(p)) return false;
  if (/-----BEGIN |PRIVATE KEY/.test(p)) return false;
  return true;
}

/** user@host、host，或在目标字符串里带 sshd 的口（user@host:22）。没有单独的转发项。 */
export function splitTarget(target: string): SshTarget {
  if (target.length === 0 || target.length > 200 || /[\s'"\\]/.test(target)) {
    throw new Error('ssh 目标不合法');
  }
  let rest = target;
  let user: string | undefined;
  const at = rest.indexOf('@');
  if (at !== -1) {
    user = rest.slice(0, at);
    rest = rest.slice(at + 1);
    if (!/^[A-Za-z0-9._-]+$/.test(user) || rest.includes('@')) throw new Error('ssh 目标不合法');
  }
  let host = rest;
  let port: string | undefined;
  const colon = rest.lastIndexOf(':');
  if (colon !== -1) {
    host = rest.slice(0, colon);
    port = rest.slice(colon + 1);
    if (!/^[1-9][0-9]{0,4}$/.test(port)) throw new Error('ssh 目标不合法');
    const n = Number(port);
    if (n < 1 || n > 65535) throw new Error('ssh 目标不合法');
  }
  if (!/^[A-Za-z0-9._-]+$/.test(host)) throw new Error('ssh 目标不合法');
  return { ...(user ? { user } : {}), host, ...(port ? { port } : {}) };
}

export function parseSshHost(value: unknown): SshHost {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('宿主要是对象');
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!ALLOWED.has(key)) throw new Error(`宿主配置不认「${key.slice(0, 40)}」`);
  }
  if (typeof raw.alias !== 'string') throw new Error('别名不合法');
  try {
    sshHostdLaunch(raw.alias);
  } catch {
    throw new Error('别名不合法');
  }
  if (typeof raw.target !== 'string') throw new Error('ssh 目标不合法');
  splitTarget(raw.target);
  if (typeof raw.keyPath !== 'string' || !keyPathOk(raw.keyPath)) throw new Error('密钥路径不合法');
  return { alias: raw.alias, target: raw.target, keyPath: raw.keyPath };
}

function quoteSshPath(p: string): string {
  const n = p.replaceAll('\\', '/');
  if (/[\s"#]/.test(n)) return `"${n.replaceAll('"', '\\"')}"`;
  return n;
}

/** 给 OpenSSH 的 Host 块。IdentityFile 只写路径。 */
export function renderSshConfig(hosts: readonly SshHost[]): string {
  const lines = [SSH_CONFIG_BEGIN];
  for (const host of hosts) {
    const t = splitTarget(host.target);
    lines.push(`Host ${host.alias}`, `  HostName ${t.host}`);
    if (t.user) lines.push(`  User ${t.user}`);
    if (t.port) lines.push(`  Port ${t.port}`);
    lines.push(
      `  IdentityFile ${quoteSshPath(host.keyPath)}`,
      '  IdentitiesOnly yes',
      '  BatchMode yes',
      '  StrictHostKeyChecking accept-new',
    );
  }
  lines.push(SSH_CONFIG_END);
  return lines.join('\n');
}

export function mergeSshConfig(existing: string, block: string): string {
  const begin = existing.indexOf(SSH_CONFIG_BEGIN);
  const end = existing.indexOf(SSH_CONFIG_END);
  if (begin !== -1 && end > begin) {
    const head = existing.slice(0, begin).replace(/\s*$/, '');
    const tail = existing.slice(end + SSH_CONFIG_END.length).replace(/^\s*/, '');
    const parts = [head, block, tail].filter((p) => p !== '');
    return `${parts.join('\n')}\n`;
  }
  const rest = existing.trim();
  return rest ? `${block}\n${rest}\n` : `${block}\n`;
}

export async function loadSshHosts(dataDir: string): Promise<SshHost[]> {
  let raw: string;
  try {
    raw = await readFile(sshHostsPath(dataDir), 'utf8');
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
    if (code === 'ENOENT') return [];
    throw new Error('宿主配置读不到');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('宿主配置不是 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('宿主配置不合法');
  const obj = parsed as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key !== 'hosts') throw new Error(`宿主配置不认「${key.slice(0, 40)}」`);
  }
  if (!Array.isArray(obj.hosts)) throw new Error('宿主配置不合法');
  return obj.hosts.map(parseSshHost);
}

export async function saveSshHosts(dataDir: string, hosts: readonly SshHost[]): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const clean = hosts.map(parseSshHost);
  const path = sshHostsPath(dataDir);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ hosts: clean }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, path);
}

export async function writeSshConfig(sshDir: string, hosts: readonly SshHost[]): Promise<void> {
  await mkdir(sshDir, { recursive: true });
  const path = join(sshDir, 'config');
  let existing = '';
  try {
    existing = await readFile(path, 'utf8');
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
    if (code !== 'ENOENT') throw new Error('SSH 配置读不到');
  }
  const next = mergeSshConfig(existing, renderSshConfig(hosts));
  const tmp = `${path}.tmp`;
  await writeFile(tmp, next.endsWith('\n') ? next : `${next}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, path);
}
