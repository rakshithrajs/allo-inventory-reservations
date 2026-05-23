"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

type ReserveButtonProps = {
    productId: string;
    warehouseId: string;
    disabled?: boolean;
};

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
                const payload = (await response.json().catch(() => null)) as {
                    error?: { message?: string };
                } | null;

                toast.error(
                    payload?.error?.message ?? "Unable to create reservation",
                );
                return;
            }

            const reservation = (await response.json()) as { id: string };
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
