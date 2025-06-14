export const TOKEN_EXPIRY = 1000 * 60 * 15; // 15 minutes
export const RATE_LIMIT_WINDOW = 1000 * 60; // 1 minute
export const MAX_REQUESTS = 5;
export const RATE_LIMIT = new Map();

// Clean up old rate limit entries every minute
setInterval(() => {
    const now = Date.now();
    for (const [key, times] of RATE_LIMIT.entries()) {
        const recentTimes = times.filter(time => now - time < RATE_LIMIT_WINDOW);
        if (recentTimes.length === 0) {
            RATE_LIMIT.delete(key);
        } else {
            RATE_LIMIT.set(key, recentTimes);
        }
    }
}, 60000); // Run every minute 