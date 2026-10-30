// 把子进程 stdout 的字节流切成行：跨块的多字节字符不会被切坏，\r\n 当 \n，超长行整行丢掉并计数。
import { StringDecoder } from 'node:string_decoder';

/** 单行上限。工具结果会把整份文件塞进一行，给足余量；超过的丢掉，免得一行吃光内存。 */
export const DEFAULT_MAX_LINE_CHARS = 32 * 1024 * 1024;

export class LineSplitter {
  #decoder = new StringDecoder('utf8');
  #pending = '';
  #skipping = false;
  readonly #max: number;
  /** 因为超长被丢掉的行数。 */
  dropped = 0;

  constructor(maxLineChars: number = DEFAULT_MAX_LINE_CHARS) {
    this.#max = maxLineChars;
  }

  push(chunk: Buffer | string): string[] {
    return this.#take(typeof chunk === 'string' ? chunk : this.#decoder.write(chunk));
  }

  /** 流结束：没有换行收尾的最后一段也算一行。 */
  end(): string[] {
    const lines = this.#take(this.#decoder.end());
    if (!this.#skipping && this.#pending !== '') lines.push(trimCr(this.#pending));
    this.#pending = '';
    this.#skipping = false;
    return lines;
  }

  #take(text: string): string[] {
    const lines: string[] = [];
    let from = 0;
    for (let nl = text.indexOf('\n'); nl >= 0; nl = text.indexOf('\n', from)) {
      const piece = text.slice(from, nl);
      if (this.#skipping) {
        this.#skipping = false;
      } else if (this.#pending.length + piece.length > this.#max) {
        this.dropped++;
      } else {
        lines.push(trimCr(this.#pending + piece));
      }
      this.#pending = '';
      from = nl + 1;
    }
    if (!this.#skipping) {
      this.#pending += text.slice(from);
      if (this.#pending.length > this.#max) {
        this.#pending = '';
        this.#skipping = true;
        this.dropped++;
      }
    }
    return lines;
  }
}

function trimCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}
