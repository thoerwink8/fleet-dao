// 增量解析 text/event-stream：喂一段文本，吐出完整的帧；注释行（": ping" 心跳）不成帧，但算「连接是活的」。
export interface SseFrame {
  id?: string;
  event?: string;
  data: string;
}

export class SseParser {
  #buf = '';
  #cur: { id?: string; event?: string; data: string[] } = { data: [] };

  /** 返回这次喂进去解出的完整帧，以及有没有收到过任何东西（含心跳注释）。 */
  push(chunk: string): { frames: SseFrame[]; alive: boolean } {
    this.#buf += chunk;
    const frames: SseFrame[] = [];
    const alive = chunk.length > 0;
    for (;;) {
      const nl = this.#buf.search(/\r\n|\n|\r/);
      if (nl < 0) break;
      const m = /^(\r\n|\n|\r)/.exec(this.#buf.slice(nl));
      const line = this.#buf.slice(0, nl);
      this.#buf = this.#buf.slice(nl + (m?.[1]?.length ?? 1));
      if (line === '') {
        if (this.#cur.data.length > 0 || this.#cur.event !== undefined || this.#cur.id !== undefined) {
          frames.push({
            ...(this.#cur.id !== undefined ? { id: this.#cur.id } : {}),
            ...(this.#cur.event !== undefined ? { event: this.#cur.event } : {}),
            data: this.#cur.data.join('\n'),
          });
        }
        this.#cur = { data: [] };
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'id') this.#cur.id = value;
      else if (field === 'event') this.#cur.event = value;
      else if (field === 'data') this.#cur.data.push(value);
    }
    return { frames, alive };
  }
}
