import * as React from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "rounded-2xl border border-border/80 bg-card text-card-foreground shadow-[0_2px_10px_rgba(0,0,0,0.02)]",
        className,
      )}
      {...props}
    />
  ),
);
Card.displayName = "Card";

export const CardHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col gap-1 p-5 pb-3", className)} {...props} />
);
export const CardTitle = ({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
  <h3 className={cn("text-base font-semibold tracking-tight text-foreground", className)} {...props} />
);
export const CardDescription = ({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => (
  <p className={cn("text-sm text-muted-foreground", className)} {...props} />
);
export const CardContent = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("p-5 pt-0", className)} {...props} />
);

export function Separator({ className }: { className?: string }) {
  return <div className={cn("h-px w-full bg-border", className)} />;
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground"
    >
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
      {label}…
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border p-10 text-center"
    >
      <p className="text-sm font-medium">{title}</p>
      {description ? <p className="max-w-md text-sm text-muted-foreground">{description}</p> : null}
      {action}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    // `alert` so a screen-reader user is actually told the content became an
    // error. Without a live region the swap is silent.
    <div
      role="alert"
      className="flex flex-col items-center justify-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-10 text-center"
    >
      <p className="text-sm font-medium text-destructive">Something went wrong</p>
      <p className="max-w-md text-sm text-muted-foreground">{message}</p>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The three states a list can be in, resolved in one place.
 *
 * Pages used to check `isLoading` and then `items.length === 0`, so a failed
 * request fell into the empty branch and told the user they had no work when
 * the truth was that the request did not come back. `ErrorState` is now
 * checked before `EmptyState`, which is the only ordering that can tell those
 * two apart.
 */
export function AsyncBoundary({
  isLoading,
  error,
  isEmpty,
  loadingLabel,
  emptyTitle,
  emptyDescription,
  emptyAction,
  onRetry,
}: {
  isLoading: boolean;
  error: unknown;
  isEmpty: boolean;
  loadingLabel: string;
  emptyTitle: string;
  emptyDescription?: string;
  emptyAction?: React.ReactNode;
  onRetry?: () => void;
}) {
  if (isLoading) return <Spinner label={loadingLabel} />;
  if (error) {
    const message =
      error instanceof Error && error.message ? error.message : "Could not load this.";
    return <ErrorState message={message} onRetry={onRetry} />;
  }
  if (isEmpty) {
    return (
      <EmptyState title={emptyTitle} description={emptyDescription} action={emptyAction} />
    );
  }
  return null;
}