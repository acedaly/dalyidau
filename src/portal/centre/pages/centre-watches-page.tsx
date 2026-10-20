// Watch areas and alerts. A watch area is private to the person who made it: nobody else, an AI
// assistant or a wallboard ever sees its coordinates. Alerts are in the portal; email is opt-in per
// watch area and also needs the owner's switch and a provider.
import { useState } from "react";
import { Bell01, Edit05, Plus, Target04, Trash01 } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Input } from "@/components/base/input/input";
import { NativeSelect } from "@/components/base/select/select-native";
import { TextArea } from "@/components/base/textarea/textarea";
import { Toggle } from "@/components/base/toggle/toggle";
import { PortalDialog } from "@/portal/components/dialog";
import { Empty } from "@/portal/components/empty";
import { FormError } from "@/portal/components/form";
import { useToast } from "@/portal/components/toast";
import { Card } from "@/portal/knowledge/pages/knowledge-home-page";
import { ApiError, errorMessage } from "@/portal/lib/api";
import type { PageData } from "@/portal/lib/page-types";
import { usePortal } from "@/portal/portal-context";
import { CATEGORY_LABELS, HAZARD_CATEGORIES } from "@/shared/centre/sources";
import type { CentreAlert, WatchArea, WatchDefinition, WatchInput, WatchKind } from "@/shared/centre/types";
import { WATCH_KINDS, WATCH_KIND_LABELS } from "@/shared/centre/types";
import { centreApi } from "../centre-api";
import { JourneysCard } from "../journeys-card";
import { CENTRE, CentreHeader, CentreNotices, When } from "../shared";

const blank = (): WatchInput => ({
    name: "",
    definition: { kind: "point", lat: -33.87, lon: 151.21, radiusKm: 20, placeName: "" },
    fireDistrict: null,
    categories: [],
    minLevel: 0,
    notifyInApp: true,
    notifyEmail: false,
    quietStart: null,
    quietEnd: null,
    expiresAt: null,
    enabled: true,
});

const DEFAULTS: Record<WatchKind, WatchDefinition> = {
    point: { kind: "point", lat: -33.87, lon: 151.21, radiusKm: 20, placeName: "" },
    polygon: { kind: "polygon", ring: [] as never },
    region: { kind: "region", south: -34.2, west: 150.5, north: -33.4, east: 151.4 },
    fire_district: { kind: "fire_district", district: "" },
    gauge: { kind: "gauge", station: "" },
    corridor: { kind: "corridor", line: [] as never, bufferKm: 2 },
    incident: { kind: "incident", recordId: "" },
};

/** "lon, lat" per line ↔ positions. */
const toLines = (points: [number, number][]) => points.map(([x, y]) => `${x}, ${y}`).join("\n");
const fromLines = (text: string): [number, number][] =>
    text
        .split(/\n+/)
        .map((l) =>
            l
                .split(/[,\s]+/)
                .filter(Boolean)
                .map(Number),
        )
        .filter((p) => p.length === 2 && p.every(Number.isFinite))
        .map(([x, y]) => [x, y]);

/**
 * A number typed as text: the field keeps exactly what's typed (so "-" or "-33." can be typed on the
 * way to "-33.6") and passes on a number only once it is one. Text input, not type=number: phone
 * number pads have no minus sign, and south is negative.
 */
const NumField = ({ label, value, onChange, hint }: { label: string; value: number; onChange: (n: number) => void; hint?: string }) => {
    const [text, setText] = useState(Number.isFinite(value) ? String(value) : "");
    return (
        <Input
            label={label}
            value={text}
            hint={hint}
            onChange={(v) => {
                setText(v);
                const n = Number(v);
                if (v.trim() !== "" && Number.isFinite(n)) onChange(n);
            }}
        />
    );
};

const describe = (w: WatchArea) => {
    const d = w.definition;
    switch (d.kind) {
        case "point":
            return `${d.radiusKm} km around ${d.placeName || "a point"}`;
        case "polygon":
            return `An area of ${d.ring.length - 1} points`;
        case "region":
            return "A rectangular region";
        case "fire_district":
            return `Fire danger district: ${d.district}`;
        case "gauge":
            return `River gauge ${d.station}`;
        case "corridor":
            return `Route of ${d.line.length} points, ${d.bufferKm} km either side`;
        case "incident":
            return "One incident";
    }
};

