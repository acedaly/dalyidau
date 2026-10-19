// A measurement over time (river level, temperature, Kp, air quality), drawn after mount with
// Recharts and Untitled UI's chart tooltip, with the same values in an accessible table. Observed
// values only: nothing is forecast, smoothed or extrapolated.
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ChartTooltipContent } from "@/components/application/charts/charts-base";
import { Skeleton } from "@/portal/components/empty";
import { useMounted } from "@/portal/hooks/use-mounted";
import { formatDate } from "@/portal/lib/format";
import { TZ } from "./shared";

const time = (iso: string) => formatDate(iso, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }, TZ);

export const SeriesChart = ({ points, label, unit, caption }: { points: { at: string; value: number }[]; label: string; unit: string; caption: string }) => {
    const mounted = useMounted();
    const data = points.map((p) => ({ t: Date.parse(p.at), at: p.at, value: p.value }));
    return (
        <figure className="flex flex-col gap-2">
            <div className="h-56 w-full" aria-hidden="true">
                {mounted ? (
                    <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -8 }} accessibilityLayer={false}>
                            <CartesianGrid vertical={false} stroke="var(--color-border-secondary)" />
                            <XAxis
                                dataKey="t"
                                type="number"
                                scale="time"
                                domain={["dataMin", "dataMax"]}
                                tickLine={false}
                                axisLine={false}
                                tick={{ fontSize: 12, fill: "var(--color-text-tertiary)" }}
                                tickFormatter={(value: number) => formatDate(new Date(value).toISOString(), { day: "numeric", month: "short" }, TZ)}
                                minTickGap={32}
                            />
                            <YAxis
                                tickLine={false}
                                axisLine={false}
                                tick={{ fontSize: 12, fill: "var(--color-text-tertiary)" }}
                                width={56}
                                domain={["auto", "auto"]}
                            />
                            <Tooltip
                                content={<ChartTooltipContent />}
                                labelFormatter={(value) => time(new Date(Number(value)).toISOString())}
                                formatter={(value) => [`${value}${unit ? ` ${unit}` : ""}`, label]}
                                cursor={{ stroke: "var(--color-border-primary)", strokeWidth: 1 }}
                            />
                            <Line
                                type="linear"
                                dataKey="value"
                                name={label}
                                stroke="var(--chart-series)"
                                strokeWidth={2}
                                dot={false}
                                activeDot={{ r: 4 }}
                                isAnimationActive={false}
                            />
                        </LineChart>
                    </ResponsiveContainer>
                ) : (
                    <Skeleton className="size-full" />
                )}
            </div>
            <figcaption className="text-xs text-tertiary">{caption}</figcaption>
            {/* A table won't shrink to sr-only's 1px, so the wrapper is the hidden box. */}
            <div className="sr-only">
                <table>
                    <caption>{caption}</caption>
                    <thead>
                        <tr>
                            <th scope="col">Observed</th>
                            <th scope="col">
                                {label}
                                {unit ? ` (${unit})` : ""}
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {/* The most recent 48 readings: enough to read the trend without a page-long table. */}
                        {points.slice(-48).map((p) => (
                            <tr key={p.at}>
                                <td>{time(p.at)}</td>
                                <td>{p.value}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </figure>
    );
};
