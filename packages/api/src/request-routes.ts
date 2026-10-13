// 驾驶舱「提需求」的接口（#2049）：路径取自 shared 的 WebRoutes，存储在 request-store-pg.ts，能不能做的判法在 shared 的 request-rules.ts。
// 指挥官会话（#2061，C 片）：request-chat-pg.ts 排一轮、停下、换模型、让别家挑错；回话经 SSE（commanderStream）流式推给页面。
// 说话人、发起人、拍板人一律取登录会话里的用户（c.get('user')）；请求体里的身份字段按 zod 约定剥掉，不看。
// 读接口没接上回 200 + unavailable（不拿空列表冒充没有）；写接口没接上回 503。
import {
  AnswerEngineAskRequest,
  CreateRequestRequest,
  MarkRequestReadRequest,
  MarkRequestReadResponse,
  MarkReviewItemRequest,
  REQUEST_CHAT_SSE_EVENTS,
  RequestActionRequest,
  type RequestChatStreamEvent,
  RequestDetailResponse,
  RequestIssueOpeningQuery,
  RequestIssueOpeningResponse,
  RequestListQuery,
  RequestListResponse,
  SendRequestMessageRequest,
  SetRequestModelRequest,
  UpdateRequestDraftRequest,
  WebRoutes,
} from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import type { Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Deps } from './deps.ts';
import { ApiError, readJson, readQuery, reply } from './http.ts';
import type { RequestChatPort } from './request-chat-pg.ts';
import { REQUESTS_NOT_HERE, type RequestsPort } from './request-store-pg.ts';
import type { CockpitEnv } from './session.ts';

/** 指挥官会话没接上（开发环境、内存版）。 */
export const REQUEST_CHAT_NOT_HERE = '这台后端没接上指挥官会话（开发环境的内存版没有），指挥官不接话';

/** SSE 多久看一眼会话写到哪了（毫秒）。 */
export const COMMANDER_STREAM_POLL_MS = 500;

function seqOf(c: Context<CockpitEnv>): number {
  const raw = c.req.param('seq') ?? '';
  if (!/^[1-9]\d{0,8}$/.test(raw)) throw new ApiError(400, 'invalid_seq', `需求号认不出：${raw}`);
  return Number(raw);
}

export function registerRequestRoutes(
  app: Hono<CockpitEnv>,
  deps: Deps,
  options: { streamPollMs?: number } = {},
): void {
  const port = (): RequestsPort => {
    if (!deps.requests) throw new ApiError(503, 'requests_unavailable', REQUESTS_NOT_HERE);
    return deps.requests;
  };
  const chat = (): RequestChatPort => {
    if (!deps.requestChat) throw new ApiError(503, 'commander_unavailable', REQUEST_CHAT_NOT_HERE);
    return deps.requestChat;
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
    // 第一句：只有一个人在聊，指挥官接（没接上指挥官会话的后端人话照存，不接）
    await deps.requestChat?.afterHumanMessage(seq, c.get('user').id, {
      body: input.body,
      mentionCommander: false,
    });
    return detail(c, seq, 201);
  });

  app.get(WebRoutes.requestDetail.path, async (c) => detail(c, seqOf(c)));

  app.post(WebRoutes.sendRequestMessage.path, async (c) => {
    const seq = seqOf(c);
    const input = await readJson(c, SendRequestMessageRequest);
    // 人话先存；该不该接、排不排得上再判（排不上写「指挥官暂停了：原因」，人话照样在）
    await port().send(seq, c.get('user').id, input);
    await deps.requestChat?.afterHumanMessage(seq, c.get('user').id, {
      body: input.body,
      mentionCommander: input.mentionCommander,
    });
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
    // 草稿带「要人拍」：确定前先让别家挑一遍错（没挑过这一版就当场排上、回 409）
    if (input.action === 'confirm') await deps.requestChat?.confirmGate(seq, c.get('user').id);
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

  app.post(WebRoutes.nudgeCommander.path, async (c) => {
    const seq = seqOf(c);
    await chat().nudge(seq, c.get('user').id);
    return detail(c, seq);
  });

  app.post(WebRoutes.stopCommander.path, async (c) => {
    const seq = seqOf(c);
    await chat().stop(seq, c.get('user').id);
    return detail(c, seq);
  });

  app.put(WebRoutes.setCommanderModel.path, async (c) => {
    const seq = seqOf(c);
    const input = await readJson(c, SetRequestModelRequest);
    await chat().setModel(seq, c.get('user').id, input.modelId);
    return detail(c, seq);
  });

  app.post(WebRoutes.requestReview.path, async (c) => {
    const seq = seqOf(c);
    await chat().review(seq, c.get('user').id);
    return detail(c, seq);
  });

  app.post(WebRoutes.markReviewItem.path, async (c) => {
    const seq = seqOf(c);
    const raw = c.req.param('messageId') ?? '';
    if (!/^[1-9]\d{0,15}$/.test(raw)) throw new ApiError(400, 'invalid_message_id', `消息号认不出：${raw}`);
    const input = await readJson(c, MarkReviewItemRequest);
    await chat().markReview(seq, c.get('user').id, { messageId: Number(raw), ...input });
    return detail(c, seq);
  });

  // 回话的流：会话状态一变推 commander（「正在读代码……」、写到哪了），从在跑回到 idle 推 done；读不到推 error 写原因
  app.get(WebRoutes.commanderStream.path, async (c) => {
    const seq = seqOf(c);
    const port = chat();
    const first = await port.stream(seq);
    if (!first) throw new ApiError(404, 'request_not_found', `没有需求 ${seq}`);
    const every = options.streamPollMs ?? COMMANDER_STREAM_POLL_MS;
    c.header('X-Accel-Buffering', 'no');
    return streamSSE(c, async (stream) => {
      let closed = false;
      stream.onAbort(() => {
        closed = true;
      });
      const send = (event: string, data: RequestChatStreamEvent | { why: string }) =>
        stream.writeSSE({ event, data: JSON.stringify(data) });
      let last = JSON.stringify(first);
      let wasBusy = first.state !== 'idle';
      await send(REQUEST_CHAT_SSE_EVENTS.commander, first);
      while (!closed) {
        await stream.sleep(every);
        if (closed) break;
        let now: RequestChatStreamEvent | null;
        try {
          now = await port.stream(seq);
        } catch (err) {
          await send(REQUEST_CHAT_SSE_EVENTS.error, { why: `指挥官会话的状态没读成：${errMessage(err)}` });
          continue;
        }
        if (!now) {
          await send(REQUEST_CHAT_SSE_EVENTS.error, { why: `需求 ${seq} 已经没了` });
          break;
        }
        const text = JSON.stringify(now);
        if (text === last) continue;
        last = text;
        await send(REQUEST_CHAT_SSE_EVENTS.commander, now);
        if (wasBusy && now.state === 'idle') await send(REQUEST_CHAT_SSE_EVENTS.done, now);
        wasBusy = now.state !== 'idle';
      }
    });
  });
}
