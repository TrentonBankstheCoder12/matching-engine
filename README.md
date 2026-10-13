# Matching Engine

[![CI](https://github.com/TrentonBankstheCoder12/matching-engine/actions/workflows/ci.yml/badge.svg)](https://github.com/TrentonBankstheCoder12/matching-engine/actions/workflows/ci.yml)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=nodedotjs&logoColor=white)
![Vitest](https://img.shields.io/badge/tested%20with-Vitest-6E9F18?logo=vitest&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-green)

A **limit order book and matching engine** with price-time priority, the core component of every stock exchange, crypto exchange and broker internalizer. Buy and sell orders rest in a sorted book; incoming orders that cross the spread trade against the best-priced, earliest resting orders first. Prices are integer ticks so comparisons are exact, cancels are O(1), and an invariant test checks that no quantity is ever created or lost across thousands of random orders.

## Features

- **Price-time priority (FIFO):** best price trades first; at the same price, the earliest order trades first
- **Order types:** limit and market orders
- **Time in force:** `GTC` (rest until cancelled), `IOC` (fill what you can, cancel the rest), `FOK` (fill completely or do nothing)
- **Exact prices:** integer ticks (e.g. cents) and integer lot quantities; no floating-point price comparisons
- **O(1) cancels:** cancelled orders are marked dead and skipped lazily during matching
- **Execution reports:** every submit returns status, filled/remaining quantity, trades and a reason on reject/cancel
- **Depth snapshots, best bid/ask and spread** for market-data style views
- **Demo and benchmark:** readable console walkthrough and a seeded throughput benchmark (roughly 1M ops/sec on a laptop-class dev container; your numbers will vary)

## Architecture

```
  OrderRequest ──▶ OrderBook.submit()
                       │ validate (ids, integer price/qty, market rules)
                       │ FOK pre-check: enough liquidity within limit?
                       ▼
                   match() ──────────────▶ Trade[] (at resting price)
                       │ walk contra side best-first
                       ▼
           ┌───────────────────────┐   ┌───────────────────────┐
           │ BookSide (bids)       │   │ BookSide (asks)       │
           │ levels[] desc by px   │   │ levels[] asc by px    │
           │ Map<price, level>     │   │ Map<price, level>     │
           └──────────┬────────────┘   └──────────┬────────────┘
                      ▼                           ▼
              PriceLevel: FIFO queue of RestingOrder
              (head pointer, lazy-skip cancelled orders)
                       │
                       ▼
          GTC remainder rests ── IOC / market remainder cancelled
```

| File | Responsibility |
|---|---|
| `src/types.ts` | Order, trade, report and snapshot types |
| `src/priceLevel.ts` | FIFO queue of orders at one price, with lazy cancel |
| `src/orderBook.ts` | `BookSide` sorted levels and the `OrderBook` matching logic |
| `src/demo.ts` | Console demo: depth ladder and trades |
| `src/bench.ts` | Seeded throughput benchmark |

## Quick start

```bash
npm ci
npm test        # run the test suite
npm run demo    # walk through a book in the console
npm run bench   # throughput benchmark (optionally: npm run bench -- 200000)
npm run build   # compile to dist/
```

## Usage example

```ts
import { OrderBook } from "./src/index.js";

const book = new OrderBook("ACME");

// Prices are integer cents: 10_001 = $100.01
book.submit({ id: "s1", side: "sell", type: "limit", price: 10_001, quantity: 150 });
book.submit({ id: "s2", side: "sell", type: "limit", price: 10_002, quantity: 250 });

const report = book.submit({ id: "b1", side: "buy", type: "limit", price: 10_002, quantity: 200 });
// report.status === "filled"
// report.trades:
//   { sellOrderId: "s1", price: 10001, quantity: 150, ... }
//   { sellOrderId: "s2", price: 10002, quantity: 50,  ... }

book.snapshot(); // { bids: [], asks: [{ price: 10002, quantity: 200, orders: 1 }] }
book.cancel("s2"); // true
```

Demo output excerpt:

```
> agg-buy: BUY 300 @ 100.02
    trade #1: 150 @ 100.01  (buy agg-buy / sell ask-1)
    trade #2: 100 @ 100.01  (buy agg-buy / sell ask-3)
    trade #3: 50 @ 100.02  (buy agg-buy / sell ask-2)
    => filled, filled 300, remaining 0
```

## Testing

```bash
npm test
```

The suite covers resting vs crossing orders, price priority on both sides, time priority within a level, partial fills, market sweeps, IOC and FOK semantics (including FOK respecting its limit), cancels of fresh and partially filled orders, FIFO ordering through queue compaction, validation, and a property-style test that streams 2,000 random orders and asserts the book is never crossed and total quantity is conserved.

## What I'd add next

- A price band ("collar") on market orders so a thin book can't fill them at absurd prices
- A balanced tree or tick-indexed array for levels so inserting a new price is O(log n) / O(1) instead of an O(n) splice
- Order amend (reduce quantity keeps priority, price change loses it)
- Self-trade prevention using `traderId`
- An event log / journal so the book can be rebuilt deterministically after a crash

See [WALKTHROUGH.md](WALKTHROUGH.md) for the design decisions behind this project.

## License

MIT
