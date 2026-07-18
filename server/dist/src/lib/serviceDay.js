/**
 * A restaurant's "day" is not midnight-to-midnight: an order taken at 01:30
 * belongs to the evening that just happened, not to the morning that just began.
 * Everything the kitchen and the till care about keys off this, not the date.
 */
const CUTOFF_HOUR = Number(process.env.SERVICE_DAY_CUTOFF_HOUR ?? 5);
export function serviceDayOf(date = new Date()) {
    const d = new Date(date);
    if (d.getHours() < CUTOFF_HOUR)
        d.setDate(d.getDate() - 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}
export function isServiceDay(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(value);
}
