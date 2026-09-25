// 卡片一律 JSON 2.0（共享卡，两位创始人看到同一个状态）；每张卡一个主按钮、版式统一、能点开直达驾驶舱对应页。
// 动态文字只放进 plain_text（不走 markdown，原话里的符号不会把版式搞乱）。
// 按钮回传值带 _n（每次渲染一个新值）：SDK 按「卡片 + 点击人 + 回传值的前 128 个字符」去重 12 小时，
// 卡片一刷新同一个按钮就能再点。_n 一律排在最前面：button() 里按插入顺序放第一；飞书要是把回传值按键名排序再回给我们，
// 「_」也排在所有小写字母前面。回传值再长也截不掉它。
import { z } from 'zod';
import type { BoardSnapshot, Draft, OutboxItem, TaskDetail, TaskLookup } from './backend.ts';
import type { Card } from './port.ts';
import {
  clip,
  duration,
  percent,
  QUOTA_WINDOW_WORDS,
  SUBTASK_STATE_WORDS,
  TASK_STATE_WORDS,
  when,
} from './words.ts';

// —— 按钮回传值 ——

const Ref = z.string().min(1).max(200);
const Nonce = z.string().min(1).max(40);

export const ActionValueSchema = z.discriminatedUnion('a', [
  z.object({ a: z.literal('draft.confirm'), d: Ref, r: z.number().int().min(1), _n: Nonce }),
  z.object({ a: z.literal('draft.revise'), d: Ref, r: z.number().int().min(1), _n: Nonce }),
  z.object({ a: z.literal('ask.answer'), k: Ref, o: z.string().min(1).max(40), _n: Nonce }),
  z.object({ a: z.literal('task.stop'), t: Ref, _n: Nonce }),
  /**
   * f = 关注还是取消。c = 按钮在哪种卡上（点完刷新那张卡用），草稿卡另带 d。群里的卡是两个人共享的，显示不了「各自关没关注」，
   * 所以进度卡、草稿卡上只有「关注」；取消关注在私聊收到的关注推送卡上。
   */
  z.object({
    a: z.literal('task.follow'),
    t: Ref,
    f: z.boolean(),
    c: z.enum(['progress', 'draft', 'follow']),
    d: Ref.optional(),
    _n: Nonce,
  }),
  z.object({ a: z.literal('board.refresh'), _n: Nonce }),
  z.object({ a: z.literal('board.stalled'), _n: Nonce }),
  z.object({ a: z.literal('board.waiting'), _n: Nonce }),
  z.object({ a: z.literal('progress.show'), t: Ref, _n: Nonce }),
]);
export type ActionValue = z.infer<typeof ActionValueSchema>;

/** 卡片上表单项的名字（回调里 form_value 的键）。 */
export const FORM = { note: 'note', repo: 'repo' } as const;

// —— 驾驶舱页面（packages/web 的 routes.ts；test/static.test.ts 核对还在）——

export const COCKPIT_PATHS = {
  overview: '/overview',
  notifications: '/notifications',
  task: (taskId: string) => `/tasks/${encodeURIComponent(taskId)}`,
};

export interface RenderContext {
  /** 驾驶舱地址，不带结尾的 /。 */
  publicUrl: string;
  now: number;
  nonce: string;
}

// —— 积木 ——

type Template = 'blue' | 'wathet' | 'green' | 'orange' | 'red' | 'grey' | 'indigo';
type El = Record<string, unknown>;

interface Button {
  label: string;
  primary?: boolean;
  danger?: boolean;
  url?: string;
  value?: ActionValue;
  confirm?: { title: string; text: string };
}

function card(o: { title: string; subtitle?: string; template: Template; elements: El[] }): Card {
  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: clip(o.title, 60) } },
    header: {
      title: { tag: 'plain_text', content: clip(o.title, 80) },
      ...(o.subtitle ? { subtitle: { tag: 'plain_text', content: clip(o.subtitle, 80) } } : {}),
      template: o.template,
    },
    body: { elements: o.elements },
  };
}

function text(content: string, style: 'normal' | 'note' = 'normal'): El {
  return {
    tag: 'div',
    text: {
      tag: 'plain_text',
      content: clip(content, 1500) || '（空）',
      ...(style === 'note' ? { text_size: 'notation', text_color: 'grey' } : {}),
    },
  };
}

