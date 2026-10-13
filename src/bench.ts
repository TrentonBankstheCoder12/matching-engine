/**
 * Throughput benchmark: replays a seeded random stream of limit orders,
 * market orders and cancels against one book and reports orders/sec.
 * Seeded so runs are comparable across machines and code changes.
 *
 * Usage: npm run bench -- [orderCount]
 */
import { OrderBook } from "./orderBook.js";
import type { OrderRequest } from "./types.js";

const N = Number(process.argv[2] ?? 1_000_000);

// Small LCG PRNG: deterministic and fast; statistical quality is irrelevant here.
let state = 12345;
const rand = (): number => {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return state / 2 ** 32;
};

function buildStream(n: number): Array<OrderRequest | { cancel: string }> {
  const ops: Array<OrderRequest | { cancel: string }> = [];
  const live: string[] = [];
  const mid = 10_000;
  for (let i = 0; i < n; i++) {
    const r = rand();
    if (r < 0.2 && live.length > 0) {
      // Cancel a random earlier order (it may already be filled; cancel then returns false).
      const idx = Math.floor(rand() * live.length);
      ops.push({ cancel: live[idx] });
      live[idx] = live[live.length - 1];
      live.pop();
    } else if (r < 0.25) {
      ops.push({ id: `o${i}`, side: rand() < 0.5 ? "buy" : "sell", type: "market", quantity: 1 + Math.floor(rand() * 50) });
    } else {
      const side = rand() < 0.5 ? "buy" : "sell";
      // Prices cluster around mid with some orders crossing the spread.
      const offset = Math.floor(rand() * 40) - 10;
      const price = side === "buy" ? mid - offset : mid + offset;
      const id = `o${i}`;
      ops.push({ id, side, type: "limit", price, quantity: 1 + Math.floor(rand() * 100) });
      live.push(id);
    }
  }
  return ops;
}

const ops = buildStream(N);
const book = new OrderBook("BENCH");

// Warm up the JIT on a separate book so the timed run measures steady state.
const warm = new OrderBook("WARM");
for (const op of ops.slice(0, Math.min(50_000, ops.length))) {
  if ("cancel" in op) warm.cancel(op.cancel);
  else warm.submit(op);
}

const start = process.hrtime.bigint();
for (const op of ops) {
  if ("cancel" in op) book.cancel(op.cancel);
  else book.submit(op);
}
const elapsedNs = Number(process.hrtime.bigint() - start);

const seconds = elapsedNs / 1e9;
const snap = book.snapshot(Number.MAX_SAFE_INTEGER);
console.log(`operations:     ${N.toLocaleString()}`);
console.log(`elapsed:        ${(seconds * 1000).toFixed(1)} ms`);
console.log(`throughput:     ${Math.round(N / seconds).toLocaleString()} ops/sec`);
console.log(`mean latency:   ${(elapsedNs / N).toFixed(0)} ns/op`);
console.log(`trades:         ${book.tradeLog.length.toLocaleString()}`);
console.log(`resting levels: ${snap.bids.length} bids / ${snap.asks.length} asks`);
