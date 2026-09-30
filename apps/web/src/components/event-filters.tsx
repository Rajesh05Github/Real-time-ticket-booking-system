'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { Input } from './ui/field';

/** Debounced (350ms) search box writing into the URL's searchParams via
 * router.replace -- keeps the Server Component page re-rendering off the
 * URL (shareable/bookmarkable) rather than holding filter state only in
 * the client. `scroll: false` so paging through results doesn't jump the
 * viewport back to the top. */
export function EventFilters(): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [search, setSearch] = useState(searchParams.get('search') ?? '');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const params = new URLSearchParams(searchParams.toString());
      if (search) {
        params.set('search', search);
      } else {
        params.delete('search');
      }
      params.delete('page');
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    }, 350);
    return () => clearTimeout(debounceRef.current);
    // Intentionally NOT re-running on searchParams/router/pathname change, only on `search` --
    // otherwise every URL update this effect itself causes would immediately re-trigger it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  return (
    <div className="max-w-sm">
      <Input
        placeholder="Search events..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        aria-label="Search events"
      />
    </div>
  );
}
