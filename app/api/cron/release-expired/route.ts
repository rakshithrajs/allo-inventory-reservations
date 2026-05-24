import { Receiver } from "@upstash/qstash";
import { NextResponse, type NextRequest } from "next/server";

import { releaseExpiredReservations } from "@/lib/releaseExpired";

const qstashReceiver = process.env.QSTASH_CURRENT_SIGNING_KEY
    ? new Receiver({
          currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
          nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY ?? "",
      })
    : null;

async function isAuthorized(req: NextRequest, body: string): Promise<boolean> {
    if (qstashReceiver) {
        const signature = req.headers.get("upstash-signature");
        if (!signature) return false;
        try {
            await qstashReceiver.verify({
                signature,
                body,
                url: req.url,
            });
            return true;
        } catch {
            return false;
        }
    }

    // Fallback for local manual testing when QStash keys are not configured.
    // Production deployments MUST set QSTASH_CURRENT_SIGNING_KEY.
    const secret = process.env.CRON_SECRET;
    if (!secret) return false;
    return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function POST(req: NextRequest) {
    const body = await req.text();

    if (!(await isAuthorized(req, body))) {
        return NextResponse.json(
            { error: { code: "UNAUTHORIZED", message: "Invalid signature" } },
            { status: 401 },
        );
    }

    const released = await releaseExpiredReservations();
    return NextResponse.json({ released });
}
