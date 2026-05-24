import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import {
    confirm,
    release,
    reserve,
} from "@/server/services/reservationService";
import { createStockFixture, readStock, purgeTestData } from "./helpers";

describe("reservation service", () => {
    let fixture: Awaited<ReturnType<typeof createStockFixture>>;

    beforeEach(async () => {
        fixture = await createStockFixture(3);
    });

    afterEach(async () => {
        await fixture.cleanup();
    });

    afterAll(async () => {
        await purgeTestData();
        await prisma.$disconnect();
    });

    describe("reserve()", () => {
        it("reserves available units and returns 201 with a PENDING reservation", async () => {
            const result = await reserve({
                productId: fixture.productId,
                warehouseId: fixture.warehouseId,
                quantity: 2,
            });

            expect(result.status).toBe(201);
            const body = result.body as { id: string; status: string; quantity: number };
            expect(body.status).toBe("PENDING");
            expect(body.quantity).toBe(2);

            const stock = await readStock(fixture.productId, fixture.warehouseId);
            expect(stock.reservedUnits).toBe(2);
            expect(stock.available).toBe(1);
        });

        it("returns 409 INSUFFICIENT_STOCK when requested quantity exceeds availability", async () => {
            const result = await reserve({
                productId: fixture.productId,
                warehouseId: fixture.warehouseId,
                quantity: 4,
            });

            expect(result.status).toBe(409);
            expect(result.body).toMatchObject({
                error: { code: "INSUFFICIENT_STOCK" },
            });

            const stock = await readStock(fixture.productId, fixture.warehouseId);
            expect(stock.reservedUnits).toBe(0);
        });

        it("returns 404 NOT_FOUND when the (product, warehouse) stock row does not exist", async () => {
            const result = await reserve({
                productId: "no-such-product",
                warehouseId: fixture.warehouseId,
                quantity: 1,
            });
            expect(result.status).toBe(404);
            expect(result.body).toMatchObject({ error: { code: "NOT_FOUND" } });
        });
    });

    describe("confirm()", () => {
        it("decrements totalUnits and reservedUnits, marks reservation CONFIRMED", async () => {
            const reserved = await reserve({
                productId: fixture.productId,
                warehouseId: fixture.warehouseId,
                quantity: 2,
            });
            const reservationId = (reserved.body as { id: string }).id;

            const result = await confirm(reservationId);
            expect(result.status).toBe(200);
            expect((result.body as { status: string }).status).toBe("CONFIRMED");

            const stock = await readStock(fixture.productId, fixture.warehouseId);
            expect(stock.totalUnits).toBe(1);
            expect(stock.reservedUnits).toBe(0);
            expect(stock.available).toBe(1);
        });

        it("is idempotent on a second confirm — does not double-decrement stock", async () => {
            const reserved = await reserve({
                productId: fixture.productId,
                warehouseId: fixture.warehouseId,
                quantity: 1,
            });
            const reservationId = (reserved.body as { id: string }).id;

            await confirm(reservationId);
            const second = await confirm(reservationId);
            expect(second.status).toBe(200);

            const stock = await readStock(fixture.productId, fixture.warehouseId);
            expect(stock.totalUnits).toBe(2);
            expect(stock.reservedUnits).toBe(0);
        });

        it("returns 410 RESERVATION_EXPIRED when confirming after expiresAt", async () => {
            const reserved = await reserve({
                productId: fixture.productId,
                warehouseId: fixture.warehouseId,
                quantity: 1,
            });
            const reservationId = (reserved.body as { id: string }).id;

            await prisma.reservation.update({
                where: { id: reservationId },
                data: { expiresAt: new Date(Date.now() - 1000) },
            });

            const result = await confirm(reservationId);
            expect(result.status).toBe(410);
            expect(result.body).toMatchObject({
                error: { code: "RESERVATION_EXPIRED" },
            });
        });

        it("returns 409 when confirming a reservation that was released", async () => {
            const reserved = await reserve({
                productId: fixture.productId,
                warehouseId: fixture.warehouseId,
                quantity: 1,
            });
            const reservationId = (reserved.body as { id: string }).id;
            await release(reservationId);

            const result = await confirm(reservationId);
            expect(result.status).toBe(409);
            expect(result.body).toMatchObject({
                error: { code: "ALREADY_RELEASED" },
            });
        });

        it("returns 404 when the reservation does not exist", async () => {
            const result = await confirm("does-not-exist");
            expect(result.status).toBe(404);
            expect(result.body).toMatchObject({ error: { code: "NOT_FOUND" } });
        });
    });

    describe("release()", () => {
        it("releases a PENDING reservation and returns the units to availability", async () => {
            const reserved = await reserve({
                productId: fixture.productId,
                warehouseId: fixture.warehouseId,
                quantity: 2,
            });
            const reservationId = (reserved.body as { id: string }).id;

            const result = await release(reservationId);
            expect(result.status).toBe(200);
            expect((result.body as { status: string }).status).toBe("RELEASED");

            const stock = await readStock(fixture.productId, fixture.warehouseId);
            expect(stock.totalUnits).toBe(3);
            expect(stock.reservedUnits).toBe(0);
            expect(stock.available).toBe(3);
        });

        it("returns 409 CANNOT_RELEASE_CONFIRMED on a confirmed reservation", async () => {
            const reserved = await reserve({
                productId: fixture.productId,
                warehouseId: fixture.warehouseId,
                quantity: 1,
            });
            const reservationId = (reserved.body as { id: string }).id;
            await confirm(reservationId);

            const result = await release(reservationId);
            expect(result.status).toBe(409);
            expect(result.body).toMatchObject({
                error: { code: "CANNOT_RELEASE_CONFIRMED" },
            });
        });

        it("is idempotent on a second release — does not double-decrement reservedUnits", async () => {
            const reserved = await reserve({
                productId: fixture.productId,
                warehouseId: fixture.warehouseId,
                quantity: 1,
            });
            const reservationId = (reserved.body as { id: string }).id;

            await release(reservationId);
            const second = await release(reservationId);
            expect(second.status).toBe(200);

            const stock = await readStock(fixture.productId, fixture.warehouseId);
            expect(stock.reservedUnits).toBe(0);
            expect(stock.totalUnits).toBe(3);
        });

        it("returns 404 when the reservation does not exist", async () => {
            const result = await release("does-not-exist");
            expect(result.status).toBe(404);
            expect(result.body).toMatchObject({ error: { code: "NOT_FOUND" } });
        });
    });
});
