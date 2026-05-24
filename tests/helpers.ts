import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";

export const TEST_PREFIX = "__test__";

export type TestFixture = {
    productId: string;
    warehouseId: string;
    cleanup: () => Promise<void>;
};

// Create an isolated product + warehouse + stock row for a single test so
// concurrent tests never collide on the same (productId, warehouseId) lock row.
export async function createStockFixture(totalUnits: number): Promise<TestFixture> {
    const tag = randomUUID();
    const product = await prisma.product.create({
        data: { sku: `${TEST_PREFIX}-SKU-${tag}`, name: `${TEST_PREFIX} product ${tag}` },
    });
    const warehouse = await prisma.warehouse.create({
        data: { code: `${TEST_PREFIX}-WH-${tag}`, name: `${TEST_PREFIX} warehouse ${tag}` },
    });
    await prisma.stock.create({
        data: {
            productId: product.id,
            warehouseId: warehouse.id,
            totalUnits,
            reservedUnits: 0,
        },
    });

    return {
        productId: product.id,
        warehouseId: warehouse.id,
        cleanup: async () => {
            await prisma.reservation.deleteMany({
                where: { productId: product.id, warehouseId: warehouse.id },
            });
            await prisma.stock.deleteMany({
                where: { productId: product.id, warehouseId: warehouse.id },
            });
            await prisma.product.delete({ where: { id: product.id } });
            await prisma.warehouse.delete({ where: { id: warehouse.id } });
        },
    };
}

export async function readStock(productId: string, warehouseId: string) {
    const stock = await prisma.stock.findUnique({
        where: { productId_warehouseId: { productId, warehouseId } },
    });
    if (!stock) throw new Error("stock fixture missing");
    return {
        totalUnits: stock.totalUnits,
        reservedUnits: stock.reservedUnits,
        available: stock.totalUnits - stock.reservedUnits,
    };
}

// Catch-all cleanup so a crashed test run doesn't leak fixture data.
export async function purgeTestData(): Promise<void> {
    const products = await prisma.product.findMany({
        where: { sku: { startsWith: TEST_PREFIX } },
        select: { id: true },
    });
    const warehouses = await prisma.warehouse.findMany({
        where: { code: { startsWith: TEST_PREFIX } },
        select: { id: true },
    });

    if (products.length === 0 && warehouses.length === 0) return;

    const productIds = products.map((p) => p.id);
    const warehouseIds = warehouses.map((w) => w.id);

    await prisma.reservation.deleteMany({
        where: {
            OR: [
                { productId: { in: productIds } },
                { warehouseId: { in: warehouseIds } },
            ],
        },
    });
    await prisma.stock.deleteMany({
        where: {
            OR: [
                { productId: { in: productIds } },
                { warehouseId: { in: warehouseIds } },
            ],
        },
    });
    if (productIds.length > 0) {
        await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    }
    if (warehouseIds.length > 0) {
        await prisma.warehouse.deleteMany({ where: { id: { in: warehouseIds } } });
    }
}
