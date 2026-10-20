/** v3 原帧协议；只改变运输方式，不改变归档字节。 */
export const SNAPSHOT_METADATA_BYTES = 32 * 1024 * 1024;
export const SNAPSHOT_TOTAL_BYTES = 1024 * 1024 * 1024;
export const SNAPSHOT_MAX_COMPONENTS = 100_003;
export const SNAPSHOT_MAX_OBJECTS = 250_000;
export const SNAPSHOT_MAX_PATH_BYTES = 4096;
export interface FrameComponent {
  name: string;
  length: number;
}
interface FrameSink {
  begin: (component: FrameComponent) => Promise<void>;
  write: (chunk: Buffer) => Promise<void>;
  end: () => Promise<void>;
}

/** header 验过再调用 begin；sink 逐块等待，任何错误均不能产生完整回执。 */
export class SnapshotFrameReader {
  private header = Buffer.alloc(0);
  private remaining = 0;
  private declared = 0;
  private received = 0;
  private count = 0;
  private ended = false;
  private component: FrameComponent | undefined;
  private lastBlob = '';
  private readonly sink: FrameSink;
  constructor(sink: FrameSink) {
    this.sink = sink;
  }

  async write(chunk: Buffer): Promise<void> {
    this.received += chunk.length;
    if (this.received > SNAPSHOT_TOTAL_BYTES) throw new Error('快照流超过总预算');
    let offset = 0;
    while (offset < chunk.length) {
      if (this.ended) throw new Error('快照 END 后有多余字节');
      if (this.component) {
        const take = Math.min(this.remaining, chunk.length - offset);
        if (take > 0) await this.sink.write(chunk.subarray(offset, offset + take));
        offset += take;
        this.remaining -= take;
        if (this.remaining === 0) {
          await this.sink.end();
          this.component = undefined;
        }
        continue;
      }
      const newline = chunk.indexOf(10, offset);
      const stop = newline < 0 ? chunk.length : newline;
      if (this.header.length + stop - offset > 100) throw new Error('快照帧头过长');
      this.header = Buffer.concat([this.header, chunk.subarray(offset, stop)]);
      offset = stop;
      if (newline < 0) break;
      offset += 1;
      const line = this.header.toString('ascii');
      // ASCII 解码会丢高位，必须先验证原始字节。
      if ([...this.header].some((byte) => byte > 127)) throw new Error('快照帧头不是 ASCII');
      this.declared += this.header.length + 1;
      this.header = Buffer.alloc(0);
      if (line === 'END') {
        if (this.count < 3) throw new Error('快照缺组件');
        if (this.declared > SNAPSHOT_TOTAL_BYTES) throw new Error('快照声明超过总预算');
        this.ended = true;
        continue;
      }
      const matched = /^(JSON|PACK|BUNDLE|BLOB [0-9a-f]{64}) (0|[1-9][0-9]*)$/.exec(line);
      if (!matched?.[1] || !matched[2]) throw new Error('快照帧头认不出');
      const name = matched[1];
      const length = Number(matched[2]);
      if (!Number.isSafeInteger(length)) throw new Error('快照组件长度越界');
      const required = ['JSON', 'PACK', 'BUNDLE'][this.count];
      if (required ? name !== required : !name.startsWith('BLOB '))
        throw new Error('快照组件缺失、重复或次序错误');
      if (name.startsWith('BLOB ')) {
        const sum = name.slice(5);
        if (sum <= this.lastBlob) throw new Error('快照内容重复或次序错误');
        this.lastBlob = sum;
      }
      if (name === 'JSON' && length > SNAPSHOT_METADATA_BYTES) throw new Error('快照元数据超过 32MiB');
      this.declared += length;
      if (this.declared + 4 > SNAPSHOT_TOTAL_BYTES) throw new Error('快照声明超过总预算');
      this.count += 1;
      if (this.count > SNAPSHOT_MAX_COMPONENTS) throw new Error('快照组件太多');
      this.component = { name, length };
      this.remaining = length;
      await this.sink.begin(this.component);
      if (length === 0) {
        await this.sink.end();
        this.component = undefined;
      }
    }
  }

  finish(): void {
    if (!this.ended || this.component || this.header.length) throw new Error('快照帧不完整');
    if (this.received !== this.declared) throw new Error('快照长度对不上');
  }
}
