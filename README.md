# Allo Stock Manager

A multi-warehouse inventory and reservation API + UI for the Allo Engineering take-home. Built on **Next.js 16 (App Router)**, **TypeScript**, **Prisma 7**, **Postgres (Neon)**, **Upstash Redis**, **Zod**, **Tailwind**, and **shadcn/ui**.

## What it does

When a customer clicks **Reserve**, the system holds a unit for 10 minutes. If they confirm in time, the unit is permanently decremented from stock. If they cancel or the timer runs out, the unit returns to the pool. The reservation flow is the core of the app and is hardened against the classic checkout race condition.

## Quick demo

1. Home page lists products with available stock per warehouse.
2. Click **Reserve 1** → you land on `/reservations/<id>` with a live 10-minute countdown.
3. **Confirm purchase** → permanently consumes 1 unit; the home page updates without a manual refresh.
4. **Cancel** → releases the unit immediately.
5. Idle for 10 minutes → the unit returns to the pool via the cron job (or the next product-list read, whichever happens first).

## Local setup

Requires Node 20+. Postgres is hosted (Neon free tier); Redis is hosted (Upstash free tier).

```bash
# 1. install
npm install

# 2. env
cp .env.example .env
# fill in DATABASE_URL (Neon) + UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
# (NEXT_PUBLIC_BASE_URL is only needed if running on a non-default origin)

# 3. database
npx prisma migrate deploy
npx prisma db seed   # 3 products × 2 warehouses, 10 units each

# 4. run
npm run dev
# http://localhost:3000
```

`npx prisma generate` is run automatically on `npm install` (via `postinstall`) so the typed client is always present.

### Env vars

| Variable                   | Required | Purpose                                                                                                                       |
| -------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`             | yes      | Neon Postgres connection string (their pooled URL is fine — supports session-mode pgbouncer, so migrations work through it)   |
| `UPSTASH_REDIS_REST_URL`   | yes      | Upstash REST endpoint                                                                                                         |
| `UPSTASH_REDIS_REST_TOKEN` | yes      | Upstash REST token                                                                                                            |
| `NEXT_PUBLIC_BASE_URL`     | optional | Used by the Server Component product list to fetch `/api/products` on the server side. Defaults to `http://localhost:3000`.   |

## Architecture

```text
app/
  api/
    products/            GET — list products + per-warehouse available stock
    warehouses/          GET — list warehouses
    reservations/        POST — create reservation (with optional Idempotency-Key)
    reservations/[id]/   GET — fetch one reservation
    reservations/[id]/confirm  POST — confirm (idempotent)
    reservations/[id]/release  POST — release (idempotent)
    cron/release-expired GET — Vercel Cron backstop (every 60s)
  reservations/[id]/page.tsx   Client component with countdown, confirm/cancel
  page.tsx               Server component — product list with shadcn primitives
components/ui/           shadcn primitives (Button, Card, Badge, Sonner)
components/ReserveButton.tsx
lib/
  prisma.ts              Prisma client singleton with PrismaPg driver adapter
  redis.ts               Upstash client
  withLock.ts            Distributed lock with exponential-backoff retry
  releaseExpired.ts      Lazy cleanup helper (also used by cron)
  indempotency.ts        Idempotency-Key middleware
server/
  http/errors.ts         ApiError class + apiError/handleApiError/toServiceResult
  services/reservationService.ts   reserve/confirm/release business logic
  validators/reservation.ts        Zod schema for POST body
  types/reservation.ts             Shared API↔UI types
prisma/
  schema.prisma          Product, Warehouse, Stock, Reservation, IdempotencyKey
  migrations/            Generated SQL
  seed.ts                3 products × 2 warehouses × 10 units
```

**Layering**: Routes are thin (parse → service → format response). Services own business logic, transactions, and lock acquisition. Repository layer was *not* introduced — duplication didn't justify it yet.

## Concurrency strategy

This is where the assignment lives. The reservation endpoint must guarantee that for `N` available units, exactly `N` concurrent reservers succeed and the rest get 409. We use **two layers**:

### 1. Postgres `SELECT ... FOR UPDATE` (the actual correctness guarantee)

Inside a `Serializable` transaction, we lock the `Stock` row for `(productId, warehouseId)`:

```sql
SELECT "totalUnits", "reservedUnits"
FROM "Stock"
WHERE "productId" = $1 AND "warehouseId" = $2
FOR UPDATE
```

Concurrent reservers on the same SKU serialise on this row lock. Postgres queues them natively. No overselling, no negative stock, no double confirmation — guaranteed by the database.

### 2. Upstash Redis NX lock (belt-and-braces)

Before opening the transaction, we acquire a `SET key value NX PX 5000` lock keyed by `stock:{productId}:{warehouseId}`. Contenders retry with exponential backoff + jitter for up to 1.5s before bailing with `LOCK_CONTENTION` (409). This:

- Prevents two API instances from even starting parallel txns on the same SKU (cheaper than racing inside Postgres).
- Reduces wasted work under heavy contention.
- Is **not** the correctness guarantee — drop it and `FOR UPDATE` is still bulletproof. Verified by stress test: 30 parallel reserves on 8 in stock → exactly 8 succeeded, 22 rejected (mix of `INSUFFICIENT_STOCK` and `LOCK_CONTENTION`).

### Confirm and release

Both are transactional. Confirm checks expiry (`expiresAt < now` → 410) and pending status, then atomically decrements `totalUnits` and `reservedUnits`. Release checks status (CONFIRMED → 409 with `CANNOT_RELEASE_CONFIRMED`) and returns `reservedUnits` to the pool. Both are idempotent on already-final states (re-confirming a CONFIRMED reservation returns the existing record, not an error).

