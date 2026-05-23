import { ApiError } from "@/server/http/errors";
import { redis } from "./redis";

const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

type WithLockOptions = {
    ttlMs?: number;
    maxWaitMs?: number;
    baseDelayMs?: number;
};

// Acquire a per-key NX lock with bounded retry. Contenders queue briefly via
// exponential backoff + jitter and only throw LOCK_CONTENTION after maxWaitMs.
// This converts "instant rejection" into "short wait then proceed", which
// matters when multiple legitimate users hit the same SKU within milliseconds.
export async function withLock<T>(
    key: string,
    fn: () => Promise<T>,
    options: WithLockOptions = {},
): Promise<T> {
    const ttlMs = options.ttlMs ?? 5000;
    const maxWaitMs = options.maxWaitMs ?? 1500;
    const baseDelayMs = options.baseDelayMs ?? 25;

    const token = crypto.randomUUID();
    const deadline = Date.now() + maxWaitMs;
    let attempt = 0;

    while (true) {
        const acquired = await redis.set(key, token, { nx: true, px: ttlMs });
        if (acquired) {
            try {
                return await fn();
            } finally {
                await redis.eval(RELEASE_SCRIPT, [key], [token]);
            }
        }

        if (Date.now() >= deadline) {
            throw new ApiError(
                "LOCK_CONTENTION",
                "Resource is busy, please retry",
                409,
            );
        }

        const delay = Math.min(
            baseDelayMs * 2 ** attempt + Math.random() * baseDelayMs,
            200,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        attempt += 1;
    }
}
