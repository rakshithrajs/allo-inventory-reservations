import { prisma } from "@/lib/prisma";
import { releaseExpiredReservations } from "@/lib/releaseExpired";

export type WarehouseStock = {
    warehouseId: string;
    warehouseCode: string;
    warehouseName: string;
    availableUnits: number;
};

export type ProductWithStock = {
    id: string;
    sku: string;
    name: string;
    stockByWarehouse: WarehouseStock[];
};

export async function listProductsWithStock(): Promise<ProductWithStock[]> {
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

    return products.map((product) => ({
        id: product.id,
        sku: product.sku,
        name: product.name,
        stockByWarehouse: product.stocks.map((stock) => ({
            warehouseId: stock.warehouseId,
            warehouseCode: stock.warehouse.code,
            warehouseName: stock.warehouse.name,
            availableUnits: stock.totalUnits - stock.reservedUnits,
        })),
    }));
}
