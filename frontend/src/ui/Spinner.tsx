export function Spinner({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={`inline-block animate-spin rounded-full border-2 border-current border-r-transparent ${className}`}
    />
  );
}

export function FullPageSpinner() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-sage-50 text-primary-600">
      <Spinner className="h-10 w-10" />
    </div>
  );
}

export function SectionSpinner() {
  return (
    <div className="flex items-center justify-center py-16 text-primary-600">
      <Spinner className="h-8 w-8" />
    </div>
  );
}
