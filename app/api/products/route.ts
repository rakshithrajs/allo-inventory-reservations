import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { releaseExpiredReservations } from "@/lib/releaseExpired";

export async function GET() {
    await releaseExpiredReservations();

    const products = await prisma.product.findMany({
        include: {
            stocks: {
                include: {
                    warehouse: {
                        select: { id: true, code: true, name: true },
                    },
                },
            },
        },
        orderBy: { name: "asc" },
    });

    const shaped = products.map((p) => ({
        id: p.id,
        sku: p.sku,
        name: p.name,
        stockByWarehouse: p.stocks.map((s) => ({
            warehouseId: s.warehouseId,
            warehouseCode: s.warehouse.code,
            warehouseName: s.warehouse.name,
            availableUnits: s.totalUnits - s.reservedUnits,
        })),
    }));

    return NextResponse.json(shaped);
}
