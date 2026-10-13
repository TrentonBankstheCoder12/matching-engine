export type Side = "buy" | "sell";
export type OrderType = "limit" | "market";
export type TimeInForce = "GTC" | "IOC" | "FOK";

/**
 * Prices are integer ticks (e.g. cents) and quantities are integer lots.
 * Using integers keeps price comparisons exact; floating-point prices
 * like 100.1 can compare unequal to themselves after arithmetic.
 */
export interface OrderRequest {
  id: string;
  side: Side;
  type: OrderType;
  quantity: number;
  price?: number; // required for limit orders
  timeInForce?: TimeInForce; // defaults to GTC for limit, IOC for market
  traderId?: string;
}

export interface RestingOrder {
  id: string;
  side: Side;
  price: number;
  remaining: number;
  original: number;
  seq: number; // arrival sequence number, used for time priority
  traderId?: string;
}

export interface Trade {
  buyOrderId: string;
  sellOrderId: string;
  price: number;
  quantity: number;
  aggressor: Side;
  seq: number;
}

export type OrderStatus = "filled" | "partially_filled" | "resting" | "cancelled" | "rejected";

export interface ExecutionReport {
  orderId: string;
  status: OrderStatus;
  filledQuantity: number;
  remainingQuantity: number;
  trades: Trade[];
  reason?: string;
}

export interface Level {
  price: number;
  quantity: number;
  orders: number;
}

export interface BookSnapshot {
  bids: Level[];
  asks: Level[];
}
