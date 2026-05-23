import { Badge } from "@/components/ui/badge";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";

import { ReserveButton } from "@/components/ReserveButton";

async function getProducts() {
    const res = await fetch(
        `${process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000"}/api/products`,
        { cache: "no-store" },
    );
    if (!res.ok) throw new Error("Failed to load products");
    return res.json();
}

type StockRow = {
    warehouseId: string;
    warehouseCode: string;
    warehouseName: string;
    availableUnits: number;
};

type ProductRow = {
    id: string;
    sku: string;
    name: string;
    stockByWarehouse: StockRow[];
};

export default async function Home() {
    const products = (await getProducts()) as ProductRow[];
    return (
        <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
            <section className="space-y-3">
                <Badge variant="outline" className="w-fit">
                    Inventory overview
                </Badge>
                <div className="space-y-2">
                    <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
                        Allo Stock Manager
                    </h1>
                    <p className="max-w-2xl text-sm text-muted-foreground sm:text-base">
                        Browse products by warehouse and prepare a reservation
                        flow for the next phase.
                    </p>
                </div>
            </section>

            <div className="grid gap-4">
                {products.map((product) => (
                    <Card
                        key={product.id}
                        className="bg-card/80 backdrop-blur"
                    >
                        <CardHeader>
                            <div className="flex flex-wrap items-start justify-between gap-3">
                                <div className="space-y-1">
                                    <CardTitle>{product.name}</CardTitle>
                                    <CardDescription>
                                        {product.sku}
                                    </CardDescription>
                                </div>
                                <Badge variant="secondary">
                                    {product.stockByWarehouse.length}{" "}
                                    warehouses
                                </Badge>
                            </div>
                        </CardHeader>
                        <CardContent>
                            <div className="grid gap-3">
                                {product.stockByWarehouse.map((stock) => (
                                    <div
                                        key={stock.warehouseId}
                                        className="flex flex-col gap-3 rounded-none border border-border/60 bg-background/60 p-4 sm:flex-row sm:items-center sm:justify-between"
                                    >
                                        <div className="space-y-1">
                                            <div className="flex flex-wrap items-center gap-2">
                                                <span className="font-medium">
                                                    {stock.warehouseName}
                                                </span>
                                                <Badge variant="outline">
                                                    {stock.warehouseCode}
                                                </Badge>
                                            </div>
                                            <p className="text-sm text-muted-foreground">
                                                {stock.availableUnits} units
                                                available
                                            </p>
                                        </div>
                                        <ReserveButton
                                            productId={product.id}
                                            warehouseId={stock.warehouseId}
                                            disabled={stock.availableUnits < 1}
                                        />
                                    </div>
                                ))}
                            </div>
                        </CardContent>
                    </Card>
                ))}
            </div>
        </main>
    );
}
