import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../app/generated/prisma/client";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
    const [blr, del] = await Promise.all([
        prisma.warehouse.upsert({
            where: { code: "BLR-01" },
            update: {},
            create: { code: "BLR-01", name: "Bengaluru DC" },
        }),
        prisma.warehouse.upsert({
            where: { code: "DEL-02" },
            update: {},
            create: { code: "DEL-02", name: "Delhi DC" },
        }),
    ]);

    const products = await Promise.all([
        prisma.product.upsert({
            where: { sku: "TEE-001" },
            update: {},
            create: { sku: "TEE-001", name: "Cotton Tee" },
        }),
        prisma.product.upsert({
            where: { sku: "JKT-002" },
            update: {},
            create: { sku: "JKT-002", name: "Denim Jacket" },
        }),
        prisma.product.upsert({
            where: { sku: "PNT-003" },
            update: {},
            create: { sku: "PNT-003", name: "Linen Pants" },
        }),
    ]);

    for (const p of products) {
        for (const w of [blr, del]) {
            await prisma.stock.upsert({
                where: {
                    productId_warehouseId: {
                        productId: p.id,
                        warehouseId: w.id,
                    },
                },
                update: {},
                create: {
                    productId: p.id,
                    warehouseId: w.id,
                    totalUnits: 10,
                    reservedUnits: 0,
                },
            });
        }
    }
}

main().finally(() => prisma.$disconnect());