const WatchForm = ({
    initial,
    districts,
    emailOn,
    onSaved,
    onClose,
}: {
    initial: WatchArea | null;
    districts: string[];
    emailOn: boolean;
    onSaved: (w: WatchArea) => void;
    onClose: () => void;
}) => {
    const toast = useToast();
    const [form, setForm] = useState<WatchInput>(() => (initial ? { ...initial } : blank()));
    const [linesText, setLinesText] = useState(() => {
        const d = initial?.definition;
        return d?.kind === "polygon" ? toLines(d.ring) : d?.kind === "corridor" ? toLines(d.line) : "";
    });
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const d = form.definition;
    const setDef = (patch: Partial<WatchDefinition>) => setForm((f) => ({ ...f, definition: { ...f.definition, ...patch } as WatchDefinition }));

    const save = async () => {
        setBusy(true);
        setError(null);
        let definition = form.definition;
        if (definition.kind === "polygon") {
            const ring = fromLines(linesText);
            if (ring.length && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])) ring.push(ring[0]);
            definition = { kind: "polygon", ring };
        }
        if (definition.kind === "corridor") definition = { ...definition, line: fromLines(linesText) };
        try {
            const body = { ...form, definition };
            const { watch } = initial ? await centreApi.updateWatch(initial.id, { ...body, version: initial.version }) : await centreApi.createWatch(body);
            toast.success(initial ? "Watch area saved" : "Watch area added");
            onSaved(watch);
        } catch (e) {
            setError(e instanceof ApiError ? e.message : errorMessage(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <PortalDialog
            isOpen
            onOpenChange={(open) => !open && onClose()}
            size="lg"
            title={initial ? "Edit watch area" : "Add a watch area"}
            description="Private to you. Its location is never shown to anyone else, an AI assistant or a wallboard."
            icon={Target04}
            onSubmit={(e) => {
                e.preventDefault();
                void save();
            }}
            footer={
                <>
                    <Button size="md" color="secondary" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button size="md" type="submit" isLoading={busy} showTextWhileLoading>
                        Save
                    </Button>
                </>
            }
        >
            <div className="flex flex-col gap-4">
                <FormError message={error} />
                <Input
                    label="Name"
                    value={form.name}
                    onChange={(name) => setForm((f) => ({ ...f, name }))}
                    isRequired
                    maxLength={80}
                    placeholder="e.g. Home, Mum's place, Weekend drive"
                />
                <NativeSelect
                    label="What to watch"
                    value={d.kind}
                    onChange={(e) => {
                        const kind = e.target.value as WatchKind;
                        setForm((f) => ({ ...f, definition: DEFAULTS[kind] }));
                        setLinesText("");
                    }}
                    options={WATCH_KINDS.map((k) => ({ label: WATCH_KIND_LABELS[k], value: k }))}
                />
                {d.kind === "point" && (
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <Input label="Place name (only for you)" value={d.placeName} onChange={(placeName) => setDef({ placeName })} maxLength={120} />
                        <NumField label="Radius (km)" value={d.radiusKm} onChange={(radiusKm) => setDef({ radiusKm })} />
                        <NumField label="Latitude" value={d.lat} onChange={(lat) => setDef({ lat })} hint="e.g. -33.87 (south is negative)" />
                        <NumField label="Longitude" value={d.lon} onChange={(lon) => setDef({ lon })} hint="e.g. 151.21" />
                    </div>
                )}
                {d.kind === "region" && (
                    <div className="grid grid-cols-2 gap-4">
                        <NumField label="North (latitude)" value={d.north} onChange={(north) => setDef({ north })} />
                        <NumField label="South (latitude)" value={d.south} onChange={(south) => setDef({ south })} />
                        <NumField label="West (longitude)" value={d.west} onChange={(west) => setDef({ west })} />
                        <NumField label="East (longitude)" value={d.east} onChange={(east) => setDef({ east })} />
                    </div>
                )}
                {(d.kind === "polygon" || d.kind === "corridor") && (
                    <>
                        <TextArea
                            label={
                                d.kind === "polygon"
                                    ? "Corners, one per line: longitude, latitude"
                                    : "Points along the route, one per line: longitude, latitude"
                            }
                            value={linesText}
                            onChange={setLinesText}
                            rows={6}
                            hint={d.kind === "polygon" ? "At least three corners; the shape is closed for you." : "At least two points, in order."}
                        />
                        {d.kind === "corridor" && (
                            <NumField label="Distance either side (km)" value={d.bufferKm} onChange={(bufferKm) => setDef({ bufferKm })} />
                        )}
                    </>
                )}
                {d.kind === "fire_district" && (
                    <NativeSelect
                        label="Fire danger district"
                        value={d.district}
                        onChange={(e) => setDef({ district: e.target.value })}
                        options={[
                            { label: districts.length ? "Choose a district" : "Collect RFS fire danger first", value: "" },
                            ...districts.map((x) => ({ label: x, value: x })),
                        ]}
                    />
                )}
                {d.kind === "gauge" && (
                    <Input
                        label="Water Data Online station number"
                        value={d.station}
                        onChange={(station) => setDef({ station })}
                        hint="e.g. 410001. Follow it in Settings → River gauges too."
                    />
                )}
                {d.kind === "incident" && (
                    <Input label="Record id" value={d.recordId} onChange={(recordId) => setDef({ recordId })} hint="From the record's address: icr_…" />
                )}
                {d.kind !== "fire_district" && d.kind !== "gauge" && d.kind !== "incident" && (
                    <NativeSelect
                        label="Also follow a fire danger district (optional)"
                        value={form.fireDistrict ?? ""}
                        onChange={(e) => setForm((f) => ({ ...f, fireDistrict: e.target.value || null }))}
                        options={[{ label: "None", value: "" }, ...districts.map((x) => ({ label: x, value: x }))]}
                    />
                )}
                <fieldset className="flex flex-col gap-2">
                    <legend className="mb-1 text-sm font-medium text-secondary">Hazards (none ticked: all of them)</legend>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {HAZARD_CATEGORIES.map((c) => (
                            <Checkbox
                                key={c}
                                label={CATEGORY_LABELS[c]}
                                isSelected={form.categories.includes(c)}
                                onChange={(on) => setForm((f) => ({ ...f, categories: on ? [...f.categories, c] : f.categories.filter((x) => x !== c) }))}
                            />
                        ))}
                    </div>
                </fieldset>
                <NativeSelect
                    label="Alert me from"
                    value={String(form.minLevel)}
                    onChange={(e) => setForm((f) => ({ ...f, minLevel: Number(e.target.value) }))}
                    hint="Levels are the providers' own. Warnings without an AWS level count as the lowest."
                    options={[
                        { label: "Any new incident or warning", value: "0" },
                        { label: "Advice and above", value: "1" },
                        { label: "Watch and Act and above", value: "2" },
                        { label: "Emergency Warning only", value: "3" },
                    ]}
                />
                <div className="flex flex-col gap-3">
                    <Toggle
                        label="Alerts in the portal (and Today)"
                        isSelected={form.notifyInApp}
                        onChange={(notifyInApp) => setForm((f) => ({ ...f, notifyInApp }))}
                    />
                    <Toggle
                        label="Email alerts"
                        hint={
                            emailOn
                                ? "Also needs email alerts turned on in Settings → My preferences."
                                : "Email alerts are switched off for the portal (Portal settings → Features)."
                        }
                        isSelected={form.notifyEmail}
                        onChange={(notifyEmail) => setForm((f) => ({ ...f, notifyEmail }))}
                    />
                    <Toggle label="Watching (switch off to pause)" isSelected={form.enabled} onChange={(enabled) => setForm((f) => ({ ...f, enabled }))} />
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                    <Input
                        label="Quiet from (email)"
                        type="time"
                        value={form.quietStart ?? ""}
                        onChange={(v) => setForm((f) => ({ ...f, quietStart: v || null }))}
                    />
                    <Input label="Quiet until" type="time" value={form.quietEnd ?? ""} onChange={(v) => setForm((f) => ({ ...f, quietEnd: v || null }))} />
                    <Input
                        label="Stop watching on (optional)"
                        type="date"
                        value={form.expiresAt?.slice(0, 10) ?? ""}
                        onChange={(v) => setForm((f) => ({ ...f, expiresAt: v ? new Date(`${v}T23:59:00+10:00`).toISOString() : null }))}
                        hint="For a trip or a temporary watch"
                    />
                </div>
            </div>
        </PortalDialog>
    );
};

export const CentreWatchesPage = ({ data }: { data: PageData<"centre-watches"> }) => {
    const toast = useToast();
    const { can } = usePortal();
    const [watches, setWatches] = useState<WatchArea[]>(data.watches);
    const [alerts, setAlerts] = useState<CentreAlert[]>(data.alerts);
    const [editing, setEditing] = useState<WatchArea | "new" | null>(null);
    const remove = async (w: WatchArea) => {
        try {
            await centreApi.deleteWatch(w.id);
            setWatches((list) => list.filter((x) => x.id !== w.id));
            toast.success("Watch area deleted");
        } catch (e) {
            toast.error("Couldn't delete it", errorMessage(e));
        }
    };
    const open = alerts.filter((a) => !a.acknowledgedAt);
    return (
        <>
            <CentreHeader
                title="Watch areas"
                crumb="Watch areas"
                shell={data}
                description="Places, routes, districts and gauges you follow. Private to you."
                actions={
                    <Button size="md" iconLeading={Plus} onClick={() => setEditing("new")}>
                        Add a watch area
                    </Button>
                }
            />
            <CentreNotices shell={data} />
            <Card title="Your watch areas" icon={Target04}>
                {watches.length ? (
                    <ul className="divide-y divide-secondary">
                        {watches.map((w) => (
                            <li key={w.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                                <div className="flex min-w-0 flex-col gap-0.5">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <a href={`${CENTRE}/records?watch=${w.id}`} className="text-sm font-semibold text-primary hover:underline">
                                            {w.name}
                                        </a>
                                        {!w.enabled && (
                                            <Badge size="sm" type="color" color="gray">
                                                Paused
                                            </Badge>
                                        )}
                                        {w.notifyEmail && (
                                            <Badge size="sm" type="color" color="blue">
                                                Email
                                            </Badge>
                                        )}
                                    </div>
                                    <span className="text-xs text-tertiary">
                                        {describe(w)}
                                        {w.fireDistrict ? ` · Fire danger: ${w.fireDistrict}` : ""}
                                        {w.categories.length ? ` · ${w.categories.map((c) => CATEGORY_LABELS[c]).join(", ")}` : " · All hazards"}
                                        {w.expiresAt ? ` · Until ${w.expiresAt.slice(0, 10)}` : ""}
                                    </span>
                                </div>
                                <div className="flex gap-1">
                                    <Button size="sm" color="link-color" href={`${CENTRE}/briefings?watch=${w.id}`}>
                                        Briefing
                                    </Button>
                                    <ButtonUtility size="sm" color="tertiary" icon={Edit05} tooltip={`Edit ${w.name}`} onClick={() => setEditing(w)} />
                                    <ButtonUtility size="sm" color="tertiary" icon={Trash01} tooltip={`Delete ${w.name}`} onClick={() => void remove(w)} />
                                </div>
                            </li>
                        ))}
                    </ul>
                ) : (
                    <Empty
                        icon={Target04}
                        title="No watch areas yet"
                        description="Add a place and radius, an area, a route, a fire danger district, a river gauge or one incident. You'll be alerted to official changes there."
                        actions={
                            <Button size="md" iconLeading={Plus} onClick={() => setEditing("new")}>
                                Add a watch area
                            </Button>
                        }
                        size="sm"
                    />
                )}
            </Card>
            <div id="alerts">
                <Card
                    title={`Alerts${open.length ? ` (${open.length} new)` : ""}`}
                    icon={Bell01}
                    action={
                        open.length > 0 && (
                            <Button
                                size="sm"
                                color="secondary"
                                onClick={() =>
                                    void centreApi
                                        .acknowledge("all")
                                        .then(() =>
                                            setAlerts((list) => list.map((a) => ({ ...a, acknowledgedAt: a.acknowledgedAt ?? new Date().toISOString() }))),
                                        )
                                        .catch((e: unknown) => toast.error("Couldn't mark them read", errorMessage(e)))
                                }
                            >
                                Mark all read
                            </Button>
                        )
                    }
                >
                    {alerts.length ? (
                        <ul className="divide-y divide-secondary">
                            {alerts.map((a) => (
                                <li key={a.id} className="flex flex-col gap-0.5 px-4 py-3 sm:px-5">
                                    <div className="flex flex-wrap items-center gap-2">
                                        {!a.acknowledgedAt && (
                                            <Badge size="sm" type="pill-color" color="brand">
                                                New
                                            </Badge>
                                        )}
                                        <a href={a.url} className="text-sm font-medium text-primary hover:underline">
                                            {a.title}
                                        </a>
                                    </div>
                                    <span className="text-xs text-tertiary">
                                        <When iso={a.createdAt} />
                                        {a.detail ? ` · ${a.detail}` : ""}
                                        {a.emailStatus === "sent" ? " · Emailed" : a.emailStatus === "pending" ? " · Email waiting" : ""}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="px-4 py-4 text-sm text-tertiary sm:px-5">No alerts yet. Alerts aren't guaranteed: always rely on official warnings.</p>
                    )}
                </Card>
            </div>
            {can("calendar.use") && <JourneysCard watches={watches} />}
            {editing && (
                <WatchForm
                    initial={editing === "new" ? null : editing}
                    districts={data.districts}
                    emailOn={data.emailOn}
                    onClose={() => setEditing(null)}
                    onSaved={(w) => {
                        setWatches((list) => [...list.filter((x) => x.id !== w.id), w].sort((a, b) => a.name.localeCompare(b.name)));
                        setEditing(null);
                    }}
                />
            )}
        </>
    );
};
