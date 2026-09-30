'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { Button } from './ui/button';

interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
}

export function Pagination({ page, pageSize, total }: PaginationProps): React.JSX.Element | null {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  if (totalPages <= 1) return null;

  function goTo(nextPage: number): void {
    const params = new URLSearchParams(searchParams.toString());
    params.set('page', String(nextPage));
    router.push(`${pathname}?${params.toString()}`, { scroll: false });
  }

  return (
    <div className="flex items-center justify-center gap-3">
      <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => goTo(page - 1)}>
        Previous
      </Button>
      <span className="text-sm text-fg-muted">
        Page {page} of {totalPages}
      </span>
      <Button variant="secondary" size="sm" disabled={page >= totalPages} onClick={() => goTo(page + 1)}>
        Next
      </Button>
    </div>
  );
}
