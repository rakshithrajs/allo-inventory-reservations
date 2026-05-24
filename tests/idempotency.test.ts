import { randomUUID } from "crypto";
import { NextRequest } from "next/server";
import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { POST as reservePost } from "@/app/api/reservations/route";
import { createStockFixture, readStock, purgeTestData } from "./helpers";

function buildReserveRequest(
    body: unknown,
    idempotencyKey?: string,
): NextRequest {
    const headers: Record<string, string> = {
        "content-type": "application/json",
    };
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;

    return new NextRequest("http://localhost:3000/api/reservations", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
    });
}

describe("Idempotency-Key on POST /api/reservations", () => {
    afterAll(async () => {
        await prisma.idempotencyKey.deleteMany({
            where: { endpoint: "reservations:create" },
        });
        await purgeTestData();
        await prisma.$disconnect();
    });

    it("returns the cached response on a retry with the same key + body", async () => {
        const fixture = await createStockFixture(5);
        const key = randomUUID();
        try {
            const body = {
                productId: fixture.productId,
                warehouseId: fixture.warehouseId,
                quantity: 2,
            };

            const first = await reservePost(buildReserveRequest(body, key));
            expect(first.status).toBe(201);
            const firstJson = (await first.json()) as { id: string };

            const second = await reservePost(buildReserveRequest(body, key));
            expect(second.status).toBe(201);
            const secondJson = (await second.json()) as { id: string };

            // The second call must replay the cached response, not create a
            // new reservation — same id, no extra reserved units.
            expect(secondJson.id).toBe(firstJson.id);

            const stock = await readStock(fixture.productId, fixture.warehouseId);
            expect(stock.reservedUnits).toBe(2);

            const reservationsForProduct = await prisma.reservation.count({
                where: { productId: fixture.productId },
            });
            expect(reservationsForProduct).toBe(1);
        } finally {
            await prisma.idempotencyKey.deleteMany({ where: { key } });
            await fixture.cleanup();
        }
    });

    it("returns 422 IDEMPOTENCY_MISMATCH when the same key is reused with a different body", async () => {
        const fixture = await createStockFixture(5);
        const key = randomUUID();
        try {
            const first = await reservePost(
                buildReserveRequest(
                    {
                        productId: fixture.productId,
                        warehouseId: fixture.warehouseId,
                        quantity: 1,
                    },
                    key,
                ),
            );
            expect(first.status).toBe(201);

            const second = await reservePost(
                buildReserveRequest(
                    {
                        productId: fixture.productId,
                        warehouseId: fixture.warehouseId,
                        quantity: 2,
                    },
                    key,
                ),
            );
            expect(second.status).toBe(422);
            const secondJson = (await second.json()) as {
                error: { code: string };
            };
            expect(secondJson.error.code).toBe("IDEMPOTENCY_MISMATCH");
        } finally {
            await prisma.idempotencyKey.deleteMany({ where: { key } });
            await fixture.cleanup();
        }
    });

    it("treats a request without an Idempotency-Key as a normal one-shot reservation", async () => {
        const fixture = await createStockFixture(3);
        try {
            const body = {
                productId: fixture.productId,
                warehouseId: fixture.warehouseId,
                quantity: 1,
            };
            const first = await reservePost(buildReserveRequest(body));
            const second = await reservePost(buildReserveRequest(body));

            expect(first.status).toBe(201);
            expect(second.status).toBe(201);

            const firstJson = (await first.json()) as { id: string };
            const secondJson = (await second.json()) as { id: string };
            expect(secondJson.id).not.toBe(firstJson.id);

            const stock = await readStock(fixture.productId, fixture.warehouseId);
            expect(stock.reservedUnits).toBe(2);
        } finally {
            await fixture.cleanup();
        }
    });

    it("rejects an invalid request body with 400 INVALID_INPUT (validator)", async () => {
        const req = new NextRequest("http://localhost:3000/api/reservations", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ productId: "", warehouseId: "", quantity: 0 }),
        });
        const res = await reservePost(req);
        expect(res.status).toBe(400);
        const json = (await res.json()) as { error: { code: string } };
        expect(json.error.code).toBe("INVALID_INPUT");
    });
});
