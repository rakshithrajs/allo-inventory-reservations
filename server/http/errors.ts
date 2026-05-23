import { NextResponse } from "next/server";

export type ApiErrorCode =
    | "INVALID_INPUT"
    | "NOT_FOUND"
    | "INSUFFICIENT_STOCK"
    | "RESERVATION_EXPIRED"
    | "ALREADY_RELEASED"
    | "ALREADY_FINALIZED"
    | "CANNOT_RELEASE_CONFIRMED"
    | "IDEMPOTENCY_MISMATCH"
    | "LOCK_CONTENTION"
    | "INTERNAL_ERROR";

export class ApiError extends Error {
    public readonly code: ApiErrorCode;
    public readonly status: number;

    constructor(code: ApiErrorCode, message: string, status: number) {
        super(message);
        this.name = "ApiError";
        this.code = code;
        this.status = status;
    }
}

export type ApiErrorBody = {
    error: { code: ApiErrorCode; message: string };
};

function toBody(error: ApiError): ApiErrorBody {
    return { error: { code: error.code, message: error.message } };
}

export function isApiError(value: unknown): value is ApiError {
    return value instanceof ApiError;
}

export function apiError(
    code: ApiErrorCode,
    message: string,
    status: number,
): NextResponse<ApiErrorBody> {
    return NextResponse.json(toBody(new ApiError(code, message, status)), {
        status,
    });
}

export function handleApiError(error: unknown): NextResponse<ApiErrorBody> {
    if (isApiError(error)) {
        return NextResponse.json(toBody(error), { status: error.status });
    }
    console.error("[api] unexpected error", error);
    return apiError("INTERNAL_ERROR", "Something went wrong", 500);
}

export type ServiceResult = {
    status: number;
    body: unknown;
};

// Service-layer helper: runs a handler that may throw ApiError and converts
// the outcome into a { status, body } result for the route layer / idempotency
// wrapper to consume. Unknown errors propagate so callers can decide.
export async function toServiceResult<T>(
    handler: () => Promise<T>,
    successStatus = 200,
): Promise<ServiceResult> {
    try {
        const body = await handler();
        return { status: successStatus, body };
    } catch (error: unknown) {
        if (isApiError(error)) {
            return { status: error.status, body: toBody(error) };
        }
        throw error;
    }
}
