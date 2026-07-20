/**
 * Login brute-force protection. Failures are counted per (IP, username) pair:
 * an attacker hammering one account gets blocked without locking out the
 * other waiters, and hammering from one machine cannot freeze the whole
 * venue. In-memory on purpose — a restart clearing the counters is fine,
 * and there is exactly one server process.
 */
const MAX_FAILURES = 5;
const BLOCK_MS = 15 * 60 * 1000;
const attempts = new Map();
function key(ip, username) {
    return `${ip}|${username.toLowerCase()}`;
}
function prune(now) {
    // Lazy cleanup keeps the map from growing unbounded over a long service.
    if (attempts.size < 1000)
        return;
    for (const [k, e] of attempts) {
        if (e.blockedUntil < now && now - e.lastFailure > BLOCK_MS)
            attempts.delete(k);
    }
}
export function isBlocked(ip, username) {
    const entry = attempts.get(key(ip, username));
    return !!entry && entry.blockedUntil > Date.now();
}
/** Returns true when this failure crossed the threshold and blocked the pair. */
export function recordFailure(ip, username) {
    const now = Date.now();
    prune(now);
    const k = key(ip, username);
    const entry = attempts.get(k) ?? { count: 0, blockedUntil: 0, lastFailure: 0 };
    // A stale streak starts over instead of punishing a typo from an hour ago.
    if (now - entry.lastFailure > BLOCK_MS)
        entry.count = 0;
    entry.count += 1;
    entry.lastFailure = now;
    if (entry.count >= MAX_FAILURES) {
        entry.blockedUntil = now + BLOCK_MS;
    }
    attempts.set(k, entry);
    return entry.blockedUntil > now;
}
export function clearFailures(ip, username) {
    attempts.delete(key(ip, username));
}
/** Test hook. */
export function resetLockouts() {
    attempts.clear();
}
