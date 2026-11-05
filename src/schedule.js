const WEEK = 7 * 24 * 60 * 60 * 1000;

/** Return the scheduled instants after the checkpoint and through now. */
export function occurrences(schedule, checkpoint, now) {
  const first = Date.parse(schedule.firstAt);
  const after = Date.parse(checkpoint);
  const until = Date.parse(now);
  if (![first, after, until].every(Number.isFinite) || after > until) {
    throw new TypeError('Waktu jadwal tidak valid');
  }
  if (!['once', 'weekly'].includes(schedule.repeat)) {
    throw new TypeError('Pengulangan tidak valid');
  }
  if (schedule.repeat === 'once') {
    return first > after && first <= until ? [new Date(first).toISOString()] : [];
  }
  const start = Math.max(0, Math.floor((after - first) / WEEK) + 1);
  const end = Math.floor((until - first) / WEEK);
  const result = [];
  for (let n = start; n <= end; n++) result.push(new Date(first + n * WEEK).toISOString());
  return result;
}

/** Interpret a local WIB date and time without relying on the server timezone. */
export function wibToIso(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) {
    throw new TypeError('Gunakan tanggal dan jam WIB yang valid');
  }
  const date = new Date(`${value}:00+07:00`);
  if (!Number.isFinite(date.getTime()) || new Date(date.getTime() + 7 * 3600000).toISOString().slice(0, 16) !== value) {
    throw new TypeError('Gunakan tanggal dan jam WIB yang valid');
  }
  return date.toISOString();
}
