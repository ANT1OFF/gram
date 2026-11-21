import { ArrowDown, ArrowUp } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/** One column of a `DataTable`. */
export interface DataTableColumn<T> {
  /** Stable among the table's columns; the sort names it. */
  readonly id: string;
  /** The header's words. */
  readonly header: string;
  /** What a row shows in this column. */
  readonly cell: (row: T) => ReactNode;
  /** What the column sorts by; a column without it cannot be sorted. */
  readonly sortValue?: (row: T) => string | number | undefined;
  /** `end` for figures: the header and cells line up on the right, in tabular numbers. */
  readonly align?: "start" | "end";
  /** A CSS width for the column, such as `8rem`; the rest share what is left. */
  readonly width?: string;
  /** Left out on a phone, where the first columns matter most. */
  readonly hideOnPhone?: boolean;
}

export interface DataTableSort {
  readonly column: string;
  readonly direction: "asc" | "desc";
}

export interface DataTableProps<T> {
  /** The table's name for a screen reader. */
  label: string;
  columns: readonly DataTableColumn<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  /** The sort, for a table you keep it of yourself; with `onSortChange`. */
  sort?: DataTableSort;
  onSortChange?: (sort: DataTableSort) => void;
  /** The sort it starts with when you don't keep it. */
  defaultSort?: DataTableSort;
  /** Called when a row is clicked or opened with Enter: the row reads as one control. */
  onRowOpen?: (row: T) => void;
  /** The row that is open beside the table, drawn as chosen. */
  selectedKey?: string;
  /** What shows in place of the rows when there are none. */
  empty?: ReactNode;
  /** A height for the table's own scroll, with its header kept in view; the page scrolls otherwise. */
  maxHeight?: string;
  className?: string;
  testId?: string;
}

const compare = (a: string | number | undefined, b: string | number | undefined) => {
  if (a === undefined) return b === undefined ? 0 : 1;
  if (b === undefined) return -1;
  return typeof a === "number" && typeof b === "number"
    ? a - b
    : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
};

/**
 * A table of records with headers that sort it: dense rows in UI text, figures on the right in
 * tabular numbers, the header kept in view while it scrolls, and rows that open with a click or
 * Enter. Sorting keeps rows whose value is missing at the end either way.
 */
export function DataTable<T>({
  label,
  columns,
  rows,
  rowKey,
  sort,
  onSortChange,
  defaultSort,
  onRowOpen,
  selectedKey,
  empty,
  maxHeight,
  className,
  testId,
}: DataTableProps<T>) {
  const [own, setOwn] = useState<DataTableSort | undefined>(defaultSort);
  const current = sort ?? own;
  const column = columns.find((each) => each.id === current?.column);
  const sorted =
    column?.sortValue === undefined || current === undefined
      ? rows
      : rows.toSorted((a, b) => {
          const left = column.sortValue!(a);
          const right = column.sortValue!(b);
          if (left === undefined || right === undefined) return compare(left, right);
          const order = compare(left, right);
          return current.direction === "asc" ? order : -order;
        });
  const sortBy = (id: string) => {
    const next: DataTableSort =
      current?.column === id
        ? { column: id, direction: current.direction === "asc" ? "desc" : "asc" }
        : { column: id, direction: "asc" };
    if (sort === undefined) setOwn(next);
    onSortChange?.(next);
  };
  const phone = (each: DataTableColumn<T>) => (each.hideOnPhone ? "phone:hidden" : undefined);
  const end = (each: DataTableColumn<T>) =>
    each.align === "end" ? "text-right tabular-nums" : "text-left";
  return (
    <div
      className={cn("overflow-auto rounded-lg border border-edge-group bg-card", className)}
      style={maxHeight === undefined ? undefined : { maxHeight }}
      data-testid={testId}
    >
      <table aria-label={label} className="w-full table-fixed border-collapse text-body">
        <colgroup>
          {columns.map((each) => (
            <col
              key={each.id}
              className={phone(each)}
              style={each.width === undefined ? undefined : { width: each.width }}
            />
          ))}
        </colgroup>
        <thead className="sticky top-0 z-10 bg-card">
          <tr className="border-b border-border">
            {columns.map((each) => {
              const sorting = current?.column === each.id ? current.direction : undefined;
              return (
                <th
                  key={each.id}
                  scope="col"
                  aria-sort={
                    sorting === undefined
                      ? undefined
                      : sorting === "asc"
                        ? "ascending"
                        : "descending"
                  }
                  className={cn(
                    "px-3 py-2 text-meta font-normal text-muted-foreground",
                    end(each),
                    phone(each),
                  )}
                >
                  {each.sortValue === undefined ? (
                    each.header
                  ) : (
                    <button
                      type="button"
                      onClick={() => sortBy(each.id)}
                      className={cn(
                        "inline-flex max-w-full items-center gap-1 rounded-(--radius-sm) outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                        sorting !== undefined && "text-foreground",
                        each.align === "end" && "flex-row-reverse",
                      )}
                    >
                      <span className="truncate">{each.header}</span>
                      {sorting === "asc" && <ArrowUp aria-hidden className="size-3 shrink-0" />}
                      {sorting === "desc" && <ArrowDown aria-hidden className="size-3 shrink-0" />}
                    </button>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 && empty !== undefined ? (
            <tr>
              <td colSpan={columns.length} className="px-3 py-4">
                {empty}
              </td>
            </tr>
          ) : (
            sorted.map((row) => {
              const key = rowKey(row);
              return (
                <tr
                  key={key}
                  data-testid="data-table-row"
                  aria-selected={selectedKey === undefined ? undefined : selectedKey === key}
                  tabIndex={onRowOpen === undefined ? undefined : 0}
                  onClick={onRowOpen === undefined ? undefined : () => onRowOpen(row)}
                  onKeyDown={
                    onRowOpen === undefined
                      ? undefined
                      : (event) => {
                          if (event.key === "Enter") onRowOpen(row);
                        }
                  }
                  className={cn(
                    "border-b border-border/60 last:border-b-0",
                    onRowOpen !== undefined &&
                      "cursor-pointer outline-none hover:bg-accent focus-visible:bg-accent",
                    selectedKey === key && "bg-accent",
                  )}
                >
                  {columns.map((each) => (
                    <td
                      key={each.id}
                      className={cn("truncate px-3 py-1.5 align-middle", end(each), phone(each))}
                    >
                      {each.cell(row)}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
