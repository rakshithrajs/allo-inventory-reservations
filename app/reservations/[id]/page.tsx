"use client";
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export default function ReservationPage() {
    const { id } = useParams<{ id: string }>();
    const router = useRouter();
    const [reservation, setReservation] = useState<any>(null);
    const [now, setNow] = useState(Date.now());

    useEffect(() => {
        fetch(`/api/reservations/${id}`)
            .then((r) => r.json())
            .then(setReservation);
        const t = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
    }, [id]);

    if (!reservation) return <div className="p-8">Loading…</div>;
    const remaining = Math.max(
        0,
        new Date(reservation.expiresAt).getTime() - now,
    );
    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);

    const act = async (action: "confirm" | "release") => {
        const res = await fetch(`/api/reservations/${id}/${action}`, {
            method: "POST",
        });
        if (res.status === 410) {
            toast.error("Reservation expired");
            router.push("/");
            return;
        }
        if (!res.ok) {
            toast.error("Something went wrong");
            return;
        }
        toast.success(
            action === "confirm" ?
                "Purchase confirmed"
            :   "Reservation cancelled",
        );
        router.push("/");
    };

    return (
        <main className="mx-auto max-w-md p-8 space-y-4">
            <h1 className="text-xl font-semibold">Confirm your reservation</h1>
            <div>Quantity: {reservation.quantity}</div>
            <div className="text-2xl tabular-nums">
                {mins}:{secs.toString().padStart(2, "0")}
            </div>
            <div className="flex gap-2">
                <Button
                    onClick={() => act("confirm")}
                    disabled={remaining === 0}
                >
                    Confirm purchase
                </Button>
                <Button variant="outline" onClick={() => act("release")}>
                    Cancel
                </Button>
            </div>
        </main>
    );
}
