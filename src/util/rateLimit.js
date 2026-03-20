'use strict';

const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW || '30000', 10);
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '20', 10);
const rateState = new Map();

function rateLimitOk(key) {
  const now = Date.now();
  const cur = rateState.get(key);
  if (!cur || now - cur.ts > RATE_LIMIT_WINDOW_MS) {
    rateState.set(key, { ts: now, count: 1 });
    return true;
  }
  if (cur.count >= RATE_LIMIT_MAX) return false;
  cur.count += 1;
  return true;
}

module.exports = { rateLimitOk };
