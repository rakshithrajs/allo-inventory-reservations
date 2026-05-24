import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { releaseExpiredReservations } from "@/lib/releaseExpired";
import { confirm, reserve } from "@/server/services/reservationService";
import { createStockFixture, readStock, purgeTestData } from "./helpers";

describe("reservation expiry sweep", () => {
    afterAll(async () => {
        await purgeTestData();
        await prisma.$disconnect();
    });

    it("releases PENDING reservations whose expiresAt is in the past", async () => {
        const fixture = await createStockFixture(2);
        try {
            const reserved = await reserve({
                productId: fixture.productId,
                warehouseId: fixture.warehouseId,
                quantity: 2,
            });
            const reservationId = (reserved.body as { id: string }).id;

            await prisma.reservation.update({
                where: { id: reservationId },
                data: { expiresAt: new Date(Date.now() - 60_000) },
            });

            const releasedCount = await releaseExpiredReservations();
            expect(releasedCount).toBeGreaterThanOrEqual(1);

            const refreshed = await prisma.reservation.findUniqueOrThrow({
                where: { id: reservationId },
            });
            expect(refreshed.status).toBe("RELEASED");

            const stock = await readStock(fixture.productId, fixture.warehouseId);
            expect(stock.reservedUnits).toBe(0);
            expect(stock.available).toBe(2);
        } finally {
            await fixture.cleanup();
        }
    });

    it("does NOT touch reservations that are still in their expiry window", async () => {
        const fixture = await createStockFixture(2);
        try {
            const reserved = await reserve({
                productId: fixture.productId,
                warehouseId: fixture.warehouseId,
                quantity: 1,
            });
            const reservationId = (reserved.body as { id: string }).id;

            await releaseExpiredReservations();

            const refreshed = await prisma.reservation.findUniqueOrThrow({
                where: { id: reservationId },
            });
            expect(refreshed.status).toBe("PENDING");

            const stock = await readStock(fixture.productId, fixture.warehouseId);
            expect(stock.reservedUnits).toBe(1);
        } finally {
            await fixture.cleanup();
        }
    });

    it("does NOT touch CONFIRMED reservations even if expiresAt is in the past", async () => {
        const fixture = await createStockFixture(2);
        try {
            const reserved = await reserve({
                productId: fixture.productId,
                warehouseId: fixture.warehouseId,
                quantity: 1,
            });
            const reservationId = (reserved.body as { id: string }).id;
            await confirm(reservationId);

            await prisma.reservation.update({
                where: { id: reservationId },
                data: { expiresAt: new Date(Date.now() - 60_000) },
            });

            await releaseExpiredReservations();

            const refreshed = await prisma.reservation.findUniqueOrThrow({
                where: { id: reservationId },
            });
            expect(refreshed.status).toBe("CONFIRMED");

            const stock = await readStock(fixture.productId, fixture.warehouseId);
            expect(stock.totalUnits).toBe(1);
            expect(stock.reservedUnits).toBe(0);
        } finally {
            await fixture.cleanup();
        }
    });
});
