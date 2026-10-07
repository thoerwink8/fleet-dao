// 更新日志这类自己写的 Markdown 的最小渲染：小标题（### / ####）、列表（- / *）、段落，行内的 `代码`、**粗体**、[链接](地址)。
// 不引第三方 Markdown 库：CHANGELOG 只用这几样，多出来的写法原样当文字显示（看得见、不丢字），不当 HTML 解释（不开注入口子）。
// 起因（驾驶舱改版 2026-10-07）：更新日志页原来把 Markdown 原文塞进 <pre>，「### 新的能做的事」「- 」这些记号照原样露在页面上。
import type { ReactNode } from 'react';

type Block =
  | { kind: 'heading'; level: 3 | 4; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'para'; text: string };

/** 按行切块：连续的列表项并成一个列表；列表项下一行缩进的续行接到上一项；空行分段。 */
export function parseBlocks(md: string): Block[] {
  const blocks: Block[] = [];
  let list: string[] | null = null;
  let para: string[] | null = null;
  const flush = () => {
    if (list) blocks.push({ kind: 'list', items: list });
    if (para) blocks.push({ kind: 'para', text: para.join(' ') });
    list = null;
    para = null;
  };
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const heading = /^(#{3,4})\s+(.*)$/.exec(line.trim());
    const item = /^\s*[-*]\s+(.*)$/.exec(line);
    if (line.trim() === '') {
      flush();
    } else if (heading) {
      flush();
      blocks.push({ kind: 'heading', level: heading[1] === '###' ? 3 : 4, text: heading[2] ?? '' });
    } else if (item) {
      if (para) flush();
      list ??= [];
      list.push(item[1] ?? '');
    } else if (list && /^\s+/.test(line)) {
      list[list.length - 1] = `${list[list.length - 1]} ${line.trim()}`;
    } else {
      if (list) flush();
      para ??= [];
      para.push(line.trim());
    }
  }
  flush();
  return blocks;
}

/** 行内：`代码`、**粗体**、[文字](http 地址)。别的记号原样留着。 */
export function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    if (m[1] !== undefined) {
      out.push(
        <code key={at} className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
          {m[1]}
        </code>,
      );
    } else if (m[2] !== undefined) {
      out.push(
        <strong key={at} className="font-semibold">
          {m[2]}
        </strong>,
      );
    } else {
      out.push(
        <a key={at} href={m[4]} target="_blank" rel="noreferrer" className="underline underline-offset-2">
          {m[3]}
        </a>,
      );
    }
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function MarkdownLite({ source }: { source: string }) {
  return (
    <div className="space-y-3 text-sm leading-7">
      {parseBlocks(source).map((b, i) => {
        const key = i;
        if (b.kind === 'heading') {
          return b.level === 3 ? (
            <h3 key={key} className="pt-2 text-strong font-semibold first:pt-0">
              {inline(b.text)}
            </h3>
          ) : (
            <h4 key={key} className="pt-1 text-sm font-semibold">
              {inline(b.text)}
            </h4>
          );
        }
        if (b.kind === 'list') {
          return (
            <ul key={key} className="space-y-2">
              {b.items.map((it, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 列表项按文档先后排。
                <li key={j} className="flex gap-2.5">
                  <span className="mt-3 size-1.5 shrink-0 rounded-full bg-foreground/40" aria-hidden />
                  <span className="min-w-0">{inline(it)}</span>
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p key={key} className="text-muted-foreground">
            {inline(b.text)}
          </p>
        );
      })}
    </div>
  );
}
