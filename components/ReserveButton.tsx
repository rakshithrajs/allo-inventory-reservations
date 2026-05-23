"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import type {
    ApiErrorResponse,
    Reservation,
} from "@/server/types/reservation";

type ReserveButtonProps = {
    productId: string;
    warehouseId: string;
    disabled?: boolean;
};

function messageForCode(code: string | undefined, fallback: string): string {
    switch (code) {
        case "INSUFFICIENT_STOCK":
            return "Out of stock";
        case "LOCK_CONTENTION":
            return "That item is in demand — please try again";
        case "NOT_FOUND":
            return "This product is no longer available";
        case "INVALID_INPUT":
            return "Invalid request";
        default:
            return fallback;
    }
}

export function ReserveButton({
    productId,
    warehouseId,
    disabled = false,
}: ReserveButtonProps) {
    const router = useRouter();
    const [isPending, startTransition] = useTransition();

    const handleClick = () => {
        startTransition(async () => {
            const response = await fetch("/api/reservations", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    productId,
                    warehouseId,
                    quantity: 1,
                }),
            });

            if (!response.ok) {
                const payload = (await response.json().catch(() => null)) as
                    | ApiErrorResponse
                    | null;

                toast.error(
                    messageForCode(
                        payload?.error?.code,
                        payload?.error?.message ?? "Unable to create reservation",
                    ),
                );
                router.refresh();
                return;
            }

            const reservation = (await response.json()) as Reservation;
            toast.success("Reservation created");
            router.push(`/reservations/${reservation.id}`);
        });
    };

    return (
        <Button onClick={handleClick} disabled={disabled || isPending}>
            Reserve 1
        </Button>
    );
}
