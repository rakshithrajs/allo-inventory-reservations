import { z } from "zod";

export const CreateReservationSchema = z.object({
    productId: z.string().min(1, { error: "productId is required" }),
    warehouseId: z.string().min(1, { error: "warehouseId is required" }),
    quantity: z
        .number({ error: "quantity must be a number" })
        .int({ error: "quantity must be an integer" })
        .positive({ error: "quantity must be greater than 0" }),
});

export type CreateReservationInput = z.infer<typeof CreateReservationSchema>;
