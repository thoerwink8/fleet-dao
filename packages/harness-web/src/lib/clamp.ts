// 长输出的预览：默认只显示前 200 字或 12 行（先到为准），其余点开看。纯函数，不碰 DOM。
export const PREVIEW_CHARS = 200;
export const PREVIEW_LINES = 12;

export interface Clamped {
  /** 预览文本（没超就是全文）。 */
  preview: string;
  /** 是不是被截了。 */
  truncated: boolean;
  totalChars: number;
  totalLines: number;
}

export function clampText(text: string, maxChars = PREVIEW_CHARS, maxLines = PREVIEW_LINES): Clamped {
  const lines = text.split('\n');
  const totalChars = text.length;
  const totalLines = lines.length;
  let preview = text;
  // 先按行截，再按字截：谁先到按谁
  if (totalLines > maxLines) preview = lines.slice(0, maxLines).join('\n');
  if (preview.length > maxChars) preview = preview.slice(0, maxChars);
  const truncated = preview.length < totalChars;
  return { preview: truncated ? preview.trimEnd() : preview, truncated, totalChars, totalLines };
}
