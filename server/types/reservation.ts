import type { ApiErrorCode } from "@/server/http/errors";

export type ReservationStatus = "PENDING" | "CONFIRMED" | "RELEASED";

export type Reservation = {
    id: string;
    productId: string;
    warehouseId: string;
    quantity: number;
    status: ReservationStatus;
    expiresAt: string;
    createdAt: string;
    updatedAt: string;
};

export type ApiErrorResponse = {
    error: { code: ApiErrorCode; message: string };
};
