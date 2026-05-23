import { NextRequest } from "next/server";

import { withIdempotency } from "@/lib/indempotency";
import { reserve } from "@/server/services/reservationService";

export async function POST(req: NextRequest) {
    const body = await req.json();
    const { productId, warehouseId, quantity } = body as {
        productId: string;
        warehouseId: string;
        quantity: number;
    };

    return withIdempotency(req, "reservations:create", body, async () => {
        return reserve({ productId, warehouseId, quantity });
    });
}