function button(b: Button, form?: string): El {
  const behaviors: El[] = [];
  if (b.url) behaviors.push({ type: 'open_url', default_url: b.url });
  if (b.value) {
    const { _n, ...rest } = b.value;
    behaviors.push({ type: 'callback', value: { _n, ...rest } });
  }
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: clip(b.label, 20) },
    type: b.primary ? 'primary_filled' : b.danger ? 'danger' : 'default',
    ...(b.confirm
      ? {
          confirm: {
            title: { tag: 'plain_text', content: b.confirm.title },
            text: { tag: 'plain_text', content: b.confirm.text },
          },
        }
      : {}),
    behaviors,
    ...(form ? { name: form, form_action_type: 'submit' } : {}),
  };
}

function buttons(list: Button[]): El {
  return {
    tag: 'column_set',
    flex_mode: 'flow',
    horizontal_spacing: '8px',
    columns: list.map((b) => ({ tag: 'column', width: 'auto', elements: [button(b)] })),
  };
}

function cockpit(ctx: RenderContext, path: string, label = '打开驾驶舱', primary = true): Button {
  return { label, primary, url: `${ctx.publicUrl}${path}` };
}

// —— 随手记任务 ——

export type DraftState = 'open' | 'revising' | 'confirming';

/** 「我理解为」确认卡。note 是卡上的一句提示（改完了、出错了、要先选仓……）。 */
export function draftCard(
  draft: Draft,
  ctx: RenderContext,
  opts: { state?: DraftState; note?: string | undefined } = {},
): Card {
  if (draft.status === 'confirmed' && draft.task) {
    const t = draft.task;
    return card({
      title: `已开成任务 #${t.issueNumber}`,
      subtitle: t.repo,
      template: 'green',
      elements: [
        text(`我理解为：${draft.understanding}`),
        text(`提出：${draft.proposedBy}${draft.confirmedBy ? ` · 确认：${draft.confirmedBy}` : ''}`, 'note'),
        ...(opts.note ? [text(opts.note, 'note')] : []),
        buttons([
          cockpit(ctx, COCKPIT_PATHS.task(t.taskId)),
          {
            label: '关注',
            value: { a: 'task.follow', t: t.taskId, f: true, c: 'draft', d: draft.id, _n: ctx.nonce },
          },
        ]),
      ],
    });
  }

  if (draft.status === 'confirmed') {
    // 确认了、issue 还没开出来（后端的「待开单」，开单那一步接上或恢复后自动补开）：不再给确认、改一下，免得看着像没确认；
    // 也和点确认那几秒的「正在开成任务…」分开，看得出是卡在待开单。
    return card({
      title: '已确认，待开单',
      ...(draft.repo ? { subtitle: draft.repo.fullName } : {}),
      template: 'wathet',
      elements: [
        text(`我理解为：${draft.understanding}`),
        text(`提出：${draft.proposedBy}${draft.confirmedBy ? ` · 确认：${draft.confirmedBy}` : ''}`, 'note'),
        ...(opts.note ? [text(opts.note, 'note')] : []),
        text('开 issue 那一步还没做成，后台会自动补开，不会丢；开好后驾驶舱里就有这个任务。', 'note'),
        buttons([cockpit(ctx, COCKPIT_PATHS.overview)]),
      ],
    });
  }

  const state = opts.state ?? 'open';
  const base = [
    text(draft.understanding),
    text(`放在：${draft.repo?.fullName ?? '还没定，确认前选一个仓'}`),
    ...(draft.unsure ? [text('我拿不准，确认前看一眼。', 'note')] : []),
    text(`原话：${draft.rawText}`, 'note'),
    ...(opts.note ? [text(opts.note, 'note')] : []),
  ];
  if (state !== 'open') {
    return card({
      title: state === 'confirming' ? '正在开成任务…' : '正在按你的补充重新理解…',
      template: 'wathet',
      elements: [
        ...base,
        text('好了这张卡会原地更新。', 'note'),
        buttons([cockpit(ctx, COCKPIT_PATHS.overview)]),
      ],
    });
  }

  const formElements: El[] = [
    {
      tag: 'input',
      name: FORM.note,
      placeholder: { tag: 'plain_text', content: '哪里不对？写一句再点「改一下」' },
      max_length: 500,
      width: 'fill',
    },
  ];
  if (draft.repoOptions.length > 1) {
    formElements.push({
      tag: 'select_static',
      name: FORM.repo,
      placeholder: { tag: 'plain_text', content: '放在哪个仓' },
      options: draft.repoOptions.map((r) => ({
        text: { tag: 'plain_text', content: clip(r.fullName, 60) },
        value: r.id,
      })),
      ...(draft.repo ? { initial_option: draft.repo.id } : {}),
      width: 'fill',
    });
  }
  formElements.push({
    tag: 'column_set',
    flex_mode: 'flow',
    horizontal_spacing: '8px',
    columns: [
      {
        tag: 'column',
        width: 'auto',
        elements: [
          button(
            {
              label: '确认',
              primary: true,
              value: { a: 'draft.confirm', d: draft.id, r: draft.revision, _n: ctx.nonce },
            },
            'confirm',
          ),
        ],
      },
      {
        tag: 'column',
        width: 'auto',
        elements: [
          button(
            { label: '改一下', value: { a: 'draft.revise', d: draft.id, r: draft.revision, _n: ctx.nonce } },
            'revise',
          ),
        ],
      },
    ],
  });
  return card({
    title: '我理解为',
    subtitle: `提出：${draft.proposedBy}`,
    template: draft.unsure ? 'orange' : 'blue',
    elements: [...base, { tag: 'form', name: 'draft', elements: formElements }],
  });
}

