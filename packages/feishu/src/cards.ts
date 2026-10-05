// 卡片一律 JSON 2.0（共享卡，两位创始人看到同一个状态）；版式统一，动态文字只放进 plain_text（不走 markdown，
// 原话里的符号不会把版式搞乱）。旧的草稿、进度、盘面、推送卡随 #1022 退役；网关自己画的卡只剩这里的报警卡，
// 意图卡在 intent-cards.ts。
import { z } from 'zod';
import type { Card } from './port.ts';
import { clip, duration, when } from './words.ts';

// —— 旧卡上的按钮回传值：按钮都停用了，只用来认出有人点的是哪种旧按钮（记日志），和给 checkCard 认回传值 ——

const Ref = z.string().min(1).max(200);
const Nonce = z.string().min(1).max(40);

export const ActionValueSchema = z.discriminatedUnion('a', [
  z.object({ a: z.literal('draft.confirm'), d: Ref, r: z.number().int().min(1), _n: Nonce }),
  z.object({ a: z.literal('draft.revise'), d: Ref, r: z.number().int().min(1), _n: Nonce }),
  z.object({ a: z.literal('ask.answer'), k: Ref, o: z.string().min(1).max(40), _n: Nonce }),
  z.object({ a: z.literal('task.stop'), t: Ref, _n: Nonce }),
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
  url: string;
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

function button(b: Button): El {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: clip(b.label, 20) },
    type: b.primary ? 'primary_filled' : 'default',
    behaviors: [{ type: 'open_url', default_url: b.url }],
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

// —— 网关自己的报警（watch.ts 发，不经过后端）——

/** 健康页（香港上的静态页，deploy/web/health）：后端连不上时它照样打得开，会写明连不上。 */
export const HEALTH_PAGE_PATH = '/health/';

export interface LinkAlert {
  /** 从什么时候起没走通（这几条都没走通过时，就是网关这次起来的时刻）。 */
  since: number;
  /** 画卡的时刻（卡上写「已经多久」）。 */
  at: number;
  /** 没走通的那几条定时活。 */
  loops: Array<{
    name: 'intents';
    lastOkAt: number | null;
    lastFail: { at: number; reason: string } | null;
  }>;
  /** 通了：全部又走通的时刻（卡改灰）。 */
  backAt?: number | undefined;
}

/** 定时活给人看的名字（报警卡、「通了」那句）。 */
export const LINK_WORDS = { intents: '意图卡' } as const;

export function linkAlertCard(a: LinkAlert, ctx: RenderContext): Card {
  const since = when(a.since, ctx.now);
  const never = a.loops.every((l) => l.lastOkAt === null);
  const elements: El[] = [
    text(
      never
        ? `网关 ${since} 起来后一直没走通，到现在 ${duration(a.at - a.since)}：`
        : `从 ${since} 起一直没走通，到现在 ${duration(a.at - a.since)}：`,
    ),
  ];
  for (const l of a.loops) {
    const last = l.lastOkAt === null ? '网关起来后没走通过' : `最后一次走通 ${when(l.lastOkAt, ctx.now)}`;
    // 最后一次走通之前的失败不算：那之后一次都没失败过，就是一轮都没跑完
    const failed = l.lastFail && (l.lastOkAt === null || l.lastFail.at >= l.lastOkAt) ? l.lastFail : null;
    const fail = failed
      ? `最近一次没走通 ${when(failed.at, ctx.now)}：${failed.reason}`
      : '这段时间一轮都没跑完（网关的定时活停了，或卡在飞书那头？）';
    elements.push(text(`· ${LINK_WORDS[l.name]}：${last}；${fail}`));
  }
  elements.push(text('这期间意图卡发不出来、改不了（存下的原话后端都记着，通了会接着发）。'));
  elements.push(text('发给我的话多半也记不下来（会回「没记成」），通了请重发。'));
  elements.push(
    text(
      a.backAt === undefined
        ? '通了我会在这条下面说一声；这次只报这一次。'
        : `已经通了 · ${when(a.backAt, ctx.now)}（断了 ${duration(a.backAt - a.since)}）`,
    ),
  );
  elements.push(text('这条是飞书网关自己发的，不经过后端。细节看健康页和香港的网关日志。', 'note'));
  elements.push(
    buttons([{ label: '打开健康页', primary: true, url: `${ctx.publicUrl}${HEALTH_PAGE_PATH}` }]),
  );
  return card({
    title: '机器人调不通后端了',
    subtitle: '卡住报警 · 飞书网关',
    template: a.backAt === undefined ? 'red' : 'grey',
    elements,
  });
}

// —— 卡片自检（测试用）——

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

/**
 * 返回问题清单；空 = 这张卡按我们的规矩是好的。buttons='none' 是有意不放按钮的卡（意图卡：飞书上不建开单界面），
 * 这时一个按钮都不许有；其余的卡正好一个主按钮。
 */
export function checkCard(c: Card, opts: { buttons?: 'one-primary' | 'none' } = {}): string[] {
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
  let buttons = 0;
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
        buttons += 1;
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
  if (opts.buttons === 'none') {
    if (buttons > 0) problems.push(`这张卡不该有按钮，却有 ${buttons} 个`);
  } else if (primaries !== 1) {
    problems.push(`主按钮有 ${primaries} 个，应当正好 1 个`);
  }
  return problems;
}
