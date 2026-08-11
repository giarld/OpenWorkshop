export type UsageRange = "1d" | "7d" | "30d";
export type ActivityDay = { date: string; count: number };

export function usageActivityCells(startDate: string, days: ActivityDay[], count = 371): ActivityDay[] {
  const values = new Map(days.map((day) => [day.date, day.count]));
  const start = localDate(startDate);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
    const key = dateKey(date);
    return { date: key, count: values.get(key) ?? 0 };
  });
}

export function usageActivityLevel(count: number, maximum: number): number {
  if (count <= 0 || maximum <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil(count / maximum * 4)));
}

export function usageMonthLabels(cells: ActivityDay[]): Array<{ label: string; week: number }> {
  const labels: Array<{ label: string; week: number }> = [];
  let previousMonth = -1;
  for (let index = 0; index < cells.length; index += 7) {
    const date = localDate(cells[index]!.date);
    if (date.getMonth() !== previousMonth) {
      labels.push({ label: `${date.getMonth() + 1}月`, week: index / 7 });
      previousMonth = date.getMonth();
    }
  }
  return labels;
}

export function formatUsageDuration(milliseconds: number): string {
  const totalMinutes = Math.max(0, Math.floor(milliseconds / 60_000));
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor(totalMinutes % 1_440 / 60);
  const minutes = totalMinutes % 60;
  return days ? `${days}天 ${hours}小时` : hours ? `${hours}小时 ${minutes}分钟` : `${minutes}分钟`;
}

export function usageSeriesLabel(start: string, range: UsageRange): string {
  const date = new Date(start);
  return range === "1d"
    ? `${String(date.getHours()).padStart(2, "0")}:00`
    : `${date.getMonth() + 1}/${date.getDate()}`;
}

function localDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year!, month! - 1, day!);
}

function dateKey(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}
