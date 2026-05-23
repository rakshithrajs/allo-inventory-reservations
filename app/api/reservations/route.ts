import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const RESERVATION_WINDOW_MS = 10 * 60 * 1000;

export async function POST(req: NextRequest) {
    const body = await req.json();
    const { productId, warehouseId, quantity } = body as {
        productId: string;
        warehouseId: string;
        quantity: number;
    };

    if (!productId || !warehouseId || !quantity || quantity < 1) {
        return NextResponse.json(
            { error: { code: "INVALID_INPUT", message: "Bad request" } },
            { status: 400 },
        );
    }

    const stock = await prisma.stock.findUnique({
        where: { productId_warehouseId: { productId, warehouseId } },
    });
    if (!stock)
        return NextResponse.json(
            { error: { code: "NOT_FOUND", message: "Stock not found" } },
            { status: 404 },
        );

    const available = stock.totalUnits - stock.reservedUnits;
    if (available < quantity) {
        return NextResponse.json(
            {
                error: {
                    code: "INSUFFICIENT_STOCK",
                    message: "Not enough stock",
                },
            },
            { status: 409 },
        );
    }

    await prisma.stock.update({
        where: { productId_warehouseId: { productId, warehouseId } },
        data: { reservedUnits: { increment: quantity } },
    });
    const reservation = await prisma.reservation.create({
        data: {
            productId,
            warehouseId,
            quantity,
            expiresAt: new Date(Date.now() + RESERVATION_WINDOW_MS),
        },
    });

    return NextResponse.json(reservation, { status: 201 });
}
