import { NextResponse } from "next/server";

import { listProductsWithStock } from "@/server/services/productService";

export async function GET() {
    const products = await listProductsWithStock();
    return NextResponse.json(products);
}
