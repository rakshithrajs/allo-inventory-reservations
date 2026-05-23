import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { withIdempotency } from "@/lib/indempotency";
import { withLock } from "@/lib/withLock";

const RESERVATION_WINDOW_MS = 10 * 60 * 1000;

export async function POST(req: NextRequest) {
    const body = await req.json();
    const { productId, warehouseId, quantity } = body as {
        productId: string;
        warehouseId: string;
        quantity: number;
    };

    return withIdempotency(req, "reservations:create", body, async () => {
        if (!productId || !warehouseId || !quantity || quantity < 1) {
            return {
                status: 400,
                body: {
                    error: { code: "INVALID_INPUT", message: "Bad request" },
                },
            };
        }

        try {
            const reservation = await withLock(
                `stock:${productId}:${warehouseId}`,
                async () => {
                    return prisma.$transaction(
                        async (tx) => {
                            const rows = await tx.$queryRaw<
                                { totalUnits: number; reservedUnits: number }[]
                            >`
      SELECT "totalUnits", "reservedUnits"
      FROM "Stock"
      WHERE "productId" = ${productId} AND "warehouseId" = ${warehouseId}
      FOR UPDATE
    `;
                            if (rows.length === 0) {
                                throw {
                                    code: "NOT_FOUND",
                                    status: 404,
                                    message: "Stock not found",
                                };
                            }

                            const available =
                                rows[0].totalUnits - rows[0].reservedUnits;
                            if (available < quantity) {
                                throw {
                                    code: "INSUFFICIENT_STOCK",
                                    status: 409,
                                    message: "Not enough stock",
                                };
                            }

                            await tx.stock.update({
                                where: {
                                    productId_warehouseId: {
                                        productId,
                                        warehouseId,
                                    },
                                },
                                data: {
                                    reservedUnits: { increment: quantity },
                                },
                            });

                            return tx.reservation.create({
                                data: {
                                    productId,
                                    warehouseId,
                                    quantity,
                                    expiresAt: new Date(
                                        Date.now() + RESERVATION_WINDOW_MS,
                                    ),
                                },
                            });
                        },
                        { isolationLevel: "Serializable" },
                    );
                },
                5000,
            );

            return { status: 201, body: reservation };
        } catch (e: unknown) {
            if (
                typeof e === "object" &&
                e !== null &&
                "status" in e &&
                typeof (e as { status?: unknown }).status === "number"
            ) {
                const error = e as {
                    code?: string;
                    message?: string;
                    status: number;
                };
                return {
                    status: error.status,
                    body: {
                        error: { code: error.code, message: error.message },
                    },
                };
            }

            throw e;
        }
    });
}
