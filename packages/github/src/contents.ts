// 需求文档直接写进主线（「引擎」机器人身份，Contents API）：design 没写清需求文档由谁写、写到哪个分支；
// 这里按 design 十四「主线只有引擎能动」，直接把它当成「引擎」可以动主线的一种写法，写进默认分支——是临时定法，
// PR 正文里点出来，design 补上口径之后再对齐。
import { z } from 'zod';
import { enc, encRef, type RepoRef, unexpected } from './client.ts';
import type { Deps } from './deps.ts';
import { GitHubError, isGitHubError } from './errors.ts';
import { assertPublishable } from './publish-check.ts';

export interface WriteSpecDocInput {
  repo: RepoRef;
  /** 仓内路径，必须在 specs/ 下，例如 specs/12-登录验证码/需求.md */
  path: string;
  content: string;
  message: string;
  signal?: AbortSignal | undefined;
}

export interface WriteSpecDocResult {
  path: string;
  /** 这次写出的提交；内容本来就一样没写时是 null。 */
  commit: string | null;
  changed: boolean;
  /** blob 的网页地址。 */
  url: string;
}

/** 内容按字节数算（GitHub 按文件大小限制，不是字符数），超了发出前就拒。 */
const MAX_CONTENT_BYTES = 1024 * 1024;
/** GitHub 说 sha 过期的两种原文：给的 sha 对不上（409 does not match）、文件已经在了却没给 sha（422）。 */
const STALE_SHA = /does not match|"sha" wasn't supplied/i;
// biome-ignore lint/suspicious/noControlCharactersInRegex: 就是要拦控制字符
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** 路径校验：相对路径、在 specs/ 下的文件（不能就是 specs/ 本身）、不含 `..`、不含反斜杠、不含控制字符、不以 / 开头或结尾。 */
export function validSpecPath(path: string): boolean {
  if (!path || path.length > 400) return false;
  if (path.startsWith('/') || path.endsWith('/') || path.includes('..') || path.includes('\\')) return false;
  if (CONTROL_CHARS.test(path)) return false;
  return path.startsWith('specs/') && path.length > 'specs/'.length;
}

const ContentsFile = z.object({
  sha: z.string(),
  content: z.string().optional(),
  html_url: z.string(),
});

const WriteReceipt = z.object({
  content: z.object({ sha: z.string(), html_url: z.string() }),
  commit: z.object({ sha: z.string() }),
});

interface Existing {
  sha: string;
  content: string;
  url: string;
}

export interface ReadSpecDocInput {
  repo: RepoRef;
  /** 仓内路径，必须在 specs/ 下，例如 specs/12-登录验证码/需求.md */
  path: string;
  signal?: AbortSignal | undefined;
}

export interface ReadSpecDocResult {
  path: string;
  content: string;
  url: string;
}

/**
 * 读默认分支上的需求文档。开 PR 的正文要写「对应计划」「specs」两栏（#41 的 pr-fields 缺了就红），对应计划那一行在
 * 需求文档里（人写了之后也可能手改），所以每次现读一份，不把值抄到工作流的历史里（抄了会和文件分家）。
 * 文件不在返回 null——调用方要说清「需求文档还没进主线」，不当成空文档。
 */
export async function readSpecDoc(deps: Deps, input: ReadSpecDocInput): Promise<ReadSpecDocResult | null> {
  const { repo, path } = input;
  if (!validSpecPath(path)) {
    throw new GitHubError(
      'BAD_INPUT',
      `需求文档路径「${path}」不合规：必须是 specs/ 下的相对路径，不含 ..、反斜杠或控制字符，也不能以 / 开头`,
    );
  }
  const apiPath = `/repos/${enc(repo.owner)}/${enc(repo.name)}/contents/${encRef(path)}`;
  const res = await deps.client.request({
    method: 'GET',
    path: apiPath,
    auth: { as: 'engine' as const, repo },
    allow: [404],
    signal: input.signal,
  });
  if (res.status === 404) return null;
  const parsed = ContentsFile.safeParse(res.data);
  // 目录、子模块、链接拿回来的不是带 content 的文件：认不出，照「回的东西不对」报，不当成空文档
  if (!parsed.success || parsed.data.content === undefined) throw unexpected(`读 ${path}`, res.data);
  const content = Buffer.from(parsed.data.content.replace(/\n/g, ''), 'base64').toString('utf8');
  return { path, content, url: parsed.data.html_url };
}

