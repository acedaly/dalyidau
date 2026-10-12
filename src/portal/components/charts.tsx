// Reporting charts for the portal.
//
// AttendanceBars is plain HTML: a stacked bar per row (attending, declined, and the unanswered
// remainder left as the empty track), with a legend, direct labels and an accessible table, so it
// server-renders and reads without colour. TrendChart uses Recharts with Untitled UI's chart tooltip
// and renders after mount, because Recharts measures its container in the browser.
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ChartTooltipContent } from "@/components/application/charts/charts-base";
import { Skeleton } from "@/portal/components/empty";
import { useMounted } from "@/portal/hooks/use-mounted";
import { formatDate, formatNumber, percent } from "@/portal/lib/format";

export interface AttendanceRow {
    label: string;
    invited: number;
    attending: number;
    declined: number;
}

const Legend = () => (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-tertiary" aria-hidden="true">
        <li className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full bg-(--chart-attending)" /> Attending
        </li>
        <li className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full bg-(--chart-declined)" /> Declined
        </li>
        <li className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full bg-quaternary" /> Awaiting reply
        </li>
    </ul>
);

export const AttendanceBars = ({ rows, caption }: { rows: AttendanceRow[]; caption: string }) => (
    <figure className="flex flex-col gap-4">
        <Legend />
        <ul className="flex flex-col gap-4" aria-hidden="true">
            {rows.map((row) => {
                const pending = Math.max(row.invited - row.attending - row.declined, 0);
                const title = `${row.label}: ${row.attending} attending, ${row.declined} declined, ${pending} awaiting of ${row.invited} invited`;
                return (
                    <li key={row.label} className="flex flex-col gap-1.5" title={title}>
                        <div className="flex items-baseline justify-between gap-3 text-sm">
                            <span className="truncate font-medium text-secondary">{row.label}</span>
                            <span className="shrink-0 text-tertiary tabular-nums">
                                <span className="font-semibold text-primary">{formatNumber(row.attending)}</span> attending · {formatNumber(row.declined)}{" "}
                                declined · {formatNumber(pending)} awaiting
                            </span>
                        </div>
                        <div className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-quaternary">
                            {row.attending > 0 && (
                                <div className="h-full rounded-l-full bg-(--chart-attending)" style={{ width: `${percent(row.attending, row.invited)}%` }} />
                            )}
                            {row.declined > 0 && (
                                <div
                                    className={row.attending > 0 ? "h-full bg-(--chart-declined)" : "h-full rounded-l-full bg-(--chart-declined)"}
                                    style={{ width: `${percent(row.declined, row.invited)}%` }}
                                />
                            )}
                        </div>
                    </li>
                );
            })}
        </ul>
        <table className="sr-only">
            <caption>{caption}</caption>
            <thead>
                <tr>
                    <th scope="col">Event</th>
                    <th scope="col">Invited</th>
                    <th scope="col">Attending</th>
                    <th scope="col">Declined</th>
                    <th scope="col">Awaiting reply</th>
                </tr>
            </thead>
            <tbody>
                {rows.map((row) => (
                    <tr key={row.label}>
                        <th scope="row">{row.label}</th>
                        <td>{row.invited}</td>
                        <td>{row.attending}</td>
                        <td>{row.declined}</td>
                        <td>{Math.max(row.invited - row.attending - row.declined, 0)}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    </figure>
);

export const TrendChart = ({ points, label, caption }: { points: { date: string; value: number }[]; label: string; caption: string }) => {
    const mounted = useMounted();
    return (
        <figure className="flex flex-col gap-2">
            <div className="h-48 w-full" aria-hidden="true">
                {mounted ? (
                    <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                            <defs>
                                <linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="0%" stopColor="var(--chart-series)" stopOpacity={0.25} />
                                    <stop offset="100%" stopColor="var(--chart-series)" stopOpacity={0} />
                                </linearGradient>
                            </defs>
                            <CartesianGrid vertical={false} stroke="var(--color-border-secondary)" />
                            <XAxis
                                dataKey="date"
                                tickLine={false}
                                axisLine={false}
                                tick={{ fontSize: 12, fill: "var(--color-text-tertiary)" }}
                                tickFormatter={(value: string) => formatDate(value, { day: "numeric", month: "short" })}
                                minTickGap={24}
                            />
                            <YAxis
                                allowDecimals={false}
                                tickLine={false}
                                axisLine={false}
                                tick={{ fontSize: 12, fill: "var(--color-text-tertiary)" }}
                                width={48}
                            />
                            <Tooltip
                                content={<ChartTooltipContent />}
                                labelFormatter={(value) => formatDate(String(value))}
                                formatter={(value) => [formatNumber(Number(value)), label]}
                                cursor={{ stroke: "var(--color-border-primary)", strokeWidth: 1 }}
                            />
                            <Area
                                type="monotone"
                                dataKey="value"
                                name={label}
                                stroke="var(--chart-series)"
                                strokeWidth={2}
                                fill="url(#trend-fill)"
                                activeDot={{ r: 5 }}
                            />
                        </AreaChart>
                    </ResponsiveContainer>
                ) : (
                    <Skeleton className="size-full" />
                )}
            </div>
            <table className="sr-only">
                <caption>{caption}</caption>
                <thead>
                    <tr>
                        <th scope="col">Date</th>
                        <th scope="col">{label}</th>
                    </tr>
                </thead>
                <tbody>
                    {points.map((p) => (
                        <tr key={p.date}>
                            <td>{formatDate(p.date)}</td>
                            <td>{p.value}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </figure>
    );
};
