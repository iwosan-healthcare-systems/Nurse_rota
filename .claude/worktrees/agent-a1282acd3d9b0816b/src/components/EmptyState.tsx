import type { ReactNode } from "react";

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="text-center py-16 px-4 border-2 border-dashed border-border rounded-xl bg-card/50">
      {icon && (
        <div className="mx-auto h-12 w-12 grid place-items-center rounded-full bg-muted text-muted-foreground mb-4">
          {icon}
        </div>
      )}
      <h3 className="font-semibold">{title}</h3>
      {description && (
        <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