export async function writeSpecDoc(deps: Deps, input: WriteSpecDocInput): Promise<WriteSpecDocResult> {
  const { repo, path } = input;
  if (!validSpecPath(path)) {
    throw new GitHubError(
      'BAD_INPUT',
      `需求文档路径「${path}」不合规：必须是 specs/ 下的相对路径，不含 ..、反斜杠或控制字符，也不能以 / 开头`,
    );
  }
  const bytes = Buffer.byteLength(input.content, 'utf8');
  if (bytes > MAX_CONTENT_BYTES) {
    throw new GitHubError('BODY_TOO_LONG', `${path} 的内容有 ${bytes} 字节，超过上限 ${MAX_CONTENT_BYTES}`, {
      details: { length: bytes, limit: MAX_CONTENT_BYTES },
    });
  }
  // 直写主线不经 git 推送，推前扫描拦不到：文件名、正文、提交说明写之前各过一遍
  assertPublishable(
    `写 ${path}`,
    [
      { path, text: input.content },
      { path: `${path}（提交说明）`, text: input.message },
    ],
    deps.sensitiveValues,
  );
  const apiPath = `/repos/${enc(repo.owner)}/${enc(repo.name)}/contents/${encRef(path)}`;
  const auth = { as: 'engine' as const, repo };

  const read = async (): Promise<Existing | null> => {
    const res = await deps.client.request({
      method: 'GET',
      path: apiPath,
      auth,
      allow: [404],
      signal: input.signal,
    });
    if (res.status === 404) return null;
    const parsed = ContentsFile.safeParse(res.data);
    if (!parsed.success) throw unexpected(`读 ${path}`, res.data);
    const decoded = Buffer.from((parsed.data.content ?? '').replace(/\n/g, ''), 'base64').toString('utf8');
    return { sha: parsed.data.sha, content: decoded, url: parsed.data.html_url };
  };

  const write = async (sha: string | undefined): Promise<{ commit: string; url: string }> => {
    const res = await deps.client.request({
      method: 'PUT',
      path: apiPath,
      auth,
      body: {
        message: input.message,
        content: Buffer.from(input.content, 'utf8').toString('base64'),
        ...(sha ? { sha } : {}),
      },
      allow: [409, 422],
      signal: input.signal,
    });
    if (res.status === 409 || res.status === 422) {
      const message = (res.data as { message?: string } | null)?.message ?? String(res.status);
      // 409、422 不全是 sha 过期：规则集、保护分支拒写（409「Repository rule violations found」）、路径不合法（422）
      // 重读再写一遍也一样被拒，不许当成过期去重试
      if (STALE_SHA.test(message)) {
        throw new GitHubError('SPEC_DOC_CONFLICT', `写 ${path} 时 sha 过期了（${message}）`, {
          retryable: true,
          status: res.status,
        });
      }
      throw new GitHubError(
        'SPEC_DOC_REJECTED',
        `GitHub 拒绝写 ${path}（${res.status}：${message}）：不是 sha 过期，重试没用——多半是主线的规则集或保护不让「引擎」直写，要人看`,
        { retryable: false, status: res.status },
      );
    }
    const parsed = WriteReceipt.safeParse(res.data);
    if (!parsed.success) throw unexpected(`写 ${path} 的回执`, res.data);
    return { commit: parsed.data.commit.sha, url: parsed.data.content.html_url };
  };

  const existing = await read();
  if (existing && existing.content === input.content) {
    return { path, commit: null, changed: false, url: existing.url };
  }
  try {
    const result = await write(existing?.sha);
    return { path, commit: result.commit, changed: true, url: result.url };
  } catch (err) {
    // sha 过期：远端已经被改过，重读最新的再试一次；还是一样的内容就不用写了，否则用新 sha 再写一次。
    if (!isGitHubError(err, 'SPEC_DOC_CONFLICT')) throw err;
    const fresh = await read();
    if (fresh && fresh.content === input.content) {
      return { path, commit: null, changed: false, url: fresh.url };
    }
    const result = await write(fresh?.sha);
    return { path, commit: result.commit, changed: true, url: result.url };
  }
}
