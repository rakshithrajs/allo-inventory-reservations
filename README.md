# Allo Stock Manager

A multi-warehouse inventory and reservation API + UI for the Allo Engineering take-home. Built on **Next.js 16 (App Router)**, **TypeScript**, **Prisma 7**, **Postgres (Neon)**, **Upstash Redis**, **Upstash QStash**, **Zod**, **Tailwind**, and **shadcn/ui**.

## What it does

When a customer clicks **Reserve**, the system holds a unit for 10 minutes. If they confirm in time, the unit is permanently decremented from stock. If they cancel or the timer runs out, the unit returns to the pool. The reservation flow is the core of the app and is hardened against the classic checkout race condition.

## Quick demo

1. Home page lists products with available stock per warehouse.
2. Click **Reserve 1** → you land on `/reservations/<id>` with a live 10-minute countdown.
3. **Confirm purchase** → permanently consumes 1 unit; the home page updates without a manual refresh.
4. **Cancel** → releases the unit immediately.
5. Idle for 10 minutes → the unit returns to the pool via the QStash schedule (or the next product-list read, whichever happens first).

## Local setup

Requires Node 20+. Postgres is hosted (Neon free tier); Redis and QStash are hosted (Upstash free tier).

```bash
# 1. install (postinstall runs prisma generate automatically)
npm install

# 2. env
cp .env.example .env
# fill in DATABASE_URL (Neon) + UPSTASH_REDIS_REST_* (Upstash)
# QStash vars are only required in production; locally use CRON_SECRET instead.

# 3. database
npx prisma migrate deploy
npx prisma db seed   # 3 products × 2 warehouses, 10 units each

# 4. run
npm run dev
# http://localhost:3000
```

To trigger the expiry job locally:

```bash
curl -X POST http://localhost:3000/api/cron/release-expired \
  -H "Authorization: Bearer $CRON_SECRET"
```

### Env vars

| Variable                     | Required           | Purpose                                                                                                                |
| ---------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`               | yes                | Neon Postgres connection string (pooled URL works; supports session-mode pgbouncer so migrations run through it)       |
| `UPSTASH_REDIS_REST_URL`     | yes                | Upstash REST endpoint (distributed lock + idempotency cache)                                                           |
| `UPSTASH_REDIS_REST_TOKEN`   | yes                | Upstash REST token                                                                                                     |
| `QSTASH_CURRENT_SIGNING_KEY` | prod               | Verifies incoming QStash cron deliveries. Production must set this.                                                    |
| `QSTASH_NEXT_SIGNING_KEY`    | prod               | Companion key for QStash key rotation.                                                                                 |
| `CRON_SECRET`                | local              | Bearer token for manually hitting `/api/cron/release-expired` in dev. Ignored when `QSTASH_CURRENT_SIGNING_KEY` is set.|

## Architecture

```text
app/
  api/
    products/                  GET — list products + per-warehouse available stock
    warehouses/                GET — list warehouses
    reservations/              POST — create reservation (with optional Idempotency-Key)
    reservations/[id]/         GET — fetch one reservation
    reservations/[id]/confirm  POST — confirm (idempotent)
    reservations/[id]/release  POST — release (idempotent)
    cron/release-expired       POST — QStash-triggered expiry sweep (signature-verified)
  reservations/[id]/page.tsx   Client component with countdown, confirm/cancel
  page.tsx                     Server component — calls productService directly, no HTTP hop
components/ui/                 shadcn primitives (Button, Card, Badge, Sonner)
components/ReserveButton.tsx
lib/
  prisma.ts                    Prisma client singleton with PrismaPg driver adapter
  redis.ts                     Upstash client
  withLock.ts                  Distributed lock with exponential-backoff retry
  releaseExpired.ts            Conditional release of expired reservations (race-safe)
  indempotency.ts              Idempotency-Key middleware
server/
  http/errors.ts               ApiError class + apiError/handleApiError/toServiceResult
  services/productService.ts   listProductsWithStock — shared by route + page
  services/reservationService.ts  reserve/confirm/release business logic
  validators/reservation.ts    Zod schema for POST body
  types/reservation.ts         Shared API↔UI types
prisma/
  schema.prisma                Product, Warehouse, Stock, Reservation, IdempotencyKey
  migrations/                  Generated SQL
  seed.ts                      3 products × 2 warehouses × 10 units
