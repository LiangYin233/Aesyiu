export class EventQueue<T> {
  private buffer: T[] = [];
  private pending: ((value: IteratorResult<T, void>) => void) | null = null;
  private closed = false;

  push(item: T): void {
    if (this.closed) { return; }
    if (this.pending) {
      this.pending({ value: item, done: false });
      this.pending = null;
      return;
    }
    this.buffer.push(item);
  }

  close(): void {
    this.closed = true;
    if (this.pending) {
      this.pending({ value: undefined, done: true });
      this.pending = null;
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T, void> {
    while (true) {
      const item = this.buffer.shift();
      if (item !== undefined) {
        yield item;
        continue;
      }
      if (this.closed) { return; }
      const result = await new Promise<IteratorResult<T, void>>((resolve) => {
        this.pending = resolve;
      });
      if (result.done) { return; }
      yield result.value;
    }
  }
}
