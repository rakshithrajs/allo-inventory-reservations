import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(
    _req: NextRequest,
    ctx: { params: Promise<{ id: string }> },
) {
    const { id } = await ctx.params;
    const r = await prisma.reservation.findUnique({ where: { id } });
    if (!r)
        return NextResponse.json(
            { error: { code: "NOT_FOUND", message: "Not found" } },
            { status: 404 },
        );
    return NextResponse.json(r);
}