```

**Layering.** Routes are thin (parse → service → format response). Services own business logic, transactions, and lock acquisition. The home page is a Server Component that calls the same service the API route uses, so there's no internal HTTP hop. A repository layer was *not* introduced — query duplication didn't justify one yet.

## Concurrency strategy

This is where the assignment lives. The reservation endpoint must guarantee that for `N` available units, exactly `N` concurrent reservers succeed and the rest get 409. Two layers cooperate:

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

Two layers, same helper (`releaseExpiredReservations`):

- **Lazy cleanup on read.** Every call to `listProductsWithStock()` (used by `GET /api/products` and the home page) sweeps expired-but-pending reservations first. Anyone browsing implicitly drains the queue, so users see fresh stock immediately without waiting for a scheduler.
- **Upstash QStash schedule.** A QStash cron POSTs to `/api/cron/release-expired` every 2 minutes as a backstop for low-traffic periods. The endpoint verifies the `Upstash-Signature` header via `@upstash/qstash`'s `Receiver`. Locally, the same endpoint accepts a `Bearer ${CRON_SECRET}` for manual testing when QStash keys aren't configured.

The sweep itself is race-safe. For each candidate reservation we run a per-row transaction containing a conditional `updateMany`:

```ts
const { count } = await tx.reservation.updateMany({
  where: { id, status: "PENDING", expiresAt: { lt: new Date() } },
  data: { status: "RELEASED" },
});
if (count === 0) return; // a concurrent confirm() won — skip the stock decrement
```

Without the `status: "PENDING"` re-check, a confirm() that races between `findMany` and update would have its CONFIRMED row clobbered to RELEASED and the stock decrement applied twice. Per-row transactions also keep lock duration short so one stuck row can't block the rest of the batch.

### Why QStash, not Vercel Cron

Vercel's Hobby plan caps cron at one execution per day. A 2-minute schedule needs an external trigger. QStash's free tier allows 1,000 messages/day; a 2-minute schedule consumes 720/day, well within budget. Worst-case expiry-to-release latency is ~2 minutes, which is invisible against a 10-minute reservation window — and lazy cleanup on read shortens it further whenever anyone hits the home page.

## Idempotency (bonus)

Implemented for `POST /api/reservations` and `POST /api/reservations/:id/confirm`.

If the client sends an `Idempotency-Key` header, the server:

1. Hashes the endpoint + canonical request body.
2. Looks up `(key, endpoint)` in the `IdempotencyKey` table.
3. If the same key + body has been seen → returns the original response verbatim, no side effect.
4. If the same key but a different body → returns 422 `IDEMPOTENCY_MISMATCH` (prevents a client from reusing a key for a different intent).
5. Otherwise → runs the handler, stores the response, returns it.

Persisting via Postgres (rather than Redis) gives a permanent audit trail and survives Redis evictions. Zod validation happens before the idempotency wrapper, so a bad payload doesn't burn an idempotency slot.

## API reference

All errors return:

```json
{ "error": { "code": "CODE_NAME", "message": "Human-readable" } }
```

Codes: `INVALID_INPUT` (400), `UNAUTHORIZED` (401), `NOT_FOUND` (404), `INSUFFICIENT_STOCK` (409), `LOCK_CONTENTION` (409), `CANNOT_RELEASE_CONFIRMED` (409), `ALREADY_RELEASED` (409), `RESERVATION_EXPIRED` (410), `IDEMPOTENCY_MISMATCH` (422), `INTERNAL_ERROR` (500).

| Method | Path                            | Body                                 | Success             | Errors        |
| ------ | ------------------------------- | ------------------------------------ | ------------------- | ------------- |
| GET    | `/api/products`                 | —                                    | `200 [Product[]]`   | —             |
| GET    | `/api/warehouses`               | —                                    | `200 [Warehouse[]]` | —             |
| POST   | `/api/reservations`             | `{productId, warehouseId, quantity}` | `201 Reservation`   | 400, 404, 409 |
| GET    | `/api/reservations/:id`         | —                                    | `200 Reservation`   | 404           |
| POST   | `/api/reservations/:id/confirm` | —                                    | `200 Reservation`   | 404, 409, 410 |
| POST   | `/api/reservations/:id/release` | —                                    | `200 Reservation`   | 404, 409      |
| POST   | `/api/cron/release-expired`     | —                                    | `200 {released: N}` | 401           |

## Tradeoffs and "with more time"

- **No repository layer.** Stock and Reservation queries live inside the services. With more code, I'd extract `server/repositories/*` to keep Prisma calls out of business logic.
- **No automated concurrency test suite.** I verified by manual `xargs -P 30` stress runs (Vitest covers idempotency + happy paths). With more time: a spec that spawns `Promise.all(50)` of reserve calls against a fixed inventory and asserts the exact success count, plus a test for the expiry-vs-confirm race that motivated the conditional `updateMany`.
- **No auth on the app itself.** Single-tenant demo — no user accounts, no per-user reservation ownership. The cron endpoint *is* signature-verified.
- **No rate limiting** beyond the Redis lock's natural single-flight effect.
- **2-minute expiry cadence.** Constrained by QStash's free-tier 1,000-messages/day cap. Pay-as-you-go ($1 per 100K) would allow per-minute. Lazy cleanup masks the cadence for any user who hits the home page.
- **Redis lock is debatable.** Postgres `FOR UPDATE` alone gives the correctness guarantee. The Redis layer reduces wasted DB work under heavy contention but adds Upstash latency. Left in to demonstrate distributed-systems thinking, but a pure-Postgres setup would be equally correct and simpler to operate.

## Deploy (Vercel + Neon + Upstash)

1. Push to GitHub.
2. **Neon** — create a Postgres project, copy the connection string. Run `DATABASE_URL=<prod_url> npx prisma migrate deploy && npx prisma db seed` from your machine to provision the schema and seed data.
3. **Upstash Redis** — create a Redis database, copy `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.
4. **Upstash QStash** — copy `QSTASH_CURRENT_SIGNING_KEY` and `QSTASH_NEXT_SIGNING_KEY` from the QStash console (these are separate from QStash's publish token; only the signing keys are needed by this app).
5. **Vercel** — Import the GitHub repo. Add `DATABASE_URL`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY` to **Production** env vars. Deploy.
6. **QStash schedule** — in the QStash console → Schedules → New:
   - Destination: `https://<your-vercel-app>.vercel.app/api/cron/release-expired`
   - Method: `POST`
   - Cron: `*/2 * * * *`

The `postinstall: prisma generate` script in [package.json](package.json) ensures the typed client is regenerated on every Vercel build (since `app/generated/prisma` is gitignored).

## Engineering notes

- Prisma 7's new `provider = "prisma-client"` generator emits the client to a user-chosen folder (`app/generated/prisma`) and requires a driver adapter (`@prisma/adapter-pg` for Postgres). `directUrl` no longer exists in `schema.prisma`; CLI connection config moved to `prisma.config.ts`.
- Next.js 16 makes `ctx.params` in route handlers a `Promise` — always `await ctx.params`.
- Zod v4 deprecated `message` in favor of `error` for custom error text.