/** 没有草稿内容可画时（后端还没回、或重启后缓存没了）的过渡卡。 */
export function draftWaitCard(
  ctx: RenderContext,
  o: { title: string; rawText?: string | undefined; lines?: string[]; failed?: boolean },
): Card {
  return card({
    title: o.title,
    template: o.failed ? 'red' : 'wathet',
    elements: [
      ...(o.lines ?? []).map((l) => text(l)),
      ...(o.rawText ? [text(`原话：${o.rawText}`, 'note')] : []),
      ...(o.failed ? [] : [text('好了这张卡会原地更新，不用重发。', 'note')]),
      buttons([cockpit(ctx, COCKPIT_PATHS.overview)]),
    ],
  });
}

/** 先发了「正在理解」卡、后端最后回的是一段话（问题或闲聊）时，把那张卡改成这段话。 */
export function answerCard(answer: string, ctx: RenderContext, taskId?: string): Card {
  return card({
    title: '回答',
    template: 'blue',
    elements: [
      text(answer),
      buttons([cockpit(ctx, taskId ? COCKPIT_PATHS.task(taskId) : COCKPIT_PATHS.overview)]),
    ],
  });
}

// —— 进度 ——

const FINISHED = new Set(['done', 'stopped', 'failed']);

export function progressCard(
  detail: TaskDetail,
  ctx: RenderContext,
  opts: { note?: string | undefined } = {},
): Card {
  const { task, repo, subtasks, asks } = detail;
  const merged = subtasks.filter((s) => s.state === 'merged').length;
  const lines: El[] = [
    text(
      `状态：${TASK_STATE_WORDS[task.state]}${subtasks.length > 0 ? ` · 子任务合并 ${merged}/${subtasks.length}` : ''}`,
    ),
  ];
  for (const s of subtasks.slice(0, 6)) {
    const now = s.activity
      ? ` · ${s.activity.text}，已 ${duration(ctx.now - Date.parse(s.activity.since))}`
      : '';
    lines.push(
      text(
        `${s.index}. ${s.title} — ${SUBTASK_STATE_WORDS[s.state]}${s.prNumber ? ` · PR #${s.prNumber}` : ''}${now}`,
      ),
    );
  }
  if (subtasks.length > 6) lines.push(text(`还有 ${subtasks.length - 6} 个子任务，驾驶舱里看全部。`, 'note'));
  const pending = asks.filter((a) => a.status === 'pending');
  if (pending.length > 0) {
    lines.push(text(`等你们回答 ${pending.length} 个问题：${clip(pending[0]?.question ?? '', 80)}`));
  }
  if (opts.note) lines.push(text(opts.note, 'note'));
  const actions: Button[] = [
    cockpit(ctx, COCKPIT_PATHS.task(task.id)),
    { label: '关注', value: { a: 'task.follow', t: task.id, f: true, c: 'progress', _n: ctx.nonce } },
  ];
  if (!FINISHED.has(task.state)) {
    actions.push({
      label: '叫停',
      danger: true,
      value: { a: 'task.stop', t: task.id, _n: ctx.nonce },
      confirm: { title: `叫停 #${task.issueNumber}？`, text: '任务会停下来；要重新开始得在驾驶舱里操作。' },
    });
  }
  lines.push(buttons(actions));
  return card({
    title: `#${task.issueNumber} ${task.title}`,
    subtitle: `${repo.owner}/${repo.name}`,
    template:
      task.state === 'done'
        ? 'green'
        : task.state === 'stalled' || task.state === 'failed'
          ? 'orange'
          : task.state === 'stopped'
            ? 'grey'
            : 'blue',
    elements: lines,
  });
}

