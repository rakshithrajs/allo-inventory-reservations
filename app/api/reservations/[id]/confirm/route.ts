import { NextRequest } from "next/server";
import { withIdempotency } from "@/lib/indempotency";
import { confirm } from "@/server/services/reservationService";

export async function POST(
    req: NextRequest,
    ctx: { params: Promise<{ id: string }> },
) {
    const { id } = await ctx.params;

    return withIdempotency(req, "reservations:confirm", { id }, async () => {
        return confirm(id);
    });
}
