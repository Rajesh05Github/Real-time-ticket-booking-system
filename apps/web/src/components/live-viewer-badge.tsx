'use client';

import { useLiveViewerCount } from '../lib/hooks/use-live-viewer-count';

export function LiveViewerBadge({ eventId }: { eventId: string }): React.JSX.Element | null {
  const count = useLiveViewerCount(eventId);

  if (count === null) return null;

  return (
    <div className="inline-flex items-center gap-1.5 rounded-full border border-border-strong bg-surface-2 px-3 py-1 text-xs text-fg-muted">
      <span className="relative flex size-2">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-75" />
        <span className="relative inline-flex size-2 rounded-full bg-success" />
      </span>
      {count} watching now
    </div>
  );
}
