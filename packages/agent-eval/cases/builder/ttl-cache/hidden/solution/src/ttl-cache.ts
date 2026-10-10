export interface TtlCacheOptions {
  max: number;
  ttlMs: number;
  now?: () => number;
}

export class TtlCache<K, V> {
  readonly #max: number;
  readonly #ttlMs: number;
  readonly #now: () => number;
  // Map 的插入顺序就是「最近用过」的顺序：最久没用的在最前。
  readonly #items = new Map<K, { value: V; expiresAt: number }>();

  constructor(opts: TtlCacheOptions) {
    if (!Number.isInteger(opts.max) || opts.max <= 0) throw new RangeError('max must be a positive integer');
    if (!Number.isInteger(opts.ttlMs) || opts.ttlMs <= 0)
      throw new RangeError('ttlMs must be a positive integer');
    this.#max = opts.max;
    this.#ttlMs = opts.ttlMs;
    this.#now = opts.now ?? Date.now;
  }

  #sweep(): void {
    const t = this.#now();
    for (const [k, v] of this.#items) if (v.expiresAt <= t) this.#items.delete(k);
  }

  get size(): number {
    this.#sweep();
    return this.#items.size;
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  get(key: K): V | undefined {
    const hit = this.#items.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= this.#now()) {
      this.#items.delete(key);
      return undefined;
    }
    this.#items.delete(key);
    this.#items.set(key, hit);
    return hit.value;
  }

  set(key: K, value: V): void {
    this.#sweep();
    this.#items.delete(key);
    this.#items.set(key, { value, expiresAt: this.#now() + this.#ttlMs });
    while (this.#items.size > this.#max) {
      const oldest = this.#items.keys().next();
      if (oldest.done) break;
      this.#items.delete(oldest.value);
    }
  }

  delete(key: K): boolean {
    return this.#items.delete(key);
  }
}
