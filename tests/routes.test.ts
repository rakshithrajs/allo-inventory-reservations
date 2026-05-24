import { randomUUID } from "crypto";
import { NextRequest } from "next/server";
import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { GET as productsGet } from "@/app/api/products/route";
import { GET as warehousesGet } from "@/app/api/warehouses/route";
import { GET as reservationGet } from "@/app/api/reservations/[id]/route";
import { POST as reservePost } from "@/app/api/reservations/route";
import { POST as confirmPost } from "@/app/api/reservations/[id]/confirm/route";
import { POST as releasePost } from "@/app/api/reservations/[id]/release/route";
import { createStockFixture, purgeTestData, readStock } from "./helpers";

function jsonRequest(
    url: string,
    body: unknown,
    idempotencyKey?: string,
): NextRequest {
    const headers: Record<string, string> = {
        "content-type": "application/json",
    };
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    return new NextRequest(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
    });
}

describe("HTTP route layer", () => {
    afterAll(async () => {
        await prisma.idempotencyKey.deleteMany({
            where: {
                endpoint: {
                    in: [
                        "reservations:create",
                        "reservations:confirm",
                        "reservations:release",
                    ],
                },
            },
        });
        await purgeTestData();
        await prisma.$disconnect();
    });

    describe("GET /api/warehouses", () => {
        it("returns the list of warehouses with id/code/name", async () => {
            const fixture = await createStockFixture(1);
            try {
                const res = await warehousesGet();
                expect(res.status).toBe(200);
                const body = (await res.json()) as {
                    id: string;
                    code: string;
                    name: string;
                }[];
                expect(Array.isArray(body)).toBe(true);
                const created = body.find((w) => w.id === fixture.warehouseId);
                expect(created).toBeTruthy();
                expect(created?.code).toMatch(/^__test__-WH-/);
            } finally {
                await fixture.cleanup();
            }
        });
    });

    describe("GET /api/products", () => {
        it("returns products with availableUnits per warehouse and triggers lazy expiry cleanup", async () => {
            const fixture = await createStockFixture(4);
            try {
                // Create a stale PENDING reservation so we can prove the GET
                // sweeps expired holds back into availability.
                const reserved = await reservePost(
                    jsonRequest(
                        "http://localhost:3000/api/reservations",
                        {
                            productId: fixture.productId,
                            warehouseId: fixture.warehouseId,
                            quantity: 2,
                        },
                    ),
                );
                expect(reserved.status).toBe(201);
                const reservation = (await reserved.json()) as { id: string };

                await prisma.reservation.update({
                    where: { id: reservation.id },
                    data: { expiresAt: new Date(Date.now() - 60_000) },
                });

                const res = await productsGet();
                expect(res.status).toBe(200);
                const body = (await res.json()) as {
                    id: string;
                    stockByWarehouse: {
                        warehouseId: string;
                        availableUnits: number;
                    }[];
                }[];
                const product = body.find((p) => p.id === fixture.productId);
                expect(product).toBeTruthy();
                const row = product?.stockByWarehouse.find(
                    (s) => s.warehouseId === fixture.warehouseId,
                );
                expect(row?.availableUnits).toBe(4);

                // And the reservation should now be RELEASED in DB.
                const refreshed = await prisma.reservation.findUniqueOrThrow({
                    where: { id: reservation.id },
                });
                expect(refreshed.status).toBe("RELEASED");

                const stock = await readStock(
                    fixture.productId,
                    fixture.warehouseId,
                );
                expect(stock.reservedUnits).toBe(0);
            } finally {
                await fixture.cleanup();
            }
        });
    });

    describe("GET /api/reservations/[id]", () => {
        it("returns 200 with the reservation when it exists", async () => {
            const fixture = await createStockFixture(1);
            try {
                const reserved = await reservePost(
                    jsonRequest(
                        "http://localhost:3000/api/reservations",
                        {
                            productId: fixture.productId,
                            warehouseId: fixture.warehouseId,
                            quantity: 1,
                        },
                    ),
                );
                const reservation = (await reserved.json()) as { id: string };

                const req = new NextRequest(
                    `http://localhost:3000/api/reservations/${reservation.id}`,
                );
                const res = await reservationGet(req, {
                    params: Promise.resolve({ id: reservation.id }),
                });
                expect(res.status).toBe(200);
                const body = (await res.json()) as { id: string; status: string };
                expect(body.id).toBe(reservation.id);
                expect(body.status).toBe("PENDING");
            } finally {
                await fixture.cleanup();
            }
        });

        it("returns 404 NOT_FOUND for an unknown id", async () => {
            const req = new NextRequest(
                "http://localhost:3000/api/reservations/does-not-exist",
            );
            const res = await reservationGet(req, {
                params: Promise.resolve({ id: "does-not-exist" }),
            });
            expect(res.status).toBe(404);
            const body = (await res.json()) as { error: { code: string } };
            expect(body.error.code).toBe("NOT_FOUND");
        });
    });

    describe("Idempotency on confirm + release routes", () => {
        it("replays the cached confirm response on retry with the same Idempotency-Key", async () => {
            const fixture = await createStockFixture(2);
            const key = randomUUID();
            try {
                const reserved = await reservePost(
                    jsonRequest(
                        "http://localhost:3000/api/reservations",
                        {
                            productId: fixture.productId,
                            warehouseId: fixture.warehouseId,
                            quantity: 1,
                        },
                    ),
                );
                const reservation = (await reserved.json()) as { id: string };
                const params = Promise.resolve({ id: reservation.id });

                const url = `http://localhost:3000/api/reservations/${reservation.id}/confirm`;
                const first = await confirmPost(
                    jsonRequest(url, {}, key),
                    { params },
                );
                expect(first.status).toBe(200);

                const second = await confirmPost(
                    jsonRequest(url, {}, key),
                    { params },
                );
                expect(second.status).toBe(200);

                const stock = await readStock(
                    fixture.productId,
                    fixture.warehouseId,
                );
                // totalUnits decremented exactly once even though the route
                // was hit twice with the same idempotency key.
                expect(stock.totalUnits).toBe(1);
                expect(stock.reservedUnits).toBe(0);
            } finally {
                await prisma.idempotencyKey.deleteMany({ where: { key } });
                await fixture.cleanup();
            }
        });

        it("replays the cached release response on retry with the same Idempotency-Key", async () => {
            const fixture = await createStockFixture(2);
            const key = randomUUID();
            try {
                const reserved = await reservePost(
                    jsonRequest(
                        "http://localhost:3000/api/reservations",
                        {
                            productId: fixture.productId,
                            warehouseId: fixture.warehouseId,
                            quantity: 1,
                        },
                    ),
                );
                const reservation = (await reserved.json()) as { id: string };
                const params = Promise.resolve({ id: reservation.id });

                const url = `http://localhost:3000/api/reservations/${reservation.id}/release`;
                const first = await releasePost(
                    jsonRequest(url, {}, key),
                    { params },
                );
                expect(first.status).toBe(200);

                const second = await releasePost(
                    jsonRequest(url, {}, key),
                    { params },
                );
                expect(second.status).toBe(200);

                const stock = await readStock(
                    fixture.productId,
                    fixture.warehouseId,
                );
                // reservedUnits would have gone negative if release ran twice
                // without idempotency replay.
                expect(stock.totalUnits).toBe(2);
                expect(stock.reservedUnits).toBe(0);
            } finally {
                await prisma.idempotencyKey.deleteMany({ where: { key } });
                await fixture.cleanup();
            }
        });
    });
});
