/** Horizontal progress bar with an accessible name and value. */
export function ProgressBar({ label, percent }: { label: string; percent: number }) {
  const value = Math.min(100, Math.max(0, Math.round(percent)));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      className="h-2 w-full overflow-hidden rounded-full bg-sage-100"
    >
      <div className="h-full rounded-full bg-primary-600 transition-[width] duration-300" style={{ width: `${value}%` }} />
    </div>
  );
}
