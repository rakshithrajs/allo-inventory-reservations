import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { reserve } from "@/server/services/reservationService";
import { createStockFixture, readStock, purgeTestData } from "./helpers";

describe("reservation concurrency", () => {
    afterAll(async () => {
        await purgeTestData();
        await prisma.$disconnect();
    });

    it("exactly one of N concurrent reservers wins the last unit", async () => {
        const fixture = await createStockFixture(1);
        try {
            const N = 8;
            const results = await Promise.all(
                Array.from({ length: N }, () =>
                    reserve({
                        productId: fixture.productId,
                        warehouseId: fixture.warehouseId,
                        quantity: 1,
                    }),
                ),
            );

            const winners = results.filter((r) => r.status === 201);
            const losers = results.filter((r) => r.status !== 201);

            expect(winners).toHaveLength(1);
            expect(losers).toHaveLength(N - 1);

            // Losers must surface a real business-level rejection — either the
            // stock was gone (INSUFFICIENT_STOCK) or the redis lock queue gave
            // up (LOCK_CONTENTION). Anything else is a bug.
            for (const loser of losers) {
                expect(loser.status).toBe(409);
                const body = loser.body as { error: { code: string } };
                expect(["INSUFFICIENT_STOCK", "LOCK_CONTENTION"]).toContain(
                    body.error.code,
                );
            }

            const stock = await readStock(fixture.productId, fixture.warehouseId);
            expect(stock.totalUnits).toBe(1);
            expect(stock.reservedUnits).toBe(1);
            expect(stock.available).toBe(0);
        } finally {
            await fixture.cleanup();
        }
    });

    it("never oversells when concurrent requests sum to more than available stock", async () => {
        const fixture = await createStockFixture(5);
        try {
            // 10 concurrent reservers each asking for 1 unit against 5 units of
            // stock — exactly 5 should succeed and the remaining 5 should fail.
            const N = 10;
            const results = await Promise.all(
                Array.from({ length: N }, () =>
                    reserve({
                        productId: fixture.productId,
                        warehouseId: fixture.warehouseId,
                        quantity: 1,
                    }),
                ),
            );

            const winners = results.filter((r) => r.status === 201);
            const losers = results.filter((r) => r.status !== 201);

            expect(winners).toHaveLength(5);
            expect(losers).toHaveLength(5);

            const stock = await readStock(fixture.productId, fixture.warehouseId);
            expect(stock.totalUnits).toBe(5);
            expect(stock.reservedUnits).toBe(5);
            expect(stock.available).toBe(0);
        } finally {
            await fixture.cleanup();
        }
    });

    it("rejects all when each request asks for more than total stock", async () => {
        const fixture = await createStockFixture(2);
        try {
            const N = 4;
            const results = await Promise.all(
                Array.from({ length: N }, () =>
                    reserve({
                        productId: fixture.productId,
                        warehouseId: fixture.warehouseId,
                        quantity: 3,
                    }),
                ),
            );

            for (const result of results) {
                expect(result.status).toBe(409);
            }

            const stock = await readStock(fixture.productId, fixture.warehouseId);
            expect(stock.reservedUnits).toBe(0);
        } finally {
            await fixture.cleanup();
        }
    });
});
