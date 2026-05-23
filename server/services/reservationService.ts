import { prisma } from "@/lib/prisma";
import { withLock } from "@/lib/withLock";

const RESERVATION_WINDOW_MS = 10 * 60 * 1000;

type ReservationError = {
    code?: string;
    message?: string;
    status: number;
};

type ReservationResult = {
    status: number;
    body: unknown;
};

type ReserveInput = {
    productId: string;
    warehouseId: string;
    quantity: number;
};

function isReservationError(error: unknown): error is ReservationError {
    return (
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        typeof (error as { status?: unknown }).status === "number"
    );
}

function toErrorResult(error: ReservationError): ReservationResult {
    return {
        status: error.status,
        body: { error: { code: error.code, message: error.message } },
    };
}

async function withReservationErrors(
    handler: () => Promise<ReservationResult>,
): Promise<ReservationResult> {
    try {
        return await handler();
    } catch (error: unknown) {
        if (isReservationError(error)) {
            return toErrorResult(error);
        }

        throw error;
    }
}

export async function reserve(
    input: ReserveInput,
): Promise<ReservationResult> {
    return withReservationErrors(async () => {
        const { productId, warehouseId, quantity } = input;

        if (!productId || !warehouseId || !quantity || quantity < 1) {
            return {
                status: 400,
                body: {
                    error: { code: "INVALID_INPUT", message: "Bad request" },
                },
            };
        }

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
                            data: { reservedUnits: { increment: quantity } },
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

        return {
            status: 201,
            body: reservation,
        };
    });
}

export async function confirm(id: string): Promise<ReservationResult> {
    return withReservationErrors(async () => {
        const result = await prisma.$transaction(async (tx) => {
            const r = await tx.reservation.findUnique({ where: { id } });
            if (!r) {
                throw {
                    code: "NOT_FOUND",
                    status: 404,
                    message: "Reservation not found",
                };
            }
            if (r.status === "CONFIRMED") {
                return r;
            }
            if (r.status !== "PENDING") {
                throw {
                    code: "ALREADY_RELEASED",
                    status: 409,
                    message: "Not pending",
                };
            }
            if (r.expiresAt < new Date()) {
                throw {
                    code: "RESERVATION_EXPIRED",
                    status: 410,
                    message: "Expired",
                };
            }

            await tx.stock.update({
                where: {
                    productId_warehouseId: {
                        productId: r.productId,
                        warehouseId: r.warehouseId,
                    },
                },
                data: {
                    totalUnits: { decrement: r.quantity },
                    reservedUnits: { decrement: r.quantity },
                },
            });

            return tx.reservation.update({
                where: { id },
                data: { status: "CONFIRMED" },
            });
        });

        return {
            status: 200,
            body: result,
        };
    });
}

export async function release(id: string): Promise<ReservationResult> {
    return withReservationErrors(async () => {
        const result = await prisma.$transaction(async (tx) => {
            const r = await tx.reservation.findUnique({ where: { id } });
            if (!r) {
                throw {
                    code: "NOT_FOUND",
                    status: 404,
                    message: "Reservation not found",
                };
            }
            if (r.status === "RELEASED") {
                return r;
            }
            if (r.status === "CONFIRMED") {
                throw {
                    code: "CANNOT_RELEASE_CONFIRMED",
                    status: 409,
                    message: "cannot release confirmed",
                };
            }
            if (r.status !== "PENDING") {
                throw {
                    code: "ALREADY_FINALIZED",
                    status: 409,
                    message: "Not pending",
                };
            }

            await tx.stock.update({
                where: {
                    productId_warehouseId: {
                        productId: r.productId,
                        warehouseId: r.warehouseId,
                    },
                },
                data: {
                    reservedUnits: { decrement: r.quantity },
                },
            });

            return tx.reservation.update({
                where: { id },
                data: { status: "RELEASED" },
            });
        });

        return {
            status: 200,
            body: result,
        };
    });
}
