import { AppError } from "../errors";

export const ORDER_STATUSES = ["pending", "paid", "shipped", "delivered", "cancelled"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * The only legal order lifecycle. Paid orders cannot be cancelled here because that would
 * require a refund, which is deliberately out of scope for this API.
 */
const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending: ["paid", "cancelled"],
  paid: ["shipped"],
  shipped: ["delivered"],
  delivered: [],
  cancelled: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) {
    throw new AppError(409, "invalid_transition", `An order cannot move from ${from} to ${to}`);
  }
}
