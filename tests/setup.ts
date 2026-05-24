import "dotenv/config";

if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required to run integration tests");
}
if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    throw new Error(
        "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required to run integration tests",
    );
}
