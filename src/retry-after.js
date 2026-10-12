// RFC 9110 sections 5.6.7 / 10.2.3. No permissive Date.parse or unbounded integer conversion.
export const MAX_RETRY_AFTER_MS = 30000;
export const MAX_RETRY_AFTER_LENGTH = 128;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LONG_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function timestamp(year, month, day, hour, minute, second) {
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(hour, minute, Math.min(second, 59), 0);
  return date;
}

function httpDate(value, wallNow) {
  let match = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), ([0-9]{2}) ([A-Z][a-z]{2}) ([0-9]{4}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT$/.exec(value);
  let weekday, day, month, year, hour, minute, second, shortYear = false;
  if (match) [, weekday, day, month, year, hour, minute, second] = match;
  else {
    match = /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), ([0-9]{2})-([A-Z][a-z]{2})-([0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT$/.exec(value);
    if (match) {
      [, weekday, day, month, year, hour, minute, second] = match;
      weekday = DAYS[LONG_DAYS.indexOf(weekday)]; shortYear = true;
    } else {
      match = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) ([A-Z][a-z]{2}) ([0-9]{2}| [0-9]) ([0-9]{2}):([0-9]{2}):([0-9]{2}) ([0-9]{4})$/.exec(value);
      if (!match) return undefined;
      [, weekday, month, day, hour, minute, second, year] = match;
    }
  }
  [year, day, hour, minute, second] = [year, day, hour, minute, second].map(Number);
  month = MONTHS.indexOf(month);
  if (month < 0 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60 ||
      (second === 60 && (hour !== 23 || minute !== 59))) return undefined;
  if (shortYear) {
    const limit = new Date(wallNow);
    limit.setUTCFullYear(limit.getUTCFullYear() + 50);
    year += Math.floor(limit.getUTCFullYear() / 100) * 100;
    if (timestamp(year, month, day, hour, minute, second).getTime() + (second === 60 ? 1000 : 0) > limit.getTime()) year -= 100;
  }
  const date = timestamp(year, month, day, hour, minute, second);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day ||
      DAYS[date.getUTCDay()] !== weekday) return undefined;
  // A leap second is conservatively represented by the following UTC second.
  return date.getTime() + (second === 60 ? 1000 : 0);
}

// undefined = bounded fallback; Infinity = refuse, never clamp then retry.
// Examine raw headers so duplicate fields are not hidden by Node's deduplication.
export function retryAfter(rawHeaders, wallNow) {
  if (!Array.isArray(rawHeaders) || rawHeaders.length > 8192 || rawHeaders.length % 2 ||
      !Number.isFinite(wallNow) || !Number.isFinite(new Date(wallNow).getTime())) return Infinity;
  let value;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (typeof rawHeaders[i] !== 'string' || typeof rawHeaders[i + 1] !== 'string') return Infinity;
    if (rawHeaders[i].toLowerCase() !== 'retry-after') continue;
    if (value !== undefined) return Infinity;
    value = rawHeaders[i + 1];
  }
  if (value === undefined) return undefined;
  if (value.length > MAX_RETRY_AFTER_LENGTH) return Infinity;
  value = value.replace(/^[ \t]+|[ \t]+$/g, '');
  if (/^[0-9]+$/.test(value)) {
    const significant = value.replace(/^0+/, '') || '0';
    if (significant.length > 2 || Number(significant) > MAX_RETRY_AFTER_MS / 1000) return Infinity;
    return Number(significant) * 1000;
  }
  const date = httpDate(value, wallNow);
  // Unparseable comma-bearing values could be a coalesced list, not one date.
  if (date === undefined) return value.includes(',') ? Infinity : undefined;
  const delay = Math.max(0, date - wallNow);
  return delay > MAX_RETRY_AFTER_MS ? Infinity : delay;
}
