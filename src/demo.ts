/**
 * Console walkthrough of the engine: build a small book, print the depth
 * ladder, then send aggressive orders and show the trades they produce.
 * Prices are integer cents; formatting to dollars happens only at the edge.
 */
import { OrderBook } from "./orderBook.js";
import type { ExecutionReport, OrderRequest } from "./types.js";

const dollars = (cents: number): string => (cents / 100).toFixed(2);

function printLadder(book: OrderBook, depth = 5): void {
  const { bids, asks } = book.snapshot(depth);
  console.log(`\n  ${book.symbol} depth (top ${depth})`);
  console.log("  ┌────────┬──────────┬────────┐");
  console.log("  │ orders │    price │    qty │");
  console.log("  ├────────┼──────────┼────────┤");
  // Asks are printed highest-first so the spread sits in the middle of the ladder.
  for (const l of [...asks].reverse()) {
    console.log(`  │ ${String(l.orders).padStart(6)} │ ${dollars(l.price).padStart(8)} │ ${String(l.quantity).padStart(5)}A │`);
  }
  const spread = book.spread();
  console.log(`  ├──── spread: ${spread === undefined ? "n/a" : dollars(spread)} ${"─".repeat(Math.max(0, 14 - (spread === undefined ? 3 : dollars(spread).length)))}┤`);
  for (const l of bids) {
    console.log(`  │ ${String(l.orders).padStart(6)} │ ${dollars(l.price).padStart(8)} │ ${String(l.quantity).padStart(5)}B │`);
  }
  console.log("  └────────┴──────────┴────────┘");
}

function describe(req: OrderRequest): string {
  const px = req.price === undefined ? "MKT" : `@ ${dollars(req.price)}`;
  return `${req.id}: ${req.side.toUpperCase()} ${req.quantity} ${px}${req.timeInForce ? ` ${req.timeInForce}` : ""}`;
}

function send(book: OrderBook, req: OrderRequest): ExecutionReport {
  const r = book.submit(req);
  console.log(`\n> ${describe(req)}`);
  for (const t of r.trades) {
    console.log(`    trade #${t.seq}: ${t.quantity} @ ${dollars(t.price)}  (buy ${t.buyOrderId} / sell ${t.sellOrderId})`);
  }
  console.log(`    => ${r.status}, filled ${r.filledQuantity}, remaining ${r.remainingQuantity}${r.reason ? ` (${r.reason})` : ""}`);
  return r;
}

const book = new OrderBook("ACME");

console.log("1) Seed the book with resting limit orders (no crosses yet)");
const seed: OrderRequest[] = [
  { id: "bid-1", side: "buy", type: "limit", price: 9_998, quantity: 300 },
  { id: "bid-2", side: "buy", type: "limit", price: 9_999, quantity: 200 },
  { id: "bid-3", side: "buy", type: "limit", price: 9_999, quantity: 100 },
  { id: "bid-4", side: "buy", type: "limit", price: 9_995, quantity: 500 },
  { id: "ask-1", side: "sell", type: "limit", price: 10_001, quantity: 150 },
  { id: "ask-2", side: "sell", type: "limit", price: 10_002, quantity: 250 },
  { id: "ask-3", side: "sell", type: "limit", price: 10_001, quantity: 100 },
  { id: "ask-4", side: "sell", type: "limit", price: 10_005, quantity: 400 },
];
for (const o of seed) book.submit(o);
printLadder(book);

console.log("\n2) Aggressive buy limit crosses the spread: price priority, then time priority");
send(book, { id: "agg-buy", side: "buy", type: "limit", price: 10_002, quantity: 300 });
printLadder(book);

console.log("\n3) Market sell sweeps bids best-first; trades print at each resting price");
send(book, { id: "mkt-sell", side: "sell", type: "market", quantity: 350 });

console.log("\n4) Fill-or-kill that cannot be fully filled does nothing");
send(book, { id: "fok-buy", side: "buy", type: "limit", price: 10_002, quantity: 10_000, timeInForce: "FOK" });

console.log("\n5) IOC takes what is available and cancels the rest");
send(book, { id: "ioc-buy", side: "buy", type: "limit", price: 10_002, quantity: 300, timeInForce: "IOC" });

console.log("\n6) Cancel a resting order");
console.log(`\n> cancel bid-4 -> ${book.cancel("bid-4")}`);
printLadder(book);

console.log(`\nTotal trades: ${book.tradeLog.length}`);
