import { Skeleton } from '../ui/skeleton';

export function SeatMapSkeleton(): React.JSX.Element {
  return (
    <div className="space-y-6">
      {[0, 1].map((section) => (
        <div key={section} className="space-y-2">
          <Skeleton className="h-4 w-32" />
          <div className="flex flex-wrap gap-1.5">
            {Array.from({ length: 16 }).map((_, i) => (
              <Skeleton key={i} className="size-8 rounded-md" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
