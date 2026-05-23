import { NextRequest } from "next/server";

import { withIdempotency } from "@/lib/indempotency";
import { apiError } from "@/server/http/errors";
import { reserve } from "@/server/services/reservationService";
import { CreateReservationSchema } from "@/server/validators/reservation";

export async function POST(req: NextRequest) {
    const rawBody = await req.json().catch(() => null);
    const parsed = CreateReservationSchema.safeParse(rawBody);

    if (!parsed.success) {
        const message = parsed.error.issues
            .map((issue) =>
                issue.path.length > 0
                    ? `${issue.path.join(".")}: ${issue.message}`
                    : issue.message,
            )
            .join("; ");

        return apiError("INVALID_INPUT", message, 400);
    }

    return withIdempotency(req, "reservations:create", parsed.data, async () => {
        return reserve(parsed.data);
    });
}
