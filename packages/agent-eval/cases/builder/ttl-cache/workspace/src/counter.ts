/** 一个只会加一的计数器：同一个包里已有的东西，和要做的缓存无关，别改它。 */
export class Counter {
  #n = 0;

  next(): number {
    this.#n += 1;
    return this.#n;
  }
}
