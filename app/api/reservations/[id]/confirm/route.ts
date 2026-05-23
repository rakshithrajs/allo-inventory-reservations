import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(
    _req: NextRequest,
    ctx: { params: Promise<{ id: string }> },
) {
    const { id } = await ctx.params;
    const reservation = await prisma.reservation.findUnique({ where: { id } });
    if (!reservation)
        return NextResponse.json(
            { error: { code: "NOT_FOUND", message: "Reservation not found" } },
            { status: 404 },
        );
    if (reservation.status !== "PENDING")
        return NextResponse.json(
            { error: { code: "ALREADY_FINALIZED", message: "Not pending" } },
            { status: 409 },
        );
    if (reservation.expiresAt < new Date())
        return NextResponse.json(
            { error: { code: "RESERVATION_EXPIRED", message: "Expired" } },
            { status: 410 },
        );

    await prisma.stock.update({
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
    const updated = await prisma.reservation.update({
        where: { id },
        data: { status: "CONFIRMED" },
    });
    return NextResponse.json(updated);
}