## Reservation expiry

Two layers, same helper:

- **Lazy cleanup on read.** Every call to `GET /api/products` runs `releaseExpiredReservations()` first. This means anyone hitting the home page implicitly drains the expired-reservation queue — users see fresh stock immediately, no waiting on a scheduled job.
- **Vercel Cron backstop.** `vercel.json` schedules `GET /api/cron/release-expired` every 60 seconds. For low-traffic periods (no one browsing) this still releases held stock so it doesn't pile up.

The cron endpoint is unauthenticated by design (see Tradeoffs). The helper is idempotent — re-releasing an already-RELEASED reservation is a no-op.

## Idempotency (bonus)

Implemented for `POST /api/reservations` and `POST /api/reservations/:id/confirm`.

If the client sends an `Idempotency-Key` header, the server:

1. Hashes the endpoint + canonical request body.
2. Looks up `(key, endpoint)` in the `IdempotencyKey` table.
3. If the same key + body has been seen → returns the original response verbatim, no side effect.
4. If the same key but a different body → returns 422 `IDEMPOTENCY_MISMATCH` (prevents a client from reusing a key for a different intent).
5. Otherwise → runs the handler, stores the response, returns it.

Persisting via Postgres (rather than Redis) gives us a permanent audit trail and survives Redis evictions. Zod validation happens before the idempotency wrapper, so a bad payload doesn't burn an idempotency slot.

## API reference

All errors return:

```json
{ "error": { "code": "CODE_NAME", "message": "Human-readable" } }
```

Codes: `INVALID_INPUT` (400), `NOT_FOUND` (404), `INSUFFICIENT_STOCK` (409), `LOCK_CONTENTION` (409), `CANNOT_RELEASE_CONFIRMED` (409), `ALREADY_RELEASED` (409), `RESERVATION_EXPIRED` (410), `IDEMPOTENCY_MISMATCH` (422), `INTERNAL_ERROR` (500).

| Method | Path                            | Body                                 | Success             | Errors        |
| ------ | ------------------------------- | ------------------------------------ | ------------------- | ------------- |
| GET    | `/api/products`                 | —                                    | `200 [Product[]]`   | —             |
| GET    | `/api/warehouses`               | —                                    | `200 [Warehouse[]]` | —             |
| POST   | `/api/reservations`             | `{productId, warehouseId, quantity}` | `201 Reservation`   | 400, 404, 409 |
| GET    | `/api/reservations/:id`         | —                                    | `200 Reservation`   | 404           |
| POST   | `/api/reservations/:id/confirm` | —                                    | `200 Reservation`   | 404, 409, 410 |
| POST   | `/api/reservations/:id/release` | —                                    | `200 Reservation`   | 404, 409      |
| GET    | `/api/cron/release-expired`     | —                                    | `200 {released: N}` | —             |

## Tradeoffs and "with more time"

- **No repository layer.** Stock and Reservation queries live inside `reservationService.ts`. With more code, I'd extract `server/repositories/*` to keep Prisma calls out of the service.
- **No automated concurrency test suite.** I verified by manual `xargs -P 30` stress runs. With more time: a Vitest spec that spawns `Promise.all(50)` of reserve calls against a fixed inventory and asserts the exact success count.
- **Cron endpoint is public.** Per the assignment's "we're not looking for a perfect production system" guidance, I left `/api/cron/release-expired` unauthenticated. The job is idempotent so abuse is harmless (extra DB load only). In production I'd verify Vercel's `x-vercel-cron-signature` header.
- **No auth.** The whole app is single-tenant demo; no user accounts, no per-user reservation ownership.
- **No rate limiting** beyond the Redis lock's natural single-flight effect.
- **Server-Component fetch loop.** `app/page.tsx` does `fetch(NEXT_PUBLIC_BASE_URL + "/api/products")` from a Server Component, which is a self-HTTP roundtrip. With more time I'd call the Prisma query directly to skip the extra hop.
- **Redis lock is debatable.** Postgres `FOR UPDATE` alone gives the correctness guarantee. The Redis layer reduces wasted DB work under heavy contention but adds Upstash latency. Left in to demonstrate distributed-systems thinking, but a pure-Postgres setup would be equally correct and simpler to operate.

## Deploy (Vercel + Neon + Upstash)

1. Push to GitHub.
2. **Neon** — create a Postgres project, copy the connection string. Run `DATABASE_URL=<prod_url> npx prisma migrate deploy && npx prisma db seed` from your machine to provision the schema and seed data.
3. **Upstash** — create a Redis database, copy `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.
4. **Vercel** — Add the project, paste all four env vars (`DATABASE_URL`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, plus optionally `NEXT_PUBLIC_BASE_URL=https://<your-vercel-domain>`), deploy.
5. The `vercel.json` cron schedule is picked up automatically.

The `postinstall: prisma generate` script in [package.json](package.json) ensures the typed client is regenerated on every Vercel build (since `app/generated/prisma` is gitignored).

## Engineering notes

- Prisma 7's new `provider = "prisma-client"` generator emits the client to a user-chosen folder (`app/generated/prisma`) and requires a driver adapter (`@prisma/adapter-pg` for Postgres). `directUrl` no longer exists in `schema.prisma`; CLI connection config moved to `prisma.config.ts`.
- Next.js 16 makes `ctx.params` in route handlers a `Promise` — always `await ctx.params`.
- Zod v4 deprecated `message` in favor of `error` for custom error text.
