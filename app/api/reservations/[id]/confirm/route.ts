import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(
    _req: NextRequest,
    ctx: { params: Promise<{ id: string }> },
) {
    const { id } = await ctx.params;

    try {
        const result = await prisma.$transaction(async (tx) => {
            const r = await tx.reservation.findUnique({ where: { id } });
            if (!r) {
                throw {
                    code: "NOT_FOUND",
                    status: 404,
                    message: "Reservation not found",
                };
            }
            if (r.status === "CONFIRMED") return r;
            if (r.status !== "PENDING") {
                throw {
                    code: "ALREADY_RELEASED",
                    status: 409,
                    message: "Not pending",
                };
            }
            if (r.expiresAt < new Date()) {
                throw {
                    code: "RESERVATION_EXPIRED",
                    status: 410,
                    message: "Expired",
                };
            }

            await tx.stock.update({
                where: {
                    productId_warehouseId: {
                        productId: r.productId,
                        warehouseId: r.warehouseId,
                    },
                },
                data: {
                    totalUnits: { decrement: r.quantity },
                    reservedUnits: { decrement: r.quantity },
                },
            });

            return tx.reservation.update({
                where: { id },
                data: { status: "CONFIRMED" },
            });
        });

        return NextResponse.json(result);
    } catch (e: unknown) {
        if (
            typeof e === "object" &&
            e !== null &&
            "status" in e &&
            typeof (e as { status?: unknown }).status === "number"
        ) {
            const error = e as {
                code?: string;
                message?: string;
                status: number;
            };

            return NextResponse.json(
                { error: { code: error.code, message: error.message } },
                { status: error.status },
            );
        }

        throw e;
    }
}
