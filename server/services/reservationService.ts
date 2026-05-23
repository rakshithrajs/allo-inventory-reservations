import { prisma } from "@/lib/prisma";
import { withLock } from "@/lib/withLock";
import {
    ApiError,
    toServiceResult,
    type ServiceResult,
} from "@/server/http/errors";
import type { CreateReservationInput } from "@/server/validators/reservation";

const RESERVATION_WINDOW_MS = 10 * 60 * 1000;
const RESERVE_LOCK_TTL_MS = 5000;
const RESERVE_LOCK_WAIT_MS = 5000;

export async function reserve(
    input: CreateReservationInput,
): Promise<ServiceResult> {
    return toServiceResult(async () => {
        const { productId, warehouseId, quantity } = input;

        return withLock(
            `stock:${productId}:${warehouseId}`,
            async () => {
                return prisma.$transaction(
                    async (tx) => {
                        // FOR UPDATE serialises concurrent reservers on the
                        // same (productId, warehouseId) row instead of racing
                        // the availability check.
                        const rows = await tx.$queryRaw<
                            { totalUnits: number; reservedUnits: number }[]
                        >`
                            SELECT "totalUnits", "reservedUnits"
                            FROM "Stock"
                            WHERE "productId" = ${productId} AND "warehouseId" = ${warehouseId}
                            FOR UPDATE
                        `;

                        if (rows.length === 0) {
                            throw new ApiError(
                                "NOT_FOUND",
                                "Stock not found",
                                404,
                            );
                        }

                        const available =
                            rows[0].totalUnits - rows[0].reservedUnits;
                        if (available < quantity) {
                            throw new ApiError(
                                "INSUFFICIENT_STOCK",
                                "Not enough stock",
                                409,
                            );
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
            { ttlMs: RESERVE_LOCK_TTL_MS, maxWaitMs: RESERVE_LOCK_WAIT_MS },
        );
    }, 201);
}

export async function confirm(id: string): Promise<ServiceResult> {
    return toServiceResult(async () => {
        return prisma.$transaction(async (tx) => {
            const reservation = await tx.reservation.findUnique({
                where: { id },
            });

            if (!reservation) {
                throw new ApiError(
                    "NOT_FOUND",
                    "Reservation not found",
                    404,
                );
            }
            if (reservation.status === "CONFIRMED") return reservation;
            if (reservation.status !== "PENDING") {
                throw new ApiError(
                    "ALREADY_RELEASED",
                    "Reservation is not pending",
                    409,
                );
            }
            if (reservation.expiresAt < new Date()) {
                throw new ApiError(
                    "RESERVATION_EXPIRED",
                    "Reservation has expired",
                    410,
                );
            }

            await tx.stock.update({
                where: {
                    productId_warehouseId: {
                        productId: reservation.productId,
                        warehouseId: reservation.warehouseId,
                    },
                },
                data: {
                    totalUnits: { decrement: reservation.quantity },
                    reservedUnits: { decrement: reservation.quantity },
                },
            });

            return tx.reservation.update({
                where: { id },
                data: { status: "CONFIRMED" },
            });
        });
    });
}

export async function release(id: string): Promise<ServiceResult> {
    return toServiceResult(async () => {
        return prisma.$transaction(async (tx) => {
            const reservation = await tx.reservation.findUnique({
                where: { id },
            });

            if (!reservation) {
                throw new ApiError(
                    "NOT_FOUND",
                    "Reservation not found",
                    404,
                );
            }
            if (reservation.status === "RELEASED") return reservation;
            if (reservation.status === "CONFIRMED") {
                throw new ApiError(
                    "CANNOT_RELEASE_CONFIRMED",
                    "Cannot release a confirmed reservation",
                    409,
                );
            }
            if (reservation.status !== "PENDING") {
                throw new ApiError(
                    "ALREADY_FINALIZED",
                    "Reservation is not pending",
                    409,
                );
            }

            await tx.stock.update({
                where: {
                    productId_warehouseId: {
                        productId: reservation.productId,
                        warehouseId: reservation.warehouseId,
                    },
                },
                data: { reservedUnits: { decrement: reservation.quantity } },
            });

            return tx.reservation.update({
                where: { id },
                data: { status: "RELEASED" },
            });
        });
    });
}
