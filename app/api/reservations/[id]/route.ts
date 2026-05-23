import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/server/http/errors";

export async function GET(
    _req: NextRequest,
    ctx: { params: Promise<{ id: string }> },
) {
    const { id } = await ctx.params;
    const reservation = await prisma.reservation.findUnique({ where: { id } });
    if (!reservation) {
        return apiError("NOT_FOUND", "Reservation not found", 404);
    }
    return NextResponse.json(reservation);
}
