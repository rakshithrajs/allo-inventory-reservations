import type { Prisma } from "@/app/generated/prisma/client";

import { prisma } from "@/lib/prisma";

type ExpiredReservation = {
    id: string;
    productId: string;
    warehouseId: string;
    quantity: number;
};

export async function releaseExpiredReservations(
    tx?: Prisma.TransactionClient,
) {
    const client = tx ?? prisma;

    const expired = await client.reservation.findMany({
        where: { status: "PENDING", expiresAt: { lt: new Date() } },
        select: {
            id: true,
            productId: true,
            warehouseId: true,
            quantity: true,
        },
    });

    if (expired.length === 0) {
        return 0;
    }

    const releaseInClient = async (
        transactionClient: Prisma.TransactionClient,
    ) => {
        for (const reservation of expired as ExpiredReservation[]) {
            await transactionClient.reservation.update({
                where: { id: reservation.id },
                data: { status: "RELEASED" },
            });

            await transactionClient.stock.update({
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
        }
    };

    if (tx) {
        await releaseInClient(tx);
    } else {
        await prisma.$transaction(releaseInClient);
    }

    console.log(`[expiry] released ${expired.length} reservations`);
    return expired.length;
}
