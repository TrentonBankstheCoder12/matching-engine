# Walkthrough: Matching Engine

A guide to how this project works and why it was built this way. Read it top to bottom, then try to explain each section out loud without looking. That is roughly what an interviewer will ask you to do.

## 1. The core idea: a limit order book

An exchange keeps two lists of orders that have not traded yet:

- **Bids:** people willing to buy, sorted highest price first
- **Asks:** people willing to sell, sorted lowest price first

The **best bid** is the highest bid, the **best ask** is the lowest ask, and the gap between them is the **spread**. When a new order arrives whose price reaches the other side (a buy at or above the best ask, or a sell at or below the best bid), it **crosses** and trades. Whatever does not trade either rests in the book or is cancelled, depending on its type.

After matching, the book is never crossed: best bid is always strictly below best ask. The random-stream test asserts this after every order.

Code: `OrderBook.submit` and `OrderBook.match` in `src/orderBook.ts`.

## 2. Price-time priority

When several resting orders could fill an incoming order, who goes first?

1. **Price priority:** the best price wins. A buyer sweeps the $100.00 ask before the $100.01 ask.
2. **Time priority:** at the same price, the order that arrived first wins (FIFO).

This is the fairness rule used by most equity and crypto exchanges. It rewards traders who offer better prices and who commit earlier.

`match()` implements it by repeatedly taking `contra.best()` (the best price level) and `level.peek()` (the oldest live order in that level) until the incoming order is filled or the next price is worse than its limit.

## 3. Why integer ticks

Prices are stored as integers in the smallest tick (e.g. cents: `10_001` = $100.01). Two reasons:

- **Exact comparisons.** `0.1 + 0.2 !== 0.3` in floating point. A book keyed by price must decide whether two orders are *at the same level*; a float that is off by 1e-15 would create a phantom second level and break time priority.
- **Map keys.** Levels are looked up in a `Map<number, PriceLevel>`. Integer keys are exact; float keys are not trustworthy after arithmetic.

`validate()` rejects non-integer prices and quantities. Dollars only appear at the display edge (`dollars()` in `src/demo.ts`). Real exchanges do the same with a per-symbol tick size.

## 4. FIFO price levels with lazy cancel

Each price has a `PriceLevel` (`src/priceLevel.ts`): an array used as a queue.

- **Append** new orders at the tail: O(1).
- **Fill** from the head. Instead of `Array.shift()` (which copies the whole array, O(n)), the level keeps a `head` index and moves it forward.
- **Cancel** just sets `remaining = 0` and adjusts the level's totals: O(1). The dead order stays in the array and `peek()` skips it the next time it reaches the head. This is **lazy deletion**.
- **Compaction:** once the dead prefix is large (over 1024 entries and more than half the array), the array is sliced so memory doesn't grow forever. The test "keeps FIFO order through queue compaction" pushes 3,000 orders, cancels half and checks fills still come out in arrival order.

The level also tracks `totalQuantity` and `liveOrders` incrementally so depth snapshots never have to walk the queue.

The `OrderBook` keeps a `Map<orderId, RestingOrder>` so `cancel(id)` can find the order without searching.

## 5. Sorted levels: binary search plus splice

Each side (`BookSide`) holds:

- `levels: PriceLevel[]`, sorted best-first, so the best price is always `levels[0]`
- `byPrice: Map<number, PriceLevel>` for O(1) lookup of an existing level

When a new price appears, `getOrCreate` binary-searches for the insertion point (O(log n)) and then `splice`s it in. **The splice is O(n)** because the array must shift every element after the insertion point. Removing an empty level is also O(n) (`indexOf` + `splice`).

**Why accept that?** In real markets almost all activity is within a few ticks of the best price, and the number of distinct price levels is small (tens to low hundreds). For small n, a contiguous array is very cache-friendly and in practice beats pointer-heavy structures. Reading the best price is O(1).

**Alternatives:**

