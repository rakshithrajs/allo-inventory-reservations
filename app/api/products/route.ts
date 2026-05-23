import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
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
