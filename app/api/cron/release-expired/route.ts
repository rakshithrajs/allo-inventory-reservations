import { NextResponse } from "next/server";
import { releaseExpiredReservations } from "@/lib/releaseExpired";

export async function GET() {
    const count = await releaseExpiredReservations();
    return NextResponse.json({ released: count });
}
