/** 统一 diff 的着色。只用令牌，不引第三方 diff 库。 */
export function DiffView({ text }: { text: string }) {
  if (!text.trim()) return null;
  return (
    <pre className="mt-1 overflow-x-auto rounded-md bg-inset p-2 font-mono text-2xs whitespace-pre">
      {text.split('\n').map((line, i) => {
        const tone =
          line.startsWith('+') && !line.startsWith('+++')
            ? 'bg-success-soft text-ink'
            : line.startsWith('-') && !line.startsWith('---')
              ? 'bg-danger-soft text-ink'
              : line.startsWith('@@')
                ? 'text-muted'
                : 'text-ink-2';
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: diff 行可以重复，行号就是身份
          <div key={i} className={tone}>
            {line || ' '}
          </div>
        );
      })}
    </pre>
  );
}
