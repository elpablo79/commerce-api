// Errors are built with Yoga's own factory so they are recognised whichever copy of `graphql` is loaded.
import { createGraphQLError, createSchema } from "graphql-yoga";
import { type AuthUser } from "../auth";
import type { Container } from "../container";
import { AppError, unauthorized } from "../errors";

export type GraphQLContext = { user: AuthUser | null };

const typeDefs = /* GraphQL */ `
  enum OrderStatus {
    PENDING
    PAID
    SHIPPED
    DELIVERED
    CANCELLED
  }

  type Product {
    id: ID!
    sku: String!
    name: String!
    description: String!
    priceCents: Int!
    inStock: Boolean!
    "Exact quantity, only returned to admins."
    stock: Int
    active: Boolean!
    createdAt: String!
  }

  type OrderItem {
    productId: ID!
    sku: String!
    name: String!
    unitPriceCents: Int!
    quantity: Int!
  }

  type Order {
    id: ID!
    status: OrderStatus!
    totalCents: Int!
    currency: String!
    items: [OrderItem!]!
    createdAt: String!
    updatedAt: String!
    paidAt: String
    shippedAt: String
    deliveredAt: String
    cancelledAt: String
  }

  type User {
    id: ID!
    email: String!
    role: String!
    createdAt: String!
  }

  type ProductPage {
    data: [Product!]!
    total: Int!
    limit: Int!
    offset: Int!
  }

  type OrderPage {
    data: [Order!]!
    total: Int!
    limit: Int!
    offset: Int!
  }

  type CreateOrderPayload {
    order: Order!
    "Pass this to the payment provider's client library to complete the payment."
    clientSecret: String!
  }

  input OrderItemInput {
    productId: ID!
    quantity: Int!
  }

  type Query {
    products(search: String, limit: Int, offset: Int): ProductPage!
    product(id: ID!): Product
    me: User
    orders(limit: Int, offset: Int, status: OrderStatus): OrderPage!
    order(id: ID!): Order
  }

  type Mutation {
    createOrder(items: [OrderItemInput!]!): CreateOrderPayload!
    cancelOrder(id: ID!): Order!
  }
`;

/** Turns application errors into GraphQL errors with a stable `code`; unexpected ones stay masked. */
async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError) {
      throw createGraphQLError(err.message, { extensions: { code: err.code, details: err.details } });
    }
    throw err;
  }
}

const needUser = (ctx: GraphQLContext): AuthUser => {
  if (!ctx.user) throw unauthorized();
  return ctx.user;
};

const orNull = async <T>(fn: () => Promise<T>): Promise<T | null> => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError && err.code === "not_found") return null;
    throw err;
  }
};

export function createGraphqlSchema({ products, orders, users }: Container) {
  return createSchema<GraphQLContext>({
    typeDefs,
    resolvers: {
      OrderStatus: {
        PENDING: "pending",
        PAID: "paid",
        SHIPPED: "shipped",
        DELIVERED: "delivered",
        CANCELLED: "cancelled",
      },
      Query: {
        products: (_root, args: { search?: string | null; limit?: number | null; offset?: number | null }, ctx) =>
          run(async () => {
            const page = await products.list(ctx.user, {
              search: args.search ?? undefined,
              limit: args.limit ?? undefined,
              offset: args.offset ?? undefined,
            });
            return { data: page.data, ...page.pagination };
          }),
        product: (_root, args: { id: string }, ctx) => run(() => orNull(() => products.get(ctx.user, args.id))),
        me: (_root, _args, ctx) => run(async () => (ctx.user ? users.me(ctx.user.id) : null)),
        orders: (_root, args: { limit?: number | null; offset?: number | null; status?: string | null }, ctx) =>
          run(async () => {
            const page = await orders.list(needUser(ctx), {
              limit: args.limit ?? undefined,
              offset: args.offset ?? undefined,
              status: args.status ?? undefined,
            });
            return { data: page.data, ...page.pagination };
          }),
        order: (_root, args: { id: string }, ctx) =>
          run(() => orNull(() => orders.get(needUser(ctx), args.id))),
      },
      Mutation: {
        createOrder: (_root, args: { items: { productId: string; quantity: number }[] }, ctx) =>
          run(() => orders.create(needUser(ctx), { items: args.items })),
        cancelOrder: (_root, args: { id: string }, ctx) => run(() => orders.cancel(needUser(ctx), args.id)),
      },
    },
  });
}
