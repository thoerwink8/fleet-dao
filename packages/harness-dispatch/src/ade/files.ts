// 只读文件树（#3933）。只列、只读工作区根下的相对路径。没有写入、改名、删除。
import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { AdeError, type AdeService } from './service.ts';

const TEXT_CAP = 1024 * 1024;

interface FileEntry {
  path: string;
  kind: 'file' | 'dir';
}

function badPath(): AdeError {
  return new AdeError('路径不在工作区里', 400);
}

function errno(err: unknown): string {
  if (err === null || typeof err !== 'object' || !('code' in err)) return '';
  return typeof err.code === 'string' ? err.code : '';
}

/** 相对路径落在根外（含符号链接指出去）。根自己不算外。 */
function outside(base: string, abs: string): boolean {
  const out = relative(base, abs);
  return isAbsolute(out) || out.split(/[/\\]/).includes('..');
}

/** 拆成工作区根下的段。绝对路径、盘符、`..`、空字节一律拒。空串表示根。 */
function segments(rel: string): string[] {
  const raw = rel.replaceAll('\\', '/');
  if (raw.includes('\0') || isAbsolute(rel) || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw badPath();
  const parts = raw.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.some((part) => part === '..')) throw badPath();
  return parts;
}

async function confine(root: string, rel: string): Promise<{ base: string; abs: string }> {
  let base: string;
  try {
    base = await realpath(root);
  } catch {
    throw new AdeError('工作区目录不在', 404);
  }
  const parts = segments(rel);
  const lexical = resolve(base, ...parts);
  if (parts.length > 0 && outside(base, lexical)) throw badPath();
  let abs = base;
  if (parts.length > 0) {
    try {
      abs = await realpath(lexical);
    } catch (err) {
      if (errno(err) === 'ENOENT') throw new AdeError('没有这个路径', 404);
      throw badPath();
    }
  }
  if (outside(base, abs)) throw badPath();
  return { base, abs };
}

async function listWorkspaceDir(root: string, rel: string): Promise<FileEntry[]> {
  const parts = segments(rel);
  const { base, abs } = await confine(root, rel);
  const info = await stat(abs);
  if (!info.isDirectory()) throw new AdeError('不是目录', 400);
  const prefix = parts.join('/');
  const names = await readdir(abs);
  const entries: FileEntry[] = [];
  for (const name of names) {
    if (
      name === '' ||
      name === '.' ||
      name === '..' ||
      name.includes('\0') ||
      name.includes('/') ||
      name.includes('\\')
    ) {
      continue;
    }
    let childReal: string;
    try {
      childReal = await realpath(resolve(abs, name));
    } catch {
      continue;
    }
    if (outside(base, childReal)) continue;
    let childStat: Awaited<ReturnType<typeof stat>>;
    try {
      childStat = await stat(childReal);
    } catch {
      continue;
    }
    let kind: FileEntry['kind'] | null = null;
    if (childStat.isDirectory()) kind = 'dir';
    else if (childStat.isFile()) kind = 'file';
    if (!kind) continue;
    entries.push({ path: prefix === '' ? name : `${prefix}/${name}`, kind });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

async function readWorkspaceText(root: string, rel: string): Promise<{ text: string; hash: string }> {
  if (segments(rel).length === 0) throw new AdeError('要文件路径', 400);
  const { abs } = await confine(root, rel);
  const info = await stat(abs);
  if (!info.isFile()) throw new AdeError('不是文本文件', 400);
  if (info.size > TEXT_CAP) throw new AdeError('文件太大', 413);
  const buf = await readFile(abs);
  if (buf.includes(0)) throw new AdeError('不是文本文件', 415);
  return { text: buf.toString('utf8'), hash: createHash('sha256').update(buf).digest('hex') };
}

const FILE_ROUTE = /^\/api\/ade\/workspaces\/([^/]+)\/(files|file)$/;

/** 列目录或打开文本。路径对上但不是 GET 时 405，不落到别的路由。对不上回 null。 */
export async function routeFiles(
  ade: Pick<AdeService, 'listWorkspaces'>,
  method: string,
  path: string,
  query: URLSearchParams,
): Promise<{ status: number; body: unknown } | null> {
  const match = FILE_ROUTE.exec(path);
  if (!match) return null;
  if (method !== 'GET') throw new AdeError('只读', 405);
  const id = decodeURIComponent(match[1] ?? '');
  const rows = await ade.listWorkspaces();
  const ws = rows.find((row) => row.id === id);
  if (!ws) throw new AdeError('没有这个工作区', 404);
  const rel = query.get('path') ?? '';
  if (match[2] === 'files') return { status: 200, body: { entries: await listWorkspaceDir(ws.path, rel) } };
  return { status: 200, body: await readWorkspaceText(ws.path, rel) };
}