/** 几个仓都有这个号时，让人挑。 */
export function pickTaskCard(issue: number, matches: TaskLookup['matches'], ctx: RenderContext): Card {
  return card({
    title: `有 ${matches.length} 个 #${issue}`,
    template: 'blue',
    elements: [
      ...matches.map((m) => text(`${m.repo}#${m.issueNumber} ${m.title} — ${TASK_STATE_WORDS[m.state]}`)),
      buttons([
        cockpit(ctx, COCKPIT_PATHS.overview),
        ...matches.slice(0, 3).map((m) => ({
          label: `看 ${m.repo.split('/').pop() ?? m.repo}`,
          value: { a: 'progress.show', t: m.taskId, _n: ctx.nonce } as const,
        })),
      ]),
    ],
  });
}

// —— 盘面 ——

export function boardCard(
  snap: BoardSnapshot,
  ctx: RenderContext,
  opts: { staleMs?: number; note?: string | undefined } = {},
): Card {
  const c = snap.counts;
  const elements: El[] = [
    text(`在干 ${c.running} · 卡住 ${c.stalled} · 等你们点头 ${c.waitingForYou} · 今天合并 ${c.mergedToday}`),
  ];
  for (const q of snap.quota.slice(0, 3)) {
    const left = q.remaining === undefined ? '' : `剩 ${percent(q.remaining)}`;
    const reset = q.resetsAt ? `${left ? '，' : ''}${when(q.resetsAt, ctx.now)} 清零` : '';
    const name = q.window === 'other' && q.label ? `额度「${q.label}」` : QUOTA_WINDOW_WORDS[q.window];
    elements.push(
      text(`${q.poolName} ${name}：${left}${reset}${q.reading === 'estimated' ? '（估算）' : ''}`),
    );
  }
  if (opts.staleMs !== undefined) {
    elements.push(text(`这是 ${duration(opts.staleMs)}前的数：后端现在没连上。`, 'note'));
  }
  if (opts.note) elements.push(text(opts.note, 'note'));
  elements.push(
    buttons([
      cockpit(ctx, COCKPIT_PATHS.overview),
      { label: '刷新', value: { a: 'board.refresh', _n: ctx.nonce } },
      { label: '看卡住的', value: { a: 'board.stalled', _n: ctx.nonce } },
      { label: '看等我点头的', value: { a: 'board.waiting', _n: ctx.nonce } },
    ]),
  );
  return card({
    title: '盘面',
    subtitle: `更新于 ${when(snap.asOf, ctx.now)}`,
    template: 'wathet',
    elements,
  });
}

export function expiredBoardCard(ctx: RenderContext): Card {
  return card({
    title: '盘面（旧卡）',
    template: 'grey',
    elements: [
      text('这张盘面卡已经换新，看群里置顶的那张。'),
      buttons([cockpit(ctx, COCKPIT_PATHS.overview)]),
    ],
  });
}

export function stalledListCard(snap: BoardSnapshot, ctx: RenderContext): Card {
  const items = snap.stalled.map((s) =>
    text(
      `#${s.issueNumber} ${s.title}（${s.repo}）${s.since ? ` — 卡了 ${duration(ctx.now - Date.parse(s.since))}` : ''}${s.why ? `：${s.why}` : ''}`,
    ),
  );
  return card({
    title: `卡住的 ${snap.counts.stalled} 件`,
    template: snap.counts.stalled > 0 ? 'orange' : 'green',
    elements: [
      ...(items.length > 0 ? items : [text('现在没有卡住的。')]),
      ...more(snap.counts.stalled, snap.stalled.length),
      buttons([cockpit(ctx, COCKPIT_PATHS.overview)]),
    ],
  });
}

