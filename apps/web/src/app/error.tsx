'use client';

import { Button } from '../components/ui/button';
import { errorCopyFor, isApiError } from '../lib/api/errors';

// error.tsx MUST be a Client Component -- Next.js requirement, since it
// needs to catch render errors and offer a `reset()` handler wired to a
// client event (the retry button).
//
// Finishes the TODO the Phase 1 placeholder left: never render
// `error.message` directly for an arbitrary thrown error (a real bug's
// stack-trace-derived message could leak internals) -- only an ApiError
// gets its message shown, and only via `errorCopyFor`, which is the same
// safe, code-keyed lookup every other error surface in this app uses.
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  const description = isApiError(error)
    ? errorCopyFor(error)
    : "We hit an unexpected error. If this keeps happening, let us know.";

  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 text-center">
      <h2 className="text-lg font-semibold text-fg">Something went wrong.</h2>
      <p className="max-w-sm text-sm text-fg-muted">{description}</p>
      {isApiError(error) && error.requestId && (
        <p className="font-mono text-xs text-fg-subtle">ref: {error.requestId}</p>
      )}
      <Button onClick={() => reset()}>Try again</Button>
    </div>
  );
}
