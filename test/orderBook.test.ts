import { describe, expect, it } from "vitest";
import { OrderBook } from "../src/index.js";

const limit = (id: string, side: "buy" | "sell", price: number, quantity: number, extra = {}) => ({
  id,
  side,
  type: "limit" as const,
  price,
  quantity,
  ...extra,
});

describe("OrderBook", () => {
  it("rests a limit order when nothing crosses", () => {
    const book = new OrderBook("AAPL");
    const r = book.submit(limit("b1", "buy", 100, 10));
    expect(r.status).toBe("resting");
    expect(book.bestBid()).toBe(100);
    expect(book.bestAsk()).toBeUndefined();
  });

  it("matches crossing orders at the resting price", () => {
    const book = new OrderBook("AAPL");
    book.submit(limit("s1", "sell", 101, 5));
    const r = book.submit(limit("b1", "buy", 105, 5));
    expect(r.status).toBe("filled");
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]).toMatchObject({ price: 101, quantity: 5, buyOrderId: "b1", sellOrderId: "s1" });
  });

  it("enforces price priority: best price fills first", () => {
    const book = new OrderBook("AAPL");
    book.submit(limit("s-102", "sell", 102, 5));
    book.submit(limit("s-100", "sell", 100, 5));
    book.submit(limit("s-101", "sell", 101, 5));
    const r = book.submit(limit("b1", "buy", 102, 12));
    expect(r.trades.map((t) => t.sellOrderId)).toEqual(["s-100", "s-101", "s-102"]);
    expect(r.trades.map((t) => t.quantity)).toEqual([5, 5, 2]);
  });

  it("enforces time priority within a price level", () => {
    const book = new OrderBook("AAPL");
    book.submit(limit("first", "sell", 100, 3));
    book.submit(limit("second", "sell", 100, 3));
    const r = book.submit(limit("b1", "buy", 100, 4));
    expect(r.trades.map((t) => [t.sellOrderId, t.quantity])).toEqual([
      ["first", 3],
      ["second", 1],
    ]);
    expect(book.openOrder("second")?.remaining).toBe(2);
  });

  it("partially fills and rests the remainder", () => {
    const book = new OrderBook("AAPL");
    book.submit(limit("s1", "sell", 100, 4));
    const r = book.submit(limit("b1", "buy", 100, 10));
    expect(r.status).toBe("partially_filled");
    expect(r.remainingQuantity).toBe(6);
    expect(book.bestBid()).toBe(100);
    expect(book.bestAsk()).toBeUndefined();
  });

  it("market orders sweep the book and never rest", () => {
    const book = new OrderBook("AAPL");
    book.submit(limit("s1", "sell", 100, 2));
    book.submit(limit("s2", "sell", 105, 2));
    const r = book.submit({ id: "m1", side: "buy", type: "market", quantity: 10 });
    expect(r.filledQuantity).toBe(4);
    expect(r.status).toBe("cancelled");
    expect(book.bestBid()).toBeUndefined();
  });

  it("IOC fills what it can and cancels the rest", () => {
    const book = new OrderBook("AAPL");
    book.submit(limit("s1", "sell", 100, 3));
    const r = book.submit(limit("b1", "buy", 100, 5, { timeInForce: "IOC" }));
    expect(r.filledQuantity).toBe(3);
    expect(r.status).toBe("cancelled");
    expect(book.bestBid()).toBeUndefined();
  });

  it("FOK trades nothing unless it can fill completely", () => {
    const book = new OrderBook("AAPL");
    book.submit(limit("s1", "sell", 100, 3));
    const miss = book.submit(limit("b1", "buy", 100, 5, { timeInForce: "FOK" }));
    expect(miss.status).toBe("cancelled");
    expect(miss.trades).toHaveLength(0);
    expect(book.openOrder("s1")?.remaining).toBe(3);

    const hit = book.submit(limit("b2", "buy", 100, 3, { timeInForce: "FOK" }));
    expect(hit.status).toBe("filled");
  });

  it("cancels resting orders and cleans up empty levels", () => {
    const book = new OrderBook("AAPL");
    book.submit(limit("b1", "buy", 99, 5));
    book.submit(limit("b2", "buy", 98, 5));
    expect(book.cancel("b1")).toBe(true);
    expect(book.bestBid()).toBe(98);
    expect(book.cancel("b1")).toBe(false);
  });

  it("cancelled orders are skipped during matching", () => {
    const book = new OrderBook("AAPL");
    book.submit(limit("s1", "sell", 100, 5));
    book.submit(limit("s2", "sell", 100, 5));
    book.cancel("s1");
    const r = book.submit(limit("b1", "buy", 100, 5));
    expect(r.trades[0].sellOrderId).toBe("s2");
  });

  it("reports depth snapshots and spread", () => {
    const book = new OrderBook("AAPL");
    book.submit(limit("b1", "buy", 99, 5));
    book.submit(limit("b2", "buy", 99, 7));
    book.submit(limit("s1", "sell", 102, 4));
    expect(book.snapshot()).toEqual({
      bids: [{ price: 99, quantity: 12, orders: 2 }],
      asks: [{ price: 102, quantity: 4, orders: 1 }],
    });
    expect(book.spread()).toBe(3);
  });

  it("rejects invalid orders", () => {
    const book = new OrderBook("AAPL");
    expect(book.submit(limit("x", "buy", 100, 0)).status).toBe("rejected");
    expect(book.submit(limit("y", "buy", 100.5, 1)).status).toBe("rejected");
    expect(book.submit({ id: "z", side: "buy", type: "limit", quantity: 1 }).status).toBe("rejected");
    book.submit(limit("dup", "buy", 100, 1));
    expect(book.submit(limit("dup", "buy", 100, 1)).status).toBe("rejected");
  });

  it("conserves quantity across a random order stream", () => {
    const book = new OrderBook("SIM");
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    let submitted = 0;
    let filledBuy = 0;
    let filledSell = 0;
    for (let i = 0; i < 2000; i++) {
      const side = rand() < 0.5 ? "buy" : "sell";
      const qty = 1 + Math.floor(rand() * 20);
      submitted += qty;
      const r = book.submit(limit(`o${i}`, side, 95 + Math.floor(rand() * 10), qty));
      for (const t of r.trades) {
        filledBuy += t.quantity;
        filledSell += t.quantity;
      }
      // The book must never be crossed after matching.
      const bid = book.bestBid();
      const ask = book.bestAsk();
      if (bid !== undefined && ask !== undefined) expect(bid).toBeLessThan(ask);
    }
    const resting = [...book.snapshot(1000).bids, ...book.snapshot(1000).asks].reduce((s, l) => s + l.quantity, 0);
    expect(filledBuy).toBe(filledSell);
    expect(resting + filledBuy + filledSell).toBe(submitted);
  });

  it("matches sell aggressors against the highest bid first", () => {
    const book = new OrderBook("AAPL");
    book.submit(limit("b-98", "buy", 98, 5));
    book.submit(limit("b-100", "buy", 100, 5));
    const r = book.submit(limit("s1", "sell", 97, 7));
    expect(r.trades.map((t) => [t.buyOrderId, t.price, t.quantity])).toEqual([
      ["b-100", 100, 5],
      ["b-98", 98, 2],
    ]);
    expect(r.trades.every((t) => t.aggressor === "sell")).toBe(true);
  });

  it("FOK only counts liquidity inside its limit price", () => {
    const book = new OrderBook("AAPL");
    book.submit(limit("s1", "sell", 100, 3));
    book.submit(limit("s2", "sell", 101, 3));
    const r = book.submit(limit("b1", "buy", 100, 5, { timeInForce: "FOK" }));
    expect(r.status).toBe("cancelled");
    expect(book.snapshot().asks.map((l) => l.quantity)).toEqual([3, 3]);
  });

  it("cancelling a partially filled order removes only its remainder", () => {
    const book = new OrderBook("AAPL");
    book.submit(limit("s1", "sell", 100, 10));
    book.submit(limit("s2", "sell", 100, 4));
    book.submit(limit("b1", "buy", 100, 6));
    expect(book.cancel("s1")).toBe(true);
    expect(book.snapshot().asks).toEqual([{ price: 100, quantity: 4, orders: 1 }]);
  });

  it("filled orders leave the open-order index and cannot be cancelled", () => {
    const book = new OrderBook("AAPL");
    book.submit(limit("s1", "sell", 100, 2));
    book.submit(limit("b1", "buy", 100, 2));
    expect(book.openOrder("s1")).toBeUndefined();
    expect(book.cancel("s1")).toBe(false);
    expect(book.snapshot()).toEqual({ bids: [], asks: [] });
  });

  it("rejects market orders that try to rest or carry a price", () => {
    const book = new OrderBook("AAPL");
    expect(book.submit({ id: "m1", side: "buy", type: "market", quantity: 1, timeInForce: "GTC" }).status).toBe(
      "rejected",
    );
    expect(book.submit({ id: "m2", side: "buy", type: "market", quantity: 1, price: 100 }).status).toBe("rejected");
  });

  it("keeps FIFO order through queue compaction with many fills and cancels", () => {
    const book = new OrderBook("AAPL");
    for (let i = 0; i < 3000; i++) book.submit(limit(`s${i}`, "sell", 100, 1));
    for (let i = 1; i < 3000; i += 2) book.cancel(`s${i}`); // cancel every odd order
    const r = book.submit(limit("b1", "buy", 100, 1200));
    // Only even-numbered orders are live, so the 1200 fills are s0, s2, ..., s2398 in order.
    expect(r.trades.map((t) => t.sellOrderId)).toEqual(Array.from({ length: 1200 }, (_, k) => `s${2 * k}`));
    expect(book.snapshot().asks).toEqual([{ price: 100, quantity: 300, orders: 300 }]);
  });
});
