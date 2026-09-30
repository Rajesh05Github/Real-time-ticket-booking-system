import Link from 'next/link';

import { Button } from '../components/ui/button';

export default function NotFound(): React.JSX.Element {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 text-center">
      <p className="font-mono text-5xl font-bold text-fg-subtle">404</p>
      <h2 className="text-lg font-semibold text-fg">We couldn&apos;t find that.</h2>
      <p className="max-w-sm text-sm text-fg-muted">
        The page or event you&apos;re looking for doesn&apos;t exist, or isn&apos;t public yet.
      </p>
      <Link href="/">
        <Button>Back to events</Button>
      </Link>
    </div>
  );
}
