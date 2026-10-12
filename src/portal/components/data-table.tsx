// The portal's reusable table: Untitled UI's Table and TableCard with client-side search, sorting,
// selection, bulk actions and pagination. Wedding data sets are small (hundreds of rows), so pages
// load everything once and this component does the rest in the browser.
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { SearchLg, XClose } from "@untitledui/icons";
import type { Selection, SortDescriptor } from "react-aria-components";
import { PaginationCardMinimal } from "@/components/application/pagination/pagination";
import { Table, TableCard } from "@/components/application/table/table";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { cx } from "@/utils/cx";

export interface DataColumn<T> {
    id: string;
    label: string;
    render: (row: T) => ReactNode;
    /** Enables sorting on this column. */
    sortValue?: (row: T) => string | number | null | undefined;
    /** The column that names the row for assistive technology. Exactly one column should set this. */
    isRowHeader?: boolean;
    tooltip?: string;
    /** Applied to both the header and the cells, e.g. "max-md:hidden". */
    className?: string;
}

interface DataTableProps<T extends { id: string }> {
    title: string;
    description?: string;
    rows: T[];
    columns: DataColumn<T>[];
    /** Text the search box matches against. Omit to hide search. */
    searchText?: (row: T) => string;
    searchPlaceholder?: string;
    /** Filter controls shown under the header. */
    filters?: ReactNode;
    /** Number of active filters, used to offer "Clear filters" on the no-results state. */
    activeFilterCount?: number;
    onClearFilters?: () => void;
    /** Buttons in the card header. */
    actions?: ReactNode;
    selectable?: boolean;
    /** Rendered in a bar above the table while rows are selected. */
    bulkActions?: (selectedIds: string[], clearSelection: () => void) => ReactNode;
    onRowAction?: (row: T) => void;
    /** Shown when there are no rows at all. */
    emptyState: ReactNode;
    initialSort?: SortDescriptor;
    pageSize?: number;
    size?: "sm" | "md";
    className?: string;
}

const compare = (a: unknown, b: unknown) => {
    if (a === b) return 0;
    if (a === null || a === undefined || a === "") return 1;
    if (b === null || b === undefined || b === "") return -1;
    if (typeof a === "number" && typeof b === "number") return a - b;
    return String(a).localeCompare(String(b), "en-AU", { sensitivity: "base", numeric: true });
};

