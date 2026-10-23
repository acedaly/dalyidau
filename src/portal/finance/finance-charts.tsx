// Money charts as plain HTML, so they server-render, read without colour (amounts are written next
// to every bar) and come with a table for assistive technology. Bars are drawn from integer cents;
// only their widths are proportions.
import { formatAud } from "@/shared/finance/money";

const share = (part: number, whole: number) => (whole > 0 ? Math.max(0, Math.min(100, (part / whole) * 100)) : 0);

const monthName = (month: string) =>
    new Intl.DateTimeFormat("en-AU", { month: "short", year: "2-digit", timeZone: "UTC" }).format(new Date(`${month}-15T00:00:00Z`));

export const MonthBars = ({ months, caption }: { months: { month: string; incomeCents: number; expenseCents: number }[]; caption: string }) => {
    const max = Math.max(1, ...months.flatMap((m) => [m.incomeCents, m.expenseCents]));
    return (
        <figure className="flex flex-col gap-4">
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-tertiary" aria-hidden="true">
                <li className="flex items-center gap-1.5">
                    <span className="size-2.5 rounded-full bg-(--chart-attending)" /> Income
                </li>
                <li className="flex items-center gap-1.5">
                    <span className="size-2.5 rounded-full bg-(--chart-series)" /> Spending
                </li>
            </ul>
            <ul className="flex flex-col gap-3" aria-hidden="true">
                {months.map((m) => (
                    <li key={m.month} className="grid grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-3">
                        <span className="text-sm font-medium text-secondary">{monthName(m.month)}</span>
                        <div className="flex flex-col gap-1">
                            {(
                                [
                                    ["income", m.incomeCents, "bg-(--chart-attending)"],
                                    ["spending", m.expenseCents, "bg-(--chart-series)"],
                                ] as const
                            ).map(([key, cents, colour]) => (
                                <div key={key} className="flex items-center gap-2">
                                    <div className="h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-quaternary">
                                        <div className={`h-full rounded-full ${colour}`} style={{ width: `${share(cents, max)}%` }} />
                                    </div>
                                    <span className="w-24 shrink-0 text-right text-xs text-tertiary tabular-nums">{formatAud(cents, { whole: true })}</span>
                                </div>
                            ))}
                        </div>
                    </li>
                ))}
            </ul>
            <table className="sr-only">
                <caption>{caption}</caption>
                <thead>
                    <tr>
                        <th scope="col">Month</th>
                        <th scope="col">Income</th>
                        <th scope="col">Spending</th>
                    </tr>
                </thead>
                <tbody>
                    {months.map((m) => (
                        <tr key={m.month}>
                            <th scope="row">{monthName(m.month)}</th>
                            <td>{formatAud(m.incomeCents)}</td>
                            <td>{formatAud(m.expenseCents)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </figure>
    );
};

export const CategoryBars = ({
    rows,
    totalCents,
    hrefFor,
}: {
    rows: { key: string; name: string; detail?: string | null; cents: number; count: number }[];
    totalCents: number;
    hrefFor: (key: string) => string;
}) => (
    <ul className="flex flex-col gap-3.5">
        {rows.map((row) => (
            <li key={row.key} className="flex flex-col gap-1.5">
                <div className="flex items-baseline justify-between gap-3 text-sm">
                    <a href={hrefFor(row.key)} className="min-w-0 truncate font-medium text-secondary hover:underline">
                        {row.name}
                        {row.detail && <span className="ml-1.5 font-normal text-tertiary">{row.detail}</span>}
                    </a>
                    <span className="shrink-0 text-tertiary tabular-nums">
                        <span className="font-semibold text-primary">{formatAud(row.cents)}</span> · {Math.round(share(row.cents, totalCents))}%
                    </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-quaternary" aria-hidden="true">
                    <div className="h-full rounded-full bg-(--chart-series)" style={{ width: `${share(row.cents, totalCents)}%` }} />
                </div>
            </li>
        ))}
    </ul>
);