/** 「我的待办」和盘面卡上的「看等我点头的」共用：以后端库里的为准，全部列出，不许回「没有」。 */
export function waitingListCard(snap: BoardSnapshot, ctx: RenderContext, title = '等你们点头的'): Card {
  const items = snap.waiting.map((w) =>
    text(
      `${w.kind === 'decision' ? '要拍' : '要答'}：${w.title}${w.issueNumber ? ` · #${w.issueNumber}` : ''} · ${when(w.since, ctx.now)}`,
    ),
  );
  return card({
    title: `${title} ${snap.counts.waitingForYou} 件`,
    template: snap.counts.waitingForYou > 0 ? 'orange' : 'green',
    elements: [
      ...(items.length > 0 ? items : [text('现在没有等你们的。')]),
      ...more(snap.counts.waitingForYou, snap.waiting.length),
      ...(items.length > 0
        ? [text('在团队群里对应的卡上点按钮或回复那张卡，也可以在驾驶舱里处理。', 'note')]
        : []),
      buttons([cockpit(ctx, COCKPIT_PATHS.notifications)]),
    ],
  });
}

export function activeListCard(snap: BoardSnapshot, ctx: RenderContext): Card {
  const items = snap.active.map((t) =>
    text(
      `#${t.issueNumber} ${t.title} — ${TASK_STATE_WORDS[t.state]} ${t.progress.done}/${t.progress.total}${t.activity ? ` · ${t.activity}` : ''}`,
    ),
  );
  return card({
    title: `在干的 ${snap.counts.running} 件`,
    template: 'blue',
    elements: [
      ...(items.length > 0 ? items : [text('现在没有在干的任务。')]),
      ...more(snap.counts.running, snap.active.length),
      text('发「进度 12」看某一件的详情。', 'note'),
      buttons([cockpit(ctx, COCKPIT_PATHS.overview)]),
    ],
  });
}

function more(total: number, shown: number): El[] {
  return total > shown ? [text(`还有 ${total - shown} 件，驾驶舱里看全部。`, 'note')] : [];
}

// —— 三类推送 + 关注 + AI 追问 ——

const KIND_WORDS: Record<OutboxItem['kind'], string> = {
  decision: '要你们拍',
  alert: '卡住报警',
  daily: '日报',
  follow: '你关注的需求',
  ask: 'AI 在问',
};

const KIND_TEMPLATE: Record<OutboxItem['kind'], Template> = {
  decision: 'orange',
  alert: 'red',
  daily: 'blue',
  follow: 'wathet',
  ask: 'indigo',
};

/** overlay：按钮一点先在本地把卡改掉（已回答、已叫停……），不等后端下一版推过来。 */
export function outboxCard(
  item: OutboxItem,
  ctx: RenderContext,
  overlay: { doneText?: string; note?: string } = {},
): Card {
  const link = item.link ?? (item.taskId ? COCKPIT_PATHS.task(item.taskId) : COCKPIT_PATHS.overview);
  const done = item.status === 'done' || overlay.doneText !== undefined;
  const elements: El[] = item.lines.map((l) => text(l));
  if (done) elements.push(text(overlay.doneText ?? item.doneText ?? '已处理'));
  if (overlay.note) elements.push(text(overlay.note, 'note'));

  const actions: Button[] = [];
  if (!done && item.askId && item.options && item.options.length > 0) {
    for (const [i, option] of item.options.entries()) {
      actions.push({
        label: option,
        primary: i === 0,
        value: { a: 'ask.answer', k: item.askId, o: option, _n: ctx.nonce },
      });
    }
    actions.push(cockpit(ctx, link, '打开驾驶舱', false));
    // 要人拍的事拍板只认按钮：回复只算追问，免得「要花多少钱？」被记成答案。AI 的追问回复就是回答。
    elements.push(
      text(
        item.kind === 'decision'
          ? '拍板请点上面的按钮；有疑问直接回复这张卡片问（群里回复要 @我），回复不算拍板。'
          : '也可以直接回复这张卡片作答（群里回复要 @我）。',
        'note',
      ),
    );
  } else {
    actions.push(cockpit(ctx, link));
    if (!done && item.kind === 'alert' && item.taskId) {
      actions.push({
        label: '叫停',
        danger: true,
        value: { a: 'task.stop', t: item.taskId, _n: ctx.nonce },
        confirm: { title: '叫停这个任务？', text: '任务会停下来；要重新开始得在驾驶舱里操作。' },
      });
    }
    if (!done && item.kind === 'follow' && item.taskId) {
      actions.push({
        label: '取消关注',
        value: { a: 'task.follow', t: item.taskId, f: false, c: 'follow', _n: ctx.nonce },
      });
    }
  }
  elements.push(buttons(actions));
  return card({
    title: item.title,
    subtitle: `${KIND_WORDS[item.kind]}${item.repo && item.issueNumber ? ` · ${item.repo}#${item.issueNumber}` : ''}`,
    template: done ? 'grey' : KIND_TEMPLATE[item.kind],
    elements,
  });
}