export function DataTable<T extends { id: string }>({
    title,
    description,
    rows,
    columns,
    searchText,
    searchPlaceholder = "Search",
    filters,
    activeFilterCount = 0,
    onClearFilters,
    actions,
    selectable = false,
    bulkActions,
    onRowAction,
    emptyState,
    initialSort,
    pageSize: initialPageSize = 25,
    size = "md",
    className,
}: DataTableProps<T>) {
    const [query, setQuery] = useState("");
    const [sort, setSort] = useState<SortDescriptor | undefined>(initialSort);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(initialPageSize);
    const [selection, setSelection] = useState<Selection>(new Set());

    const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase();
        const matched = needle && searchText ? rows.filter((row) => searchText(row).toLowerCase().includes(needle)) : rows;
        const column = sort && columns.find((c) => c.id === sort.column);
        if (!column?.sortValue) return matched;
        const sorted = [...matched].sort((a, b) => compare(column.sortValue!(a), column.sortValue!(b)));
        return sort?.direction === "descending" ? sorted.reverse() : sorted;
    }, [rows, query, searchText, sort, columns]);

    const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
    const currentPage = Math.min(page, totalPages);
    const visible = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);

    // Drop selected ids that no longer exist (deleted, or filtered out by a refresh).
    useEffect(() => {
        if (selection === "all") return;
        const ids = new Set(rows.map((r) => r.id));
        if ([...selection].some((key) => !ids.has(String(key)))) setSelection(new Set([...selection].filter((key) => ids.has(String(key)))));
    }, [rows, selection]);

    const selectedIds = selection === "all" ? filtered.map((r) => r.id) : [...selection].map(String);
    const clearSelection = () => setSelection(new Set());
    const hasRows = rows.length > 0;
    const filtering = query.trim() !== "" || activeFilterCount > 0;

    return (
        <TableCard.Root size={size} className={className}>
            <TableCard.Header
                title={title}
                badge={hasRows ? (filtering ? `${filtered.length} of ${rows.length}` : String(rows.length)) : undefined}
                description={description}
                contentTrailing={
                    (searchText || actions) && (
                        <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-center md:w-auto">
                            {searchText && hasRows && (
                                <Input
                                    aria-label={searchPlaceholder}
                                    placeholder={searchPlaceholder}
                                    icon={SearchLg}
                                    size="sm"
                                    value={query}
                                    onChange={(value) => {
                                        setQuery(value);
                                        setPage(1);
                                    }}
                                    className="sm:w-64"
                                    type="search"
                                />
                            )}
                            {actions}
                        </div>
                    )
                }
            />

            {filters && hasRows && <div className="flex flex-wrap items-end gap-3 border-b border-secondary px-4 py-3 md:px-6">{filters}</div>}

            {selectable && selectedIds.length > 0 && bulkActions && (
                <div
                    className="flex flex-wrap items-center gap-3 border-b border-secondary bg-secondary px-4 py-2.5 md:px-6"
                    role="region"
                    aria-label="Bulk actions"
                >
                    <p className="text-sm font-semibold text-secondary">{selectedIds.length} selected</p>
                    <div className="flex flex-wrap items-center gap-2">{bulkActions(selectedIds, clearSelection)}</div>
                    <Button size="sm" color="link-gray" iconLeading={XClose} onClick={clearSelection} className="ml-auto">
                        Clear selection
                    </Button>
                </div>
            )}

            {!hasRows ? (
                <div className="px-4 py-10 md:px-6">{emptyState}</div>
            ) : filtered.length === 0 ? (
                <div className="flex flex-col items-center gap-3 px-4 py-12 text-center md:px-6">
                    <p className="text-md font-semibold text-primary">No matches</p>
                    <p className="text-sm text-tertiary">Nothing matches your search{activeFilterCount ? " and filters" : ""}.</p>
                    <div className="flex gap-3">
                        {query && (
                            <Button size="sm" color="secondary" onClick={() => setQuery("")}>
                                Clear search
                            </Button>
                        )}
                        {activeFilterCount > 0 && onClearFilters && (
                            <Button size="sm" color="secondary" onClick={onClearFilters}>
                                Clear filters
                            </Button>
                        )}
                    </div>
                </div>
            ) : (
                <>
                    <Table
                        aria-label={title}
                        size={size}
                        selectionMode={selectable ? "multiple" : "none"}
                        selectionBehavior="toggle"
                        selectedKeys={selection}
                        onSelectionChange={setSelection}
                        sortDescriptor={sort}
                        onSortChange={(next) => {
                            setSort(next);
                            setPage(1);
                        }}
                        onRowAction={onRowAction ? (key) => onRowAction(rows.find((r) => r.id === key)!) : undefined}
                    >
                        <Table.Header>
                            {columns.map((column) => (
                                <Table.Head
                                    key={column.id}
                                    id={column.id}
                                    label={column.label}
                                    tooltip={column.tooltip}
                                    allowsSorting={!!column.sortValue}
                                    isRowHeader={column.isRowHeader}
                                    className={column.className}
                                />
                            ))}
                        </Table.Header>
                        <Table.Body items={visible}>
                            {(row) => (
                                <Table.Row id={row.id} className={cx(onRowAction && "cursor-pointer")}>
                                    {columns.map((column) => (
                                        <Table.Cell key={column.id} className={column.className}>
                                            {column.render(row)}
                                        </Table.Cell>
                                    ))}
                                </Table.Row>
                            )}
                        </Table.Body>
                    </Table>
                    {filtered.length > 10 && (
                        <PaginationCardMinimal
                            page={currentPage}
                            total={totalPages}
                            pageSize={pageSize}
                            align="center"
                            onPageChange={setPage}
                            onPageSizeChange={(next) => {
                                setPageSize(next);
                                setPage(1);
                            }}
                        />
                    )}
                </>
            )}
        </TableCard.Root>
    );
}