| Structure | Insert new level | Best price | Remove level | Notes |
|---|---|---|---|---|
| Sorted array (this repo) | O(log n) search + O(n) shift | O(1) | O(n) | Simple, cache-friendly, fine for small n |
| Balanced tree (red-black / AVL) | O(log n) | O(log n) or O(1) with cached min | O(log n) | Scales to many levels, more code |
| Binary heap | O(log n) | O(1) | O(n) arbitrary removal (needs lazy delete) | Great for "pop best", awkward for depth views |
| Tick-indexed array | O(1) | O(1) amortized scan | O(1) | Used by HFT engines when price range is bounded |

Knowing *why* you picked the simple option, and when it would stop being good enough, is the point.

## 6. Time in force: GTC, IOC, FOK

| TIF | Meaning | Implementation |
|---|---|---|
| `GTC` Good-'til-cancelled | Trade what crosses, rest the remainder | `rest()` after `match()` |
| `IOC` Immediate-or-cancel | Trade what crosses now, cancel the remainder | Remainder returned as `cancelled` |
| `FOK` Fill-or-kill | Trade the full quantity now or do nothing | `liquidityUpTo()` check *before* matching |

FOK must be checked **before** matching because trades cannot be undone. `liquidityUpTo(limit, wanted)` sums quantity on the contra side only at prices within the order's limit, stopping early once it has enough. The test "FOK only counts liquidity inside its limit price" makes sure liquidity at a worse price is not counted.

Defaults: limit orders are GTC, market orders are IOC. A market order with GTC is rejected because a market order has no price to rest at.

## 7. Why trades execute at the resting price

If the best ask is $100.01 and someone sends a buy limit at $100.05, the trade prints at **$100.01**, not $100.05 and not the midpoint.

- The resting order was there first and publicly advertised $100.01; it set the price.
- The incoming buyer said "up to $100.05", so $100.01 is within what they accepted; they get **price improvement**.
- It makes outcomes deterministic and is the standard rule on continuous-trading exchanges.

Code: `price: level.price` in `match()`.

## 8. Known limitation: market-order protection

Market orders here have no price limit at all. In a thin book, a large market buy will sweep every ask level, however far away, and fill at whatever prices are there. Real exchanges protect against this with **price bands / collars** (e.g. reject or cap a market order beyond X% from the last trade or reference price), or by converting market orders into aggressive limit orders. Adding a collar would be a few lines in `submit`: compute a protection price from the best contra price and pass it to `match()` as `limit`.

Other limitations worth naming:

- Single-threaded, in-memory, one symbol per `OrderBook`. No persistence or journal; a crash loses the book.
- No self-trade prevention (`traderId` is stored but unused).
- `tradeLog` grows without bound; a real engine would stream trades to a market-data publisher instead.

## Likely interview questions

1. **What is price-time priority?** Best price fills first; at equal price, earliest arrival fills first (section 2).
2. **Why not use floats for prices?** Inexact comparisons create phantom levels and break priority; use integer ticks (section 3).
3. **How do you make cancel fast?** Index orders by ID and lazy-delete: mark dead in O(1), skip at the head later (section 4).
4. **What data structure holds the price levels and what is its complexity?** Sorted array with binary search: O(1) best, O(log n) search, O(n) insert/remove; a tree gives O(log n) everywhere (section 5).
5. **How does FOK differ from IOC?** IOC can partially fill; FOK checks full liquidity first and trades nothing otherwise (section 6).
6. **At what price does a crossing order trade, and why?** The resting order's price; it set the market and the aggressor gets price improvement (section 7).
7. **What would you change for production?** Market-order collars, a write-ahead journal for recovery, self-trade prevention, and one engine thread per symbol shard (section 8).

## Try extending it

- Add a price collar for market orders and a test where a thin book would otherwise fill far away
- Replace `BookSide.levels` with a red-black tree or tick-indexed array and compare `npm run bench`
- Add `amend(orderId, newQty)`: reducing quantity keeps priority, increasing it or changing price sends the order to the back
- Add self-trade prevention: cancel the resting order when both sides share a `traderId`
- Emit trades and book updates as events instead of storing them in `tradeLog`
