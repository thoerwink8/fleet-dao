/** 某个时刻在指定时区（IANA 名）里的日历日期。 */
function calendarDate(at: Date, timeZone: string): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  })
    .formatToParts(at)
    .reduce<Record<string, number>>((acc, p) => {
      if (p.type === 'year' || p.type === 'month' || p.type === 'day') acc[p.type] = Number(p.value);
      return acc;
    }, {});
  return { y: parts.year as number, m: parts.month as number, d: parts.day as number };
}

/** 周几，0 是周日。 */
function weekdayOf(y: number, m: number, d: number): number {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** 某个时刻所在的那一周的周一，按指定时区的日历算，写成 YYYY-MM-DD。 */
export function weekStart(at: Date, timeZone: string): string {
  const { y, m, d } = calendarDate(at, timeZone);
  const back = (weekdayOf(y, m, d) + 6) % 7;
  return new Date(Date.UTC(y, m - 1, d - back)).toISOString().slice(0, 10);
}
