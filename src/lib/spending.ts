// Weekly spend aggregation for the dashboard trend (§8).

export interface WeekBucket {
  weekStart: Date;
  label: string;
  total: number;
}

/** Monday 00:00 (local) of the week containing `d`. */
export function mondayOf(d: Date): Date {
  const m = new Date(d);
  m.setHours(0, 0, 0, 0);
  m.setDate(m.getDate() - ((m.getDay() + 6) % 7));
  return m;
}

/**
 * Bucket trips into the last `weeks` calendar weeks (oldest → newest),
 * including empty weeks so the trend has a continuous x-axis.
 */
export function weeklyBuckets(
  trips: { date: Date; total: number }[],
  weeks = 12,
): WeekBucket[] {
  const thisMonday = mondayOf(new Date());

  const buckets: WeekBucket[] = [];
  const index = new Map<number, number>(); // weekStart time → buckets index
  for (let i = weeks - 1; i >= 0; i--) {
    const ws = new Date(thisMonday);
    ws.setDate(ws.getDate() - i * 7);
    index.set(ws.getTime(), buckets.length);
    buckets.push({
      weekStart: ws,
      label: `${ws.getDate()}/${ws.getMonth() + 1}`,
      total: 0,
    });
  }

  for (const t of trips) {
    const key = mondayOf(t.date).getTime();
    const at = index.get(key);
    if (at !== undefined) buckets[at].total += t.total;
  }

  return buckets;
}
