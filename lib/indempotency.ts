import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "./prisma";

export async function withIdempotency(
    req: NextRequest,
    endpoint: string,
    body: unknown,
    handler: () => Promise<{ status: number; body: unknown }>,
) {
    const key = req.headers.get("idempotency-key");
    if (!key) {
        const result = await handler();
        return NextResponse.json(result.body, { status: result.status });
    }

    const requestHash = createHash("sha256")
        .update(JSON.stringify({ endpoint, body }))
        .digest("hex");
    const existing = await prisma.idempotencyKey.findUnique({
        where: { key },
    });
    if (existing) {
        if (
            existing.endpoint !== endpoint ||
            existing.requestHash !== requestHash
        ) {
            return NextResponse.json(
                {
                    error: {
                        code: "IDEMPOTENCY_MISMATCH",
                        message: "Key reused with different request",
                    },
                },
                { status: 422 },
            );
        }
        return NextResponse.json(existing.responseBody, {
            status: existing.statusCode,
        });
    }

    const result = await handler();
    await prisma.idempotencyKey.create({
        data: {
            key,
            endpoint,
            requestHash,
            statusCode: result.status,
            responseBody: result.body as object,
        },
    });
    return NextResponse.json(result.body, { status: result.status });
}
