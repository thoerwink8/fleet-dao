// 更新日志这类自己写的 Markdown 的最小渲染：小标题（### / ####）、列表（- / *）、段落，行内的 `代码`、**粗体**、[链接](地址)。
// 不引第三方 Markdown 库：CHANGELOG 只用这几样，多出来的写法原样当文字显示（看得见、不丢字），不当 HTML 解释（不开注入口子）。
// 起因：更新日志页原来把 Markdown 原文塞进 <pre>，「### 新的能做的事」「- 」这些记号照原样露在页面上。
import type { ReactNode } from 'react';
import { BulletList } from './layout/bullet-list';
import { Code } from './layout/code';
import { Stack } from './layout/stack';
import { Text } from './layout/text';
import { TextLink } from './layout/text-link';
import { Title } from './layout/title';

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
      out.push(<Code key={at}>{m[1]}</Code>);
    } else if (m[2] !== undefined) {
      out.push(
        <Text key={at} as="strong" strong>
          {m[2]}
        </Text>,
      );
    } else {
      out.push(
        <TextLink key={at} href={m[4] as string} external>
          {m[3]}
        </TextLink>,
      );
    }
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function MarkdownLite({ source }: { source: string }) {
  return (
    <Stack gap="md">
      {parseBlocks(source).map((b, i) => {
        const key = i;
        if (b.kind === 'heading') {
          return b.level === 3 ? (
            <Title key={key} level={3} look={2}>
              {inline(b.text)}
            </Title>
          ) : (
            <Title key={key} level={4}>
              {inline(b.text)}
            </Title>
          );
        }
        if (b.kind === 'list') {
          return <BulletList key={key} items={b.items.map((it) => inline(it))} />;
        }
        return (
          <Text key={key} as="p" tone="secondary">
            {inline(b.text)}
          </Text>
        );
      })}
    </Stack>
  );
}
