import type { Prisma } from "@/app/generated/prisma/client";

import { prisma } from "@/lib/prisma";

type ExpiredReservation = {
    id: string;
    productId: string;
    warehouseId: string;
    quantity: number;
};

// Conditional update + per-reservation transaction. The WHERE clause re-checks
// status/expiry inside the transaction so a concurrent confirm() that wins the
// race cannot be clobbered into RELEASED (which would double-decrement
// reservedUnits via the stock update below).
async function releaseOne(
    tx: Prisma.TransactionClient,
    reservation: ExpiredReservation,
): Promise<boolean> {
    const { count } = await tx.reservation.updateMany({
        where: {
            id: reservation.id,
            status: "PENDING",
            expiresAt: { lt: new Date() },
        },
        data: { status: "RELEASED" },
    });

    if (count === 0) return false;

    await tx.stock.update({
        where: {
            productId_warehouseId: {
                productId: reservation.productId,
                warehouseId: reservation.warehouseId,
            },
        },
        data: {
            reservedUnits: { decrement: reservation.quantity },
        },
    });

    return true;
}

export async function releaseExpiredReservations(
    tx?: Prisma.TransactionClient,
): Promise<number> {
    const client = tx ?? prisma;

    const expired = (await client.reservation.findMany({
        where: { status: "PENDING", expiresAt: { lt: new Date() } },
        select: {
            id: true,
            productId: true,
            warehouseId: true,
            quantity: true,
        },
    })) as ExpiredReservation[];

    if (expired.length === 0) {
        return 0;
    }

    let released = 0;

    if (tx) {
        for (const reservation of expired) {
            if (await releaseOne(tx, reservation)) released += 1;
        }
    } else {
        // Per-reservation transactions keep lock duration short and prevent
        // one stuck row from blocking the rest of the batch.
        for (const reservation of expired) {
            const didRelease = await prisma.$transaction((innerTx) =>
                releaseOne(innerTx, reservation),
            );
            if (didRelease) released += 1;
        }
    }

    if (released > 0) {
        console.log(`[expiry] released ${released} reservations`);
    }
    return released;
}
