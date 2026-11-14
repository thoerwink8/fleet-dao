// 只读文件树（#3933）：列出的路径都在工作区根下；打开文本带正文和内容哈希；没有写入、改名、删除。
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { realpath } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { LOCAL_TOKEN_HEADER } from '@fleet-dao/harness-api';
import { afterEach, describe, expect, it } from 'vitest';
import { createAdeHandler } from './http.ts';
import type { AdeService } from './service.ts';

const TOKEN = 'c'.repeat(64);
const OUTSIDE_BODY = '工作区外的正文';
const TEXT = '工作区正文-hello\n';

function handlerFor(workspaces: { id: string; path: string }[]) {
  const ade = { listWorkspaces: async () => workspaces } as unknown as AdeService;
  return createAdeHandler(ade, TOKEN, null);
}

function call(
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>,
  method: string,
  url: string,
): Promise<{ status: number; raw: string }> {
  const req = Readable.from([]) as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = { [LOCAL_TOKEN_HEADER]: TOKEN };
  const chunks: Buffer[] = [];
  let status = 0;
  let headersSent = false;
  const res = {
    get headersSent() {
      return headersSent;
    },
    writeHead(code: number) {
      status = code;
      headersSent = true;
    },
    end(body?: string) {
      if (body) chunks.push(Buffer.from(body));
    },
  } as unknown as ServerResponse;
  return handle(req, res).then(() => ({ status, raw: Buffer.concat(chunks).toString('utf8') }));
}

function underRoot(root: string, rel: string): boolean {
  if (rel === '' || isAbsolute(rel) || rel.split(/[/\\]/).includes('..')) return false;
  const out = relative(root, resolve(root, rel));
  return out !== '' && !isAbsolute(out) && !out.split(/[/\\]/).includes('..');
}

async function stays(root: string, rel: string): Promise<boolean> {
  if (!underRoot(root, rel)) return false;
  const base = await realpath(root);
  const abs = await realpath(resolve(root, rel));
  const out = relative(base, abs);
  return !isAbsolute(out) && !out.split(/[/\\]/).includes('..');
}

function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, prefix: string) => {
    for (const name of readdirSync(current)) {
      const rel = prefix === '' ? name : `${prefix}/${name}`;
      const abs = join(current, name);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) out.push(`${rel}->${readlinkSync(abs)}`);
      else if (st.isDirectory()) walk(abs, rel);
      else out.push(`${rel}:${readFileSync(abs, 'utf8')}`);
    }
  };
  walk(dir, '');
  return out.sort();
}

function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('只读文件树', () => {
  let scratch = '';
  afterEach(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    scratch = '';
  });

  it('列出目录只含工作区根下的相对路径；工作区外路径 4xx 且响应没有正文', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'fleet2-files-'));
    const root = join(scratch, 'ws');
    const outside = join(scratch, 'secret.txt');
    mkdirSync(join(root, 'dir'), { recursive: true });
    writeFileSync(join(root, 'hello.txt'), TEXT);
    writeFileSync(join(root, 'dir', 'note.txt'), '子目录\n');
    writeFileSync(outside, OUTSIDE_BODY);
    symlinkSync(outside, join(root, 'leak'));
    const handle = handlerFor([{ id: 'w1', path: root }]);
    const up = '..';

    const listed = await call(handle, 'GET', '/api/ade/workspaces/w1/files');
    expect(listed.status).toBe(200);
    const entries = (JSON.parse(listed.raw) as { entries: { path: string; kind: string }[] }).entries;
    expect(entries.map((e) => `${e.kind}:${e.path}`)).toEqual(['dir:dir', 'file:hello.txt']);
    for (const entry of entries) {
      expect(entry.path.startsWith('/')).toBe(false);
      expect(await stays(root, entry.path)).toBe(true);
    }
    expect(listed.raw).not.toContain(OUTSIDE_BODY);
    expect(listed.raw).not.toContain(outside);

    const nested = await call(handle, 'GET', '/api/ade/workspaces/w1/files?path=dir');
    expect(nested.status).toBe(200);
    const nestedEntries = (JSON.parse(nested.raw) as { entries: { path: string }[] }).entries;
    expect(nestedEntries.map((e) => e.path)).toEqual(['dir/note.txt']);
    expect(await stays(root, 'dir/note.txt')).toBe(true);

    const probes = [`${up}/${'secret.txt'}`, outside, 'leak', `dir/${up}/${up}/secret.txt`, '/etc/passwd'];
    const passwd = readFileSync('/etc/passwd', 'utf8').split('\n')[0] ?? '';
    expect(passwd.length).toBeGreaterThan(0);
    for (const rel of probes) {
      for (const which of ['files', 'file']) {
        const res = await call(
          handle,
          'GET',
          `/api/ade/workspaces/w1/${which}?path=${encodeURIComponent(rel)}`,
        );
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
        expect(res.raw).not.toContain(OUTSIDE_BODY);
        expect(res.raw).not.toContain(passwd);
      }
    }
  });

  it('打开文本文件含正文和内容哈希，且没有写入、改名、删除的路由', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'fleet2-files-'));
    const root = join(scratch, 'ws');
    mkdirSync(root);
    const file = join(root, 'hello.txt');
    writeFileSync(file, TEXT);
    const before = tree(scratch);
    const handle = handlerFor([{ id: 'w1', path: root }]);

    const opened = await call(handle, 'GET', '/api/ade/workspaces/w1/file?path=hello.txt');
    expect(opened.status).toBe(200);
    const body = JSON.parse(opened.raw) as { text?: string; hash?: string };
    expect(body.text).toBe(TEXT);
    expect(body.hash).toBe(createHash('sha256').update(Buffer.from(TEXT)).digest('hex'));

    const methods = ['POST', 'PUT', 'PATCH', 'DELETE'];
    const paths = [
      '/api/ade/workspaces/w1/files',
      '/api/ade/workspaces/w1/file',
      '/api/ade/workspaces/w1/files/write',
      '/api/ade/workspaces/w1/files/rename',
      '/api/ade/workspaces/w1/files/delete',
      '/api/ade/workspaces/w1/file/rename',
    ];
    for (const method of methods) {
      for (const path of paths) {
        const res = await call(handle, method, path);
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
        expect(res.raw).not.toContain(TEXT);
      }
    }
    expect(tree(scratch)).toEqual(before);
    expect(readFileSync(file, 'utf8')).toBe(TEXT);

    const filesSrc = strip(readFileSync(fileURLToPath(new URL('./files.ts', import.meta.url)), 'utf8'));
    const httpSrc = strip(readFileSync(fileURLToPath(new URL('./http.ts', import.meta.url)), 'utf8'));
    expect(filesSrc).not.toMatch(
      /\b(writeFile|appendFile|rename|unlink|rmSync|rmdir|mkdir|copyFile|truncate)\s*\(/,
    );
    expect(filesSrc).not.toMatch(/['"](?:POST|PUT|PATCH|DELETE)['"]/);
    expect(httpSrc).not.toMatch(/\/files\/(?:write|rename|delete)/);
    expect(httpSrc).toMatch(/routeFiles\(/);
  });
});
