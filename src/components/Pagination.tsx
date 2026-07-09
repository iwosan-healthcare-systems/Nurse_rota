import { ChevronLeft, ChevronRight } from "lucide-react";

const PAGE_SIZES = [10, 20, 50] as const;

export function usePagination<T>(items: T[], pageSize: number, page: number) {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * pageSize;
  const pageItems = items.slice(start, start + pageSize);
  return { pageItems, totalPages, safePage };
}

interface PaginationProps {
  page: number;
  totalPages: number;
  pageSize: number;
  totalItems: number;
  onPage: (p: number) => void;
  onPageSize: (s: number) => void;
}

export function Pagination({
  page,
  totalPages,
  pageSize,
  totalItems,
  onPage,
  onPageSize,
}: PaginationProps) {
  if (totalItems === 0) return null;

  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, totalItems);

  // Build visible page numbers: always show first, last, current ±1, with "…" gaps.
  const pages: (number | "…")[] = [];
  const add = (n: number) => {
    if (!pages.includes(n)) pages.push(n);
  };
  add(1);
  if (page - 2 > 2) pages.push("…");
  for (let i = Math.max(2, page - 1); i <= Math.min(totalPages - 1, page + 1); i++) add(i);
  if (page + 2 < totalPages - 1) pages.push("…");
  if (totalPages > 1) add(totalPages);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-t text-sm text-muted-foreground">
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-xs">Rows per page:</span>
        <select
          value={pageSize}
          onChange={(e) => {
            onPageSize(Number(e.target.value));
            onPage(1);
          }}
          className="h-7 rounded-md border bg-card px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
        >
          {PAGE_SIZES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      <span className="text-xs tabular-nums">
        {start}–{end} of {totalItems}
      </span>

      <div className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          onClick={() => onPage(page - 1)}
          disabled={page === 1}
          aria-label="Previous page"
          className="h-7 w-7 grid place-items-center rounded-md border bg-card hover:bg-muted disabled:opacity-30"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        {pages.map((p, i) =>
          p === "…" ? (
            <span key={`ellipsis-${i}`} className="px-1 text-xs">
              …
            </span>
          ) : (
            <button
              key={p}
              type="button"
              onClick={() => onPage(p)}
              aria-current={p === page ? "page" : undefined}
              className={`h-7 min-w-7 px-2 rounded-md border text-xs font-medium ${
                p === page
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-card hover:bg-muted"
              }`}
            >
              {p}
            </button>
          ),
        )}
        <button
          type="button"
          onClick={() => onPage(page + 1)}
          disabled={page === totalPages}
          aria-label="Next page"
          className="h-7 w-7 grid place-items-center rounded-md border bg-card hover:bg-muted disabled:opacity-30"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
