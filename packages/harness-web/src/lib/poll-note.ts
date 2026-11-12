/**
 * 轮询的回包能不能改那条报错。
 * seq 必须还是目前最新的一次：成功（failed 为 null）清成空串，失败写上原因。
 * 更早的回包返回 undefined，调用方保持原样，不靠定时器去清。
 */
export function pollNote(latest: number, seq: number, failed: string | null): string | undefined {
  if (seq !== latest) return undefined;
  return failed ?? '';
}
