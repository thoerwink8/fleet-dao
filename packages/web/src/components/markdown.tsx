// 把 lib/markdown.ts 解析出的几样画出来（#3277）：正文 text-body，行内代码、代码块 bg-muted + 等宽。
import { Fragment } from 'react';
import { type Inline, type MdBlock, parseMarkdown } from '../lib/markdown';
import { cn } from '../lib/utils';

function Spans({ inline }: { inline: readonly Inline[] }) {
  return (
    <>
      {inline.map((s, i) => {
        const key = `${i}-${s.kind}`;
        switch (s.kind) {
          case 'code':
            return (
              <code key={key} className="num rounded-sm bg-muted px-1 py-0.5 text-meta">
                {s.text}
              </code>
            );
          case 'bold':
            return (
              <strong key={key} className="font-semibold">
                {s.text}
              </strong>
            );
          case 'link':
            return (
              <a
                key={key}
                href={s.href}
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 hover:text-foreground"
              >
                {s.text}
              </a>
            );
          default:
            return <Fragment key={key}>{s.text}</Fragment>;
        }
      })}
    </>
  );
}

function Lines({ lines }: { lines: readonly Inline[][] }) {
  return (
    <>
      {lines.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 段落里的行没有身份，下标就是它的身份
        <Fragment key={i}>
          {i > 0 ? <br /> : null}
          <Spans inline={l} />
        </Fragment>
      ))}
    </>
  );
}

function Block({ b }: { b: MdBlock }) {
  switch (b.kind) {
    case 'heading':
      return (
        <p className="font-semibold">
          <Spans inline={b.inline} />
        </p>
      );
    case 'list': {
      const items = b.items.map((it, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 列表项没有身份
        <li key={i} className="pl-1">
          <Spans inline={it} />
        </li>
      ));
      return b.ordered ? (
        <ol start={b.start} className="list-decimal space-y-1 pl-5">
          {items}
        </ol>
      ) : (
        <ul className="list-disc space-y-1 pl-5">{items}</ul>
      );
    }
    case 'quote':
      return (
        <blockquote className="border-l-2 pl-3 text-muted-foreground">
          <Lines lines={b.lines} />
        </blockquote>
      );
    case 'code':
      return (
        <pre
          className="num overflow-x-auto rounded-md bg-muted px-3 py-2 text-meta whitespace-pre"
          data-md-code
        >
          <code>{b.text}</code>
        </pre>
      );
    default:
      return (
        <p>
          <Lines lines={b.lines} />
        </p>
      );
  }
}

/** 一段 Markdown：块之间留一行的距离。 */
export function Markdown({
  text,
  className,
  ...rest
}: { text: string; className?: string } & Record<`data-${string}`, string>) {
  const blocks = parseMarkdown(text);
  return (
    <div className={cn('min-w-0 space-y-2 text-body break-words', className)} {...rest}>
      {blocks.map((b, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 块的先后就是身份，内容变了整段重画
        <Block key={i} b={b} />
      ))}
    </div>
  );
}
