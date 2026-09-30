'use client';

import { useCallback, useEffect, useState } from 'react';

import { Card } from '../../components/ui/card';
import { EmptyState } from '../../components/ui/empty-state';
import { Skeleton } from '../../components/ui/skeleton';
import { useToast } from '../../components/ui/toast';
import { getAnalyticsSummary } from '../../lib/api/endpoints/analytics';
import { handleApiError } from '../../lib/api/handle-error';
import { formatMinor } from '../../lib/api/money';

import type { AnalyticsSummary } from '../../lib/api/types';

function DashboardLoading(): React.JSX.Element {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-28 w-full rounded-xl" />
      ))}
    </div>
  );
}

function formatEventLabel(status: string): string {
  return status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, ' ');
}

export default function AdminDashboardPage(): React.JSX.Element {
  const { toast } = useToast();
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);

  const load = useCallback(async () => {
    try {
      setSummary(await getAnalyticsSummary());
    } catch (err) {
      handleApiError(err, { toast });
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  if (summary === null) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-fg">Dashboard</h1>
        <DashboardLoading />
      </div>
    );
  }

  const eventEntries = Object.entries(summary.eventCounts);
  const revenueEntries = Object.entries(summary.revenueMinorByCurrency);
  const hasAnyData = eventEntries.length > 0 || revenueEntries.length > 0;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-fg">Dashboard</h1>

      {!hasAnyData ? (
        <EmptyState
          title="No activity yet"
          description="Once events are published and orders come in, summary metrics appear here."
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <Card className="p-5">
            <h2 className="text-sm font-semibold text-fg-muted">Event counts</h2>
            {eventEntries.length === 0 ? (
              <p className="mt-3 text-sm text-fg-subtle">No activity yet.</p>
            ) : (
              <dl className="mt-3 space-y-2">
                {eventEntries.map(([status, count]) => (
                  <div key={status} className="flex items-center justify-between text-sm">
                    <dt className="text-fg-muted">{formatEventLabel(status)}</dt>
                    <dd className="tnum font-semibold text-fg">{count}</dd>
                  </div>
                ))}
              </dl>
            )}
          </Card>

          <Card className="p-5">
            <h2 className="text-sm font-semibold text-fg-muted">Revenue by currency</h2>
            {revenueEntries.length === 0 ? (
              <p className="mt-3 text-sm text-fg-subtle">No paid orders yet.</p>
            ) : (
              <dl className="mt-3 space-y-2">
                {revenueEntries.map(([currency, minor]) => (
                  <div key={currency} className="flex items-center justify-between text-sm">
                    <dt className="text-fg-muted">{currency}</dt>
                    <dd className="tnum font-semibold text-fg">{formatMinor(minor, currency)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
