// Scheduling helpers for cron_spec strings.
export function nextRunFrom(now, cronSpec) {
  if (!cronSpec) return null;
  const spec = String(cronSpec).trim().toLowerCase();
  if (spec === 'hourly') return now + 60 * 60 * 1000;
  if (spec === 'daily') return now + 24 * 60 * 60 * 1000;
  if (spec === 'weekly') return now + 7 * 24 * 60 * 60 * 1000;
  const m = spec.match(/^\+(\d+)\s*([mhd])$/);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2];
    const ms = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
    return now + n * ms;
  }
  return null;
}