export function budgetAlertCard(sent: number, budget: number, ctx: RenderContext): Card {
  return card({
    title: '今天求人的卡超预算了',
    template: 'red',
    elements: [
      text(`今天要你们拍或回答的已经发了 ${sent} 张卡，预算是 ${budget} 张。`),
      text('后面的不再单独发卡，只进驾驶舱的通知中心。请看一眼是不是机器在刷求助。'),
      buttons([cockpit(ctx, COCKPIT_PATHS.notifications)]),
    ],
  });
}

// —— 卡片自检（测试用；真发到测试群的验证等飞书应用建好后补）——

const ALLOWED_TAGS = new Set([
  'div',
  'plain_text',
  'hr',
  'column_set',
  'column',
  'button',
  'form',
  'input',
  'select_static',
]);
/** 卡片上不许出现的内部代号（任务、子任务状态的英文名）。 */
const INTERNAL_CODES =
  /\b(queued|triaging|asking|planning|merging|stopped|stalled|pending|waiting_deps|waiting_slot|verifying|in_merge_queue|merged)\b/;
const MAX_CARD_BYTES = 30 * 1024;

/** 返回问题清单；空 = 这张卡按我们的规矩是好的。 */
export function checkCard(c: Card): string[] {
  const problems: string[] = [];
  if (c.schema !== '2.0') problems.push('schema 不是 2.0');
  const config = c.config as { update_multi?: unknown } | undefined;
  if (config?.update_multi !== true) problems.push('没声明 update_multi: true');
  const header = c.header as { title?: { content?: unknown } } | undefined;
  if (typeof header?.title?.content !== 'string' || !header.title.content) problems.push('没有标题');
  const bytes = Buffer.byteLength(JSON.stringify(c), 'utf8');
  if (bytes > MAX_CARD_BYTES) problems.push(`卡片 ${bytes} 字节，超过 30 KB`);

  let elements = 0;
  let primaries = 0;
  const names = new Set<string>();
  const walk = (node: unknown, inForm: boolean): void => {
    if (Array.isArray(node)) {
      for (const n of node) walk(n, inForm);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    const tag = o.tag;
    if (typeof tag === 'string') {
      elements += 1;
      if (!ALLOWED_TAGS.has(tag)) problems.push(`用了不在白名单里的组件 ${tag}`);
      if (tag === 'plain_text') {
        const content = String(o.content ?? '');
        if (!content.trim()) problems.push('有空的文字');
        const code = INTERNAL_CODES.exec(content);
        if (code) problems.push(`文字里有内部代号「${code[1]}」：${content.slice(0, 40)}`);
      }
      if (tag === 'button') {
        if (typeof o.type === 'string' && o.type.startsWith('primary')) primaries += 1;
        const behaviors = Array.isArray(o.behaviors) ? (o.behaviors as Record<string, unknown>[]) : [];
        if (behaviors.length === 0) problems.push('按钮没有 behaviors');
        for (const b of behaviors) {
          if (b.type === 'callback' && !ActionValueSchema.safeParse(b.value).success) {
            problems.push(`按钮回传值不认识：${JSON.stringify(b.value)}`);
          }
          if (b.type === 'open_url' && !/^https?:\/\//.test(String(b.default_url)))
            problems.push('链接不是 http(s)');
        }
        if (inForm && (o.form_action_type !== 'submit' || typeof o.name !== 'string')) {
          problems.push('表单里的按钮要有 name 且 form_action_type=submit');
        }
        if (!inForm && o.form_action_type !== undefined) problems.push('表单外的按钮不能带 form_action_type');
      }
      if (
        (tag === 'input' || tag === 'select_static' || tag === 'form' || (tag === 'button' && inForm)) &&
        'name' in o
      ) {
        const name = String(o.name);
        if (names.has(name)) problems.push(`name 重复：${name}`);
        names.add(name);
      }
      if ((tag === 'input' || tag === 'select_static') && !inForm)
        problems.push(`${tag} 不在表单里，提交不上来`);
    }
    for (const [k, v] of Object.entries(o)) {
      if (k === 'value') continue; // 回传值是我们的数据，不是组件
      walk(v, inForm || tag === 'form');
    }
  };
  walk(c.header, false);
  walk(c.body, false);
  if (elements > 200) problems.push(`组件和元素共 ${elements} 个，超过 200`);
  if (primaries !== 1) problems.push(`主按钮有 ${primaries} 个，应当正好 1 个`);
  return problems;
}
