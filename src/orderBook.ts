import { PriceLevel } from "./priceLevel.js";
import type {
  BookSnapshot,
  ExecutionReport,
  OrderRequest,
  RestingOrder,
  Side,
  Trade,
} from "./types.js";

/**
 * Sorted list of price levels for one side of the book.
 * Bids are kept best-first in descending order, asks in ascending order,
 * so the best price is always index 0. Insertion uses binary search.
 */
class BookSide {
  readonly levels: PriceLevel[] = [];
  private byPrice = new Map<number, PriceLevel>();

  constructor(private readonly side: Side) {}

  /** True if price a ranks ahead of price b on this side. */
  private better(a: number, b: number): boolean {
    return this.side === "buy" ? a > b : a < b;
  }

  best(): PriceLevel | undefined {
    return this.levels[0];
  }

  getOrCreate(price: number): PriceLevel {
    const existing = this.byPrice.get(price);
    if (existing) return existing;
    const level = new PriceLevel(price);
    let lo = 0;
    let hi = this.levels.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.better(this.levels[mid].price, price)) lo = mid + 1;
      else hi = mid;
    }
    this.levels.splice(lo, 0, level);
    this.byPrice.set(price, level);
    return level;
  }

  get(price: number): PriceLevel | undefined {
    return this.byPrice.get(price);
  }

  removeIfEmpty(level: PriceLevel): void {
    if (!level.isEmpty()) return;
    this.byPrice.delete(level.price);
    const idx = this.levels.indexOf(level);
    if (idx !== -1) this.levels.splice(idx, 1);
  }

  /** Total quantity available at prices that cross the given limit. */
  liquidityUpTo(limit: number | undefined, wanted: number): number {
    let total = 0;
    for (const level of this.levels) {
      if (limit !== undefined && this.better(limit, level.price)) break;
      total += level.totalQuantity;
      if (total >= wanted) break;
    }
    return total;
  }
}

export class OrderBook {
  private bids = new BookSide("buy");
  private asks = new BookSide("sell");
  private ordersById = new Map<string, RestingOrder>();
  private seq = 0;
  private tradeSeq = 0;
  readonly tradeLog: Trade[] = [];

  constructor(readonly symbol: string) {}

  submit(req: OrderRequest): ExecutionReport {
    const invalid = this.validate(req);
    if (invalid) return this.reject(req, invalid);

    const tif = req.timeInForce ?? (req.type === "market" ? "IOC" : "GTC");
    const contra = req.side === "buy" ? this.asks : this.bids;
    const limit = req.type === "limit" ? req.price : undefined;

    // Fill-or-kill: check up front that the whole order can trade, else do nothing.
    if (tif === "FOK" && contra.liquidityUpTo(limit, req.quantity) < req.quantity) {
      return { orderId: req.id, status: "cancelled", filledQuantity: 0, remainingQuantity: req.quantity, trades: [], reason: "FOK not fully fillable" };
    }

    const trades = this.match(req, contra, limit);
    const filled = trades.reduce((s, t) => s + t.quantity, 0);
    const remaining = req.quantity - filled;

    if (remaining === 0) {
      return { orderId: req.id, status: "filled", filledQuantity: filled, remainingQuantity: 0, trades };
    }

    // Market and IOC leftovers are cancelled; only GTC limit orders rest on the book.
    if (req.type === "market" || tif === "IOC") {
      return { orderId: req.id, status: "cancelled", filledQuantity: filled, remainingQuantity: remaining, trades, reason: filled ? "unfilled remainder cancelled" : "no liquidity" };
    }

    this.rest(req, remaining);
    return {
      orderId: req.id,
      status: filled > 0 ? "partially_filled" : "resting",
      filledQuantity: filled,
      remainingQuantity: remaining,
      trades,
    };
  }

  cancel(orderId: string): boolean {
    const order = this.ordersById.get(orderId);
    if (!order) return false;
    const side = order.side === "buy" ? this.bids : this.asks;
    const level = side.get(order.price);
    if (!level) return false;
    level.cancel(order);
    side.removeIfEmpty(level);
    this.ordersById.delete(orderId);
    return true;
  }

  bestBid(): number | undefined {
    return this.bids.best()?.price;
  }

  bestAsk(): number | undefined {
    return this.asks.best()?.price;
  }

  spread(): number | undefined {
    const bid = this.bestBid();
    const ask = this.bestAsk();
    return bid === undefined || ask === undefined ? undefined : ask - bid;
  }

  snapshot(depth = 10): BookSnapshot {
    const toLevels = (side: BookSide) =>
      side.levels.slice(0, depth).map((l) => ({ price: l.price, quantity: l.totalQuantity, orders: l.liveOrders }));
    return { bids: toLevels(this.bids), asks: toLevels(this.asks) };
  }

  openOrder(orderId: string): RestingOrder | undefined {
    return this.ordersById.get(orderId);
  }

  private validate(req: OrderRequest): string | undefined {
    if (!req.id) return "missing order id";
    if (this.ordersById.has(req.id)) return "duplicate order id";
    if (!Number.isInteger(req.quantity) || req.quantity <= 0) return "quantity must be a positive integer";
    if (req.type === "limit") {
      if (req.price === undefined || !Number.isInteger(req.price) || req.price <= 0) {
        return "limit orders need a positive integer price";
      }
    } else if (req.price !== undefined) {
      return "market orders must not specify a price";
    }
    if (req.type === "market" && req.timeInForce === "GTC") return "market orders cannot rest (GTC)";
    return undefined;
  }

  private reject(req: OrderRequest, reason: string): ExecutionReport {
    return { orderId: req.id, status: "rejected", filledQuantity: 0, remainingQuantity: req.quantity, trades: [], reason };
  }

  private match(req: OrderRequest, contra: BookSide, limit: number | undefined): Trade[] {
    const trades: Trade[] = [];
    let remaining = req.quantity;

    while (remaining > 0) {
      const level = contra.best();
      if (!level) break;
      // Stop when the best contra price is worse than our limit.
      if (limit !== undefined && (req.side === "buy" ? level.price > limit : level.price < limit)) break;

      const resting = level.peek();
      if (!resting) {
        contra.removeIfEmpty(level);
        continue;
      }

      const qty = Math.min(remaining, resting.remaining);
      const trade: Trade = {
        buyOrderId: req.side === "buy" ? req.id : resting.id,
        sellOrderId: req.side === "sell" ? req.id : resting.id,
        price: level.price, // trades execute at the resting order's price
        quantity: qty,
        aggressor: req.side,
        seq: ++this.tradeSeq,
      };
      trades.push(trade);
      this.tradeLog.push(trade);

      remaining -= qty;
      level.fillHead(qty);
      if (resting.remaining === 0) this.ordersById.delete(resting.id);
      contra.removeIfEmpty(level);
    }
    return trades;
  }

  private rest(req: OrderRequest, remaining: number): void {
    const order: RestingOrder = {
      id: req.id,
      side: req.side,
      price: req.price!,
      remaining,
      original: req.quantity,
      seq: ++this.seq,
      traderId: req.traderId,
    };
    const side = req.side === "buy" ? this.bids : this.asks;
    side.getOrCreate(order.price).push(order);
    this.ordersById.set(order.id, order);
  }
}
