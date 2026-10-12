// 路由里的模型要写完整型号。裸别名（sonnet、haiku……）会指到旧版，骨架和起会话都不收。
// 目录 id（sonnet-5.5）和上游串（claude-sonnet-5-5）都算完整型号；只拦这一列短名。

/** 不带版本的短名。写进路由、或拿去起 Mirasim 会话，都拒。 */
export const BARE_MODEL_ALIASES = [
  'sonnet',
  'opus',
  'haiku',
  'fable',
  'gpt',
  'grok',
  'kimi',
  'claude',
] as const;

/** 是裸别名就返回原因；完整型号返回 null。比对不分大小写，只去首尾空白。 */
export function bareModelAliasProblem(modelId: string): string | null {
  const id = modelId.trim().toLowerCase();
  if ((BARE_MODEL_ALIASES as readonly string[]).includes(id)) {
    return `模型「${modelId}」是裸别名，要写完整型号（例如 sonnet-5.5、claude-sonnet-5-5）`;
  }
  return null;
}
