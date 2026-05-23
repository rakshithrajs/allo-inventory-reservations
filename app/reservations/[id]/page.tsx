"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import type {
    ApiErrorResponse,
    Reservation,
} from "@/server/types/reservation";

type LoadState =
    | { kind: "loading" }
    | { kind: "ready"; reservation: Reservation }
    | { kind: "error"; message: string };

function formatCountdown(remainingMs: number): string {
    const mins = Math.floor(remainingMs / 60_000);
    const secs = Math.floor((remainingMs % 60_000) / 1000);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function statusBadgeVariant(
    status: Reservation["status"],
): "default" | "secondary" | "destructive" | "outline" {
    if (status === "CONFIRMED") return "default";
    if (status === "RELEASED") return "secondary";
    return "outline";
}

async function readErrorMessage(response: Response): Promise<string> {
    try {
        const payload = (await response.json()) as ApiErrorResponse;
        return payload.error?.message ?? "Unexpected error";
    } catch {
        return "Unexpected error";
    }
}

export default function ReservationPage() {
    const { id } = useParams<{ id: string }>();
    const router = useRouter();

    const [state, setState] = useState<LoadState>({ kind: "loading" });
    const [now, setNow] = useState(() => Date.now());
    const [isActing, setIsActing] = useState(false);

    useEffect(() => {
        let cancelled = false;

        async function load() {
            try {
                const res = await fetch(`/api/reservations/${id}`, {
                    cache: "no-store",
                });
                if (cancelled) return;

                if (!res.ok) {
                    setState({
                        kind: "error",
                        message: await readErrorMessage(res),
                    });
                    return;
                }

                const reservation = (await res.json()) as Reservation;
                setState({ kind: "ready", reservation });
            } catch {
                if (!cancelled) {
                    setState({
                        kind: "error",
                        message: "Failed to load reservation",
                    });
                }
            }
        }

        load();
        return () => {
            cancelled = true;
        };
    }, [id]);

    useEffect(() => {
        const interval = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(interval);
    }, []);

    if (state.kind === "loading") {
        return (
            <main className="mx-auto max-w-md p-8">
                <p className="text-sm text-muted-foreground">
                    Loading reservation…
                </p>
            </main>
        );
    }

    if (state.kind === "error") {
        return (
            <main className="mx-auto max-w-md p-8 space-y-4">
                <h1 className="text-xl font-semibold">
                    Reservation not available
                </h1>
                <p className="text-sm text-muted-foreground">{state.message}</p>
                <Button variant="outline" onClick={() => router.push("/")}>
                    Back to products
                </Button>
            </main>
        );
    }

    const { reservation } = state;
    const expiresAtMs = new Date(reservation.expiresAt).getTime();
    const remaining = Math.max(0, expiresAtMs - now);
    const expired = remaining === 0;
    const isPending = reservation.status === "PENDING";

    const act = async (action: "confirm" | "release") => {
        if (isActing) return;
        setIsActing(true);

        try {
            const res = await fetch(`/api/reservations/${id}/${action}`, {
                method: "POST",
            });

            if (res.status === 410) {
                toast.error("Reservation expired — please try again");
                router.push("/");
                router.refresh();
                return;
            }

            if (res.status === 409) {
                const payload = (await res
                    .json()
                    .catch(() => null)) as ApiErrorResponse | null;
                const code = payload?.error?.code;
                if (code === "CANNOT_RELEASE_CONFIRMED") {
                    toast.error("This reservation has already been confirmed");
                } else if (code === "ALREADY_RELEASED") {
                    toast.error("This reservation has already been released");
                } else {
                    toast.error(
                        payload?.error?.message ?? "Could not process request",
                    );
                }
                return;
            }

            if (!res.ok) {
                toast.error(await readErrorMessage(res));
                return;
            }

            toast.success(
                action === "confirm"
                    ? "Purchase confirmed"
                    : "Reservation cancelled",
            );
            router.push("/");
            router.refresh();
        } finally {
            setIsActing(false);
        }
    };

    return (
        <main className="mx-auto flex min-h-screen max-w-md flex-col gap-6 px-4 py-8">
            <Card>
                <CardHeader>
                    <div className="flex items-start justify-between gap-3">
                        <div className="space-y-1">
                            <CardTitle>Confirm your reservation</CardTitle>
                            <CardDescription>
                                Reservation {reservation.id.slice(0, 8)}…
                            </CardDescription>
                        </div>
                        <Badge variant={statusBadgeVariant(reservation.status)}>
                            {reservation.status}
                        </Badge>
                    </div>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="flex items-baseline justify-between">
                        <span className="text-sm text-muted-foreground">
                            Quantity
                        </span>
                        <span className="text-lg font-medium">
                            {reservation.quantity}
                        </span>
                    </div>
                    <div className="flex items-baseline justify-between">
                        <span className="text-sm text-muted-foreground">
                            Expires in
                        </span>
                        <span className="text-2xl tabular-nums font-semibold">
                            {expired
                                ? "Expired"
                                : formatCountdown(remaining)}
                        </span>
                    </div>
                    <div className="flex gap-2 pt-2">
                        <Button
                            onClick={() => act("confirm")}
                            disabled={!isPending || expired || isActing}
                            className="flex-1"
                        >
                            Confirm purchase
                        </Button>
                        <Button
                            variant="outline"
                            onClick={() => act("release")}
                            disabled={!isPending || isActing}
                            className="flex-1"
                        >
                            Cancel
                        </Button>
                    </div>
                </CardContent>
            </Card>
        </main>
    );
}
