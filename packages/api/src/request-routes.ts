// 驾驶舱「提需求」的接口（#2049）：路径取自 shared 的 WebRoutes，存储在 request-store-pg.ts，能不能做的判法在 shared 的 request-rules.ts。
// 说话人、发起人、拍板人一律取登录会话里的用户（c.get('user')）；请求体里的身份字段按 zod 约定剥掉，不看。
// 读接口没接上回 200 + unavailable（不拿空列表冒充没有）；写接口没接上回 503。
import {
  AnswerEngineAskRequest,
  CreateRequestRequest,
  MarkRequestReadRequest,
  MarkRequestReadResponse,
  RequestActionRequest,
  RequestDetailResponse,
  RequestIssueOpeningQuery,
  RequestIssueOpeningResponse,
  RequestListQuery,
  RequestListResponse,
  SendRequestMessageRequest,
  UpdateRequestDraftRequest,
  WebRoutes,
} from '@fleet-dao/shared';
import type { Context, Hono } from 'hono';
import type { Deps } from './deps.ts';
import { ApiError, readJson, readQuery, reply } from './http.ts';
import { REQUESTS_NOT_HERE, type RequestsPort } from './request-store-pg.ts';
import type { CockpitEnv } from './session.ts';

function seqOf(c: Context<CockpitEnv>): number {
  const raw = c.req.param('seq') ?? '';
  if (!/^[1-9]\d{0,8}$/.test(raw)) throw new ApiError(400, 'invalid_seq', `需求号认不出：${raw}`);
  return Number(raw);
}

export function registerRequestRoutes(app: Hono<CockpitEnv>, deps: Deps): void {
  const port = (): RequestsPort => {
    if (!deps.requests) throw new ApiError(503, 'requests_unavailable', REQUESTS_NOT_HERE);
    return deps.requests;
  };

  const detail = async (c: Context<CockpitEnv>, seq: number, status: 200 | 201 = 200) => {
    const body = await port().detail(seq, c.get('user').id);
    if (!body) throw new ApiError(404, 'request_not_found', `没有需求 ${seq}`);
    return reply(c, RequestDetailResponse, { asOf: deps.now().toISOString(), ...body }, status);
  };

  app.get(WebRoutes.requests.path, async (c) => {
    const query = readQuery(c, RequestListQuery);
    const base = { asOf: deps.now().toISOString(), view: query.view, filter: query.filter };
    if (!deps.requests) {
      return reply(c, RequestListResponse, {
        ...base,
        counts: { todo: 0, all: 0, mine: 0, archived: 0, deleted: 0 },
        items: [],
        unavailable: REQUESTS_NOT_HERE,
      });
    }
    const body = await deps.requests.list(c.get('user').id, query);
    return reply(c, RequestListResponse, { ...base, ...body });
  });

  app.post(WebRoutes.createRequest.path, async (c) => {
    const input = await readJson(c, CreateRequestRequest);
    const seq = await port().create(c.get('user').id, input);
    return detail(c, seq, 201);
  });

  app.get(WebRoutes.requestDetail.path, async (c) => detail(c, seqOf(c)));

  app.post(WebRoutes.sendRequestMessage.path, async (c) => {
    const seq = seqOf(c);
    const input = await readJson(c, SendRequestMessageRequest);
    await port().send(seq, c.get('user').id, input);
    return detail(c, seq);
  });

  app.put(WebRoutes.updateRequestDraft.path, async (c) => {
    const seq = seqOf(c);
    const input = await readJson(c, UpdateRequestDraftRequest);
    await port().editDraft(seq, c.get('user').id, input);
    return detail(c, seq);
  });

  app.post(WebRoutes.requestAction.path, async (c) => {
    const seq = seqOf(c);
    const input = await readJson(c, RequestActionRequest);
    await port().act(seq, c.get('user').id, input);
    return detail(c, seq);
  });

  // 开单这一键（需求号 + 草稿版本号）开没开成：页面点「确定，开单」超时后用它回显，不让人重点
  app.get(WebRoutes.requestIssueOpening.path, async (c) => {
    const seq = seqOf(c);
    const query = readQuery(c, RequestIssueOpeningQuery);
    const body = await port().openingState(seq, query.draftVersion);
    if (!body) throw new ApiError(404, 'request_not_found', `没有需求 ${seq}`);
    return reply(c, RequestIssueOpeningResponse, { asOf: deps.now().toISOString(), ...body });
  });

  // 回答引擎的提问：答复写回那条 GitHub 评论下面；写失败记 failed 回 502，同一个接口再调一次就是重试
  app.post(WebRoutes.answerRequestEngineAsk.path, async (c) => {
    const seq = seqOf(c);
    const raw = c.req.param('messageId') ?? '';
    if (!/^[1-9]\d{0,15}$/.test(raw)) throw new ApiError(400, 'invalid_message_id', `消息号认不出：${raw}`);
    const input = await readJson(c, AnswerEngineAskRequest);
    await port().answerAsk(seq, c.get('user').id, Number(raw), input.text);
    return detail(c, seq);
  });

  app.post(WebRoutes.markRequestRead.path, async (c) => {
    const seq = seqOf(c);
    const input = await readJson(c, MarkRequestReadRequest);
    const last = await port().markRead(seq, c.get('user').id, input.messageId);
    return reply(c, MarkRequestReadResponse, { lastReadMessageId: last });
  });
}
