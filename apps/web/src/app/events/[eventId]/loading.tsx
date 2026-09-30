import { SeatMapSkeleton } from '../../../components/seat-map/seat-map-skeleton';
import { Skeleton } from '../../../components/ui/skeleton';

export default function EventDetailLoading(): React.JSX.Element {
  return (
    <div className="space-y-8">
      <Skeleton className="h-40 w-full rounded-xl sm:h-56" />
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          <Skeleton className="h-6 w-40" />
          <SeatMapSkeleton />
        </div>
        <Skeleton className="h-32 w-full rounded-xl" />
      </div>
    </div>
  );
}
