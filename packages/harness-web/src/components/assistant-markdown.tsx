// 助手正文的 GFM。库按需加载（chat-timeline 动态导入这一份），不进首屏。
// react-markdown 默认不把原始 HTML 变成节点；这里不接 rehype-raw。
import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="underline">
      {children}
    </a>
  ),
  h1: ({ children }) => <h1 className="text-base font-medium">{children}</h1>,
  h2: ({ children }) => <h2 className="text-sm font-medium">{children}</h2>,
  h3: ({ children }) => <h3 className="text-sm font-medium">{children}</h3>,
  ul: ({ children }) => <ul className="list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal space-y-1 pl-5">{children}</ol>,
  p: ({ children }) => <p>{children}</p>,
  code: ({ className, children }) =>
    typeof className === 'string' ? (
      <code className={`${className} font-mono text-xs`}>{children}</code>
    ) : (
      <code className="rounded-sm bg-subtle px-1 font-mono text-xs">{children}</code>
    ),
  pre: ({ children }) => (
    <pre className="overflow-x-auto rounded-md bg-subtle px-3 py-2 font-mono text-xs">{children}</pre>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border border-line px-2 py-1 font-medium">{children}</th>,
  td: ({ children }) => <td className="border border-line px-2 py-1">{children}</td>,
};

/** 助手消息。调用方负责懒加载。 */
export function AssistantMarkdown({ text }: { text: string }) {
  return (
    <div className="space-y-2 text-sm leading-6 break-words text-ink" data-testid="assistant-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
