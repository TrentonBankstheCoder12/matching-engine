import type { RestingOrder } from "./types.js";

/**
 * A FIFO queue of orders resting at one price. Orders are appended at the
 * tail and filled from the head, which gives time priority within a price.
 *
 * Cancels mark an order removed and are skipped lazily, making cancel O(1)
 * instead of O(n) array splicing. The head pointer avoids Array.shift(),
 * which is O(n) in most JS engines.
 */
export class PriceLevel {
  private queue: RestingOrder[] = [];
  private head = 0;
  totalQuantity = 0;
  liveOrders = 0;

  constructor(readonly price: number) {}

  push(order: RestingOrder): void {
    this.queue.push(order);
    this.totalQuantity += order.remaining;
    this.liveOrders++;
  }

  /** First live order, skipping any that were cancelled. */
  peek(): RestingOrder | undefined {
    while (this.head < this.queue.length && this.queue[this.head].remaining === 0) {
      this.head++;
    }
    this.compact();
    return this.queue[this.head];
  }

  /** Reduce the head order after a fill; drops it once fully filled. */
  fillHead(quantity: number): void {
    const order = this.peek();
    if (!order) throw new Error("fillHead on empty level");
    order.remaining -= quantity;
    this.totalQuantity -= quantity;
    if (order.remaining === 0) {
      this.liveOrders--;
      this.head++;
    }
  }

  cancel(order: RestingOrder): void {
    this.totalQuantity -= order.remaining;
    order.remaining = 0;
    this.liveOrders--;
  }

  isEmpty(): boolean {
    return this.liveOrders === 0;
  }

  *orders(): Generator<RestingOrder> {
    for (let i = this.head; i < this.queue.length; i++) {
      if (this.queue[i].remaining > 0) yield this.queue[i];
    }
  }

  private compact(): void {
    // Reclaim memory once the dead prefix grows large.
    if (this.head > 1024 && this.head * 2 > this.queue.length) {
      this.queue = this.queue.slice(this.head);
      this.head = 0;
    }
  }
}
