import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
    const warehouses = await prisma.warehouse.findMany({
        select: { id: true, code: true, name: true },
        orderBy: { code: "asc" },
    });
    return NextResponse.json(warehouses);
}
