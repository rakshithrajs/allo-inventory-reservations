import { redis } from "./redis";

const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

export async function withLock<T>(
    key: string,
    fn: () => Promise<T>,
    ttlMs = 5000,
): Promise<T> {
    const token = crypto.randomUUID();
    const acquired = await redis.set(key, token, { nx: true, px: ttlMs });
    if (!acquired) {
        throw { code: "LOCK_CONTENTION", status: 409, message: "Try again" };
    }
    try {
        return await fn();
    } finally {
        await redis.eval(RELEASE_SCRIPT, [key], [token]);
    }
}
