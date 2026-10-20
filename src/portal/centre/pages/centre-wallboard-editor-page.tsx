// A wallboard's layout editor (docs/INTELLIGENCE_CENTRE_9_1.md#layout-editor): the board's settings,
// its views (presets or your own layouts, rotated in order), and each view's 12 × 12 grid of
// widgets. Widgets move and resize by dragging, or entirely from the keyboard (arrow keys move,
// Shift with arrows resizes, Delete removes) and the buttons beside the grid. A change that would
// overlap another widget, leave the screen or go below a widget's minimum size is refused, and
// said so. Saving checks the layout again on the Worker.
import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import {
    ArrowDown,
    ArrowLeft,
    ArrowRight,
    ArrowUp,
    ChevronLeft,
    ChevronRight,
    Eye,
    LayoutAlt04,
    Maximize01,
    Minimize01,
    Monitor01,
    Plus,
    RefreshCcw01,
    Save01,
    Trash01,
} from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Input } from "@/components/base/input/input";
import { NativeSelect } from "@/components/base/select/select-native";
import { Toggle } from "@/components/base/toggle/toggle";
import { AlertStrip, DisplayView } from "@/display/display-view";
import { FormError } from "@/portal/components/form";
import { Notice } from "@/portal/components/notice";
import { useToast } from "@/portal/components/toast";
import { Card } from "@/portal/knowledge/pages/knowledge-home-page";
import { ApiError, errorMessage } from "@/portal/lib/api";
import type { PageData } from "@/portal/lib/page-types";
import { REGIONS } from "@/shared/centre/regions";
import { CATEGORY_LABELS, HAZARD_CATEGORIES } from "@/shared/centre/sources";
import type { MapLayer, Wallboard, WallboardInput } from "@/shared/centre/types";
import { MAP_LAYERS, MAP_LAYER_LABELS } from "@/shared/centre/types";
import {
    CHART_METRICS,
    CHART_METRIC_LABELS,
    type ChartMetric,
    DISPLAY_THEMES,
    DISPLAY_THEME_LABELS,
    type DisplayTheme,
    GRID_COLUMNS,
    GRID_ROWS,
    MAX_VIEWS,
    PRESET_LABELS,
    type ViewInput,
    WALLBOARD_PRESETS,
    WIDGET_META,
    WIDGET_TYPES,
    type WallboardPayloadV2,
    type WallboardPreset,
    type Widget,
    type WidgetSettings,
    type WidgetType,
    freeSlot,
    layoutProblems,
    nextWidgetId,
    presetView,
    presetWidgets,
} from "@/shared/centre/wallboard";
import { cx } from "@/utils/cx";
import { CENTRE, CentreHeader, CentreNotices } from "../shared";
import { boardInput, wallboardApi } from "../wallboard-api";

type Data = PageData<"centre-wallboard">;

const viewsOf = (b: Wallboard): ViewInput[] => b.views.map((v) => ({ ...v, id: b.legacyViews ? undefined : v.id }));

/** Why a widget can't go here (null: it can). Geometry only: settings are checked on save. */
function placementProblem(widgets: Widget[], next: Widget): string | null {
    const meta = WIDGET_META[next.type];
    if (next.x < 0 || next.y < 0 || next.x + next.w > GRID_COLUMNS || next.y + next.h > GRID_ROWS) return "That would go past the edge of the screen";
    if (next.w < meta.min.w || next.h < meta.min.h) return `${meta.label} needs at least ${meta.min.w} × ${meta.min.h} cells`;
    const clash = widgets.find((o) => o.id !== next.id && next.x < o.x + o.w && o.x < next.x + next.w && next.y < o.y + o.h && o.y < next.y + next.h);
    return clash ? `That would overlap ${WIDGET_META[clash.type].label}` : null;
}

const describe = (w: Widget) => `${w.settings.title || WIDGET_META[w.type].label}: column ${w.x + 1}, row ${w.y + 1}, ${w.w} by ${w.h} cells`;

// --- The grid ---------------------------------------------------------------------------------------------

const GridCanvas = ({
    widgets,
    selected,
    onSelect,
    onChange,
    onRemove,
    announce,
}: {
    widgets: Widget[];
    selected: string | null;
    onSelect: (id: string) => void;
    onChange: (next: Widget) => boolean;
    onRemove: (id: string) => void;
    announce: (message: string) => void;
}) => {
    const canvas = useRef<HTMLDivElement>(null);
    const drag = useRef<{ id: string; mode: "move" | "resize"; startX: number; startY: number; origin: Widget } | null>(null);

    const cellOf = (dx: number, dy: number) => {
        const rect = canvas.current!.getBoundingClientRect();
        return { cx: Math.round((dx / rect.width) * GRID_COLUMNS), cy: Math.round((dy / rect.height) * GRID_ROWS) };
    };
    const start = (e: ReactPointerEvent, w: Widget, mode: "move" | "resize") => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        onSelect(w.id);
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { id: w.id, mode, startX: e.clientX, startY: e.clientY, origin: w };
    };
    const move = (e: ReactPointerEvent) => {
        const d = drag.current;
        if (!d || !canvas.current) return;
        const { cx: dx, cy: dy } = cellOf(e.clientX - d.startX, e.clientY - d.startY);
        const next = d.mode === "move" ? { ...d.origin, x: d.origin.x + dx, y: d.origin.y + dy } : { ...d.origin, w: d.origin.w + dx, h: d.origin.h + dy };
        const current = widgets.find((w) => w.id === d.id);
        if (current && (current.x !== next.x || current.y !== next.y || current.w !== next.w || current.h !== next.h)) onChange(next);
    };
    const end = () => {
        const d = drag.current;
        drag.current = null;
        const w = d && widgets.find((x) => x.id === d.id);
        if (w) announce(describe(w));
    };
    const key = (e: React.KeyboardEvent, w: Widget) => {
        const step: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        if (step[e.key]) {
            e.preventDefault();
            const [dx, dy] = step[e.key];
            const next = e.shiftKey ? { ...w, w: w.w + dx, h: w.h + dy } : { ...w, x: w.x + dx, y: w.y + dy };
            if (onChange(next)) announce(describe(next));
        } else if (e.key === "Delete" || e.key === "Backspace") {
            e.preventDefault();
            onRemove(w.id);
        }
    };

    return (
        <div
            ref={canvas}
            className="relative aspect-video w-full touch-none rounded-xl bg-secondary ring-1 ring-secondary select-none"
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
        >
            {/* The cells, for orientation. */}
            <div aria-hidden="true" className="pointer-events-none absolute inset-0 grid grid-cols-12 grid-rows-12">
                {Array.from({ length: GRID_COLUMNS * GRID_ROWS }, (_, i) => (
                    <div key={i} className="border-r border-b border-secondary opacity-60" />
                ))}
            </div>
            {widgets.map((w) => (
                <div
                    key={w.id}
                    role="button"
                    tabIndex={0}
                    aria-pressed={selected === w.id}
                    aria-label={`${describe(w)}. Arrow keys move it, Shift and arrow keys resize it, Delete removes it.`}
                    onFocus={() => onSelect(w.id)}
                    onKeyDown={(e) => key(e, w)}
                    onPointerDown={(e) => start(e, w, "move")}
                    className={cx(
                        "absolute flex cursor-grab flex-col overflow-hidden rounded-lg bg-primary p-1.5 text-left shadow-xs outline-focus-ring transition duration-100 ease-linear focus-visible:outline-2",
                        selected === w.id ? "z-10 ring-2 ring-brand" : "ring-1 ring-primary",
                    )}
                    style={{
                        left: `calc(${(w.x / GRID_COLUMNS) * 100}% + 2px)`,
                        top: `calc(${(w.y / GRID_ROWS) * 100}% + 2px)`,
                        width: `calc(${(w.w / GRID_COLUMNS) * 100}% - 4px)`,
                        height: `calc(${(w.h / GRID_ROWS) * 100}% - 4px)`,
                    }}
                >
                    <span className="truncate text-xs font-semibold text-primary">{w.settings.title || WIDGET_META[w.type].label}</span>
                    <span className="truncate text-xs text-tertiary">
                        {w.w} × {w.h}
                    </span>
                    <span
                        aria-hidden="true"
                        onPointerDown={(e) => start(e, w, "resize")}
                        className="absolute right-0 bottom-0 size-4 cursor-se-resize rounded-tl-md bg-brand-solid"
                    />
                </div>
            ))}
        </div>
    );
};

// --- A widget's settings ----------------------------------------------------------------------------------

const HOURS = [6, 12, 24, 48, 72, 168];

const WidgetSettingsForm = ({ widget, data, onChange }: { widget: Widget; data: Data; onChange: (s: WidgetSettings) => void }) => {
    const allowed = new Set<string>(WIDGET_META[widget.type].settings);
    const s = widget.settings;
    const set = <K extends keyof WidgetSettings>(key: K, value: WidgetSettings[K] | undefined) => {
        const next = { ...s };
        if (value === undefined || value === "" || (Array.isArray(value) && !value.length)) delete next[key];
        else next[key] = value;
        onChange(next);
    };
    const scopeValue = !s.scope || s.scope.kind === "board" ? "board" : s.scope.kind === "watch" ? `watch:${s.scope.watchId}` : `region:${s.scope.region}`;
    return (
        <div className="flex flex-col gap-4">
            <p className="text-sm text-tertiary">{WIDGET_META[widget.type].description}</p>
            {allowed.has("title") && (
                <Input
                    label="Title on the screen"
                    value={s.title ?? ""}
                    onChange={(v) => set("title", v || undefined)}
                    maxLength={60}
                    placeholder={WIDGET_META[widget.type].label}
                />
            )}
            {allowed.has("scope") && (
                <NativeSelect
                    label="Area"
                    value={scopeValue}
                    hint="The screen never gets a watch area's location or name: give the widget a title if you want one shown."
                    onChange={(e) => {
                        const v = e.target.value;
                        if (v === "board") set("scope", undefined);
                        else if (v.startsWith("watch:")) set("scope", { kind: "watch", watchId: v.slice(6) });
                        else set("scope", { kind: "region", region: v.slice(7) as (typeof REGIONS)[number]["id"] });
                    }}
                    options={[
                        { label: "The board's area", value: "board" },
                        ...data.watches.map((w) => ({ label: `Watch area: ${w.name}`, value: `watch:${w.id}` })),
                        ...REGIONS.map((r) => ({ label: `Region: ${r.label}`, value: `region:${r.id}` })),
                    ]}
                />
            )}
            {allowed.has("metric") && (
                <NativeSelect
                    label="Measurement"
                    value={s.metric ?? "air_temperature"}
                    onChange={(e) => set("metric", e.target.value as ChartMetric)}
                    options={CHART_METRICS.filter((m) => m !== "water_level").map((m) => ({
                        label: `${CHART_METRIC_LABELS[m].label}${CHART_METRIC_LABELS[m].unit ? ` (${CHART_METRIC_LABELS[m].unit})` : ""}`,
                        value: m,
                    }))}
                />
            )}
            {allowed.has("station") &&
                (widget.type === "river_gauge" ? (
                    <NativeSelect
                        label="Gauge"
                        value={s.station ?? ""}
                        onChange={(e) => set("station", e.target.value || undefined)}
                        hint={data.gauges.length ? undefined : "No gauges are collected yet: choose them in Settings."}
                        options={[
                            { label: "Every gauge followed", value: "" },
                            ...data.gauges.map((g) => ({ label: `${g.name} (${g.station})`, value: g.station })),
                        ]}
                    />
                ) : (
                    <Input
                        label="Station number (optional)"
                        value={s.station ?? ""}
                        onChange={(v) => set("station", v.trim() || undefined)}
                        hint="A Bureau station number, e.g. 066062. Empty: the stations with the highest readings in the area."
                    />
                ))}
            {allowed.has("hours") && (
                <NativeSelect
                    label="Period"
                    value={String(s.hours ?? "")}
                    onChange={(e) => set("hours", e.target.value ? Number(e.target.value) : undefined)}
                    options={[
                        { label: "The widget's default", value: "" },
                        ...HOURS.map((h) => ({ label: h < 48 ? `Last ${h} hours` : `Last ${h / 24} days`, value: String(h) })),
                    ]}
                />
            )}
            {allowed.has("limit") && (
                <Input
                    label="Items shown"
                    type="number"
                    value={s.limit ? String(s.limit) : ""}
                    onChange={(v) => set("limit", v ? Math.min(30, Math.max(1, Math.round(Number(v)))) : undefined)}
                    hint="1 to 30. Lists say how many more there are."
                />
            )}
            {allowed.has("recordId") && (
                <Input
                    label="Record (optional)"
                    value={s.recordId ?? ""}
                    onChange={(v) => set("recordId", v.trim() || undefined)}
                    hint="A record id from its page (icr_…). Empty: the most serious current incident in the area."
                />
            )}
            {allowed.has("significantOnly") && (
                <Toggle label="Significant changes only" isSelected={!!s.significantOnly} onChange={(on) => set("significantOnly", on || undefined)} />
            )}
            {allowed.has("corridors") && (
                <Toggle
                    label="Include my road corridors"
                    hint="Disruptions on your corridor watch areas are listed first."
                    isSelected={!!s.corridors}
                    onChange={(on) => set("corridors", on || undefined)}
                />
            )}
            {allowed.has("legend") && <Toggle label="Show the legend on the map" isSelected={s.legend ?? true} onChange={(on) => set("legend", on)} />}
            {allowed.has("showInterpretation") && (
                <Toggle
                    label="Show an AI interpretation you've prepared"
                    hint="Only one already made in Briefings, labelled as interpretation. A screen never runs a model."
                    isSelected={!!s.showInterpretation}
                    onChange={(on) => set("showInterpretation", on || undefined)}
                />
            )}
            {allowed.has("showSeconds") && <Toggle label="Show seconds" isSelected={s.showSeconds ?? true} onChange={(on) => set("showSeconds", on)} />}
            {allowed.has("layers") && (
                <fieldset className="flex flex-col gap-2">
                    <legend className="mb-1 text-sm font-medium text-secondary">Map layers (none ticked: the board's layers)</legend>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {MAP_LAYERS.filter((l) => l !== "watch").map((l) => (
                            <Checkbox
                                key={l}
                                label={MAP_LAYER_LABELS[l]}
                                isSelected={(s.layers ?? []).includes(l)}
                                onChange={(on) => set("layers", on ? [...(s.layers ?? []), l] : (s.layers ?? []).filter((x) => x !== l))}
                            />
                        ))}
                    </div>
                </fieldset>
            )}
            {allowed.has("categories") && (
                <fieldset className="flex flex-col gap-2">
                    <legend className="mb-1 text-sm font-medium text-secondary">Hazards (none ticked: all)</legend>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {HAZARD_CATEGORIES.map((c) => (
                            <Checkbox
                                key={c}
                                label={CATEGORY_LABELS[c]}
                                isSelected={(s.categories ?? []).includes(c)}
                                onChange={(on) => set("categories", on ? [...(s.categories ?? []), c] : (s.categories ?? []).filter((x) => x !== c))}
                            />
                        ))}
                    </div>
                </fieldset>
            )}
        </div>
    );
};

// --- Preview ------------------------------------------------------------------------------------------------

const Preview = ({ payload, viewIndex }: { payload: WallboardPayloadV2; viewIndex: number }) => {
    const box = useRef<HTMLDivElement>(null);
    const [scale, setScale] = useState(0.5);
    useEffect(() => {
        const el = box.current;
        if (!el) return;
        const update = () => setScale(el.clientWidth / 1920);
        update();
        const observer = new ResizeObserver(update);
        observer.observe(el);
        return () => observer.disconnect();
    }, []);
    // In the portal the basemap comes through the portal's own tile route (your sign-in, no screen credential).
    // The preview route already gives the portal's own tile address (Access, not a display credential).
    const basemap = payload.basemap;
    return (
        <div ref={box} className="relative aspect-video w-full overflow-hidden rounded-xl bg-primary ring-1 ring-secondary">
            <div
                className="absolute top-0 left-0 flex flex-col gap-2 p-4"
                style={{ width: 1920, height: 1080, transform: `scale(${scale})`, transformOrigin: "top left" }}
            >
                <AlertStrip alerts={payload.alerts} timeZone={payload.timeZone} compact />
                <DisplayView
                    payload={payload}
                    viewIndex={viewIndex}
                    ctx={{ timeZone: payload.timeZone, areaLabel: payload.areaLabel, now: Date.now(), hc: false, token: null, basemap, flavor: "dark" }}
                />
            </div>
        </div>
    );
};

// --- The page ---------------------------------------------------------------------------------------------

export const CentreWallboardEditorPage = ({ data }: { data: Data }) => {
    const toast = useToast();
    const [board, setBoard] = useState<Wallboard>(data.wallboard);
    const [form, setForm] = useState<WallboardInput>(() => boardInput(data.wallboard));
    const [views, setViews] = useState<ViewInput[]>(() => viewsOf(data.wallboard));
    const [active, setActive] = useState(0);
    const [selected, setSelected] = useState<string | null>(null);
    const [addPreset, setAddPreset] = useState<WallboardPreset>("nsw");
    const [addType, setAddType] = useState<WidgetType>("warnings");
    const [message, setMessage] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [conflict, setConflict] = useState(false);
    const [busy, setBusy] = useState(false);
    const [dirty, setDirty] = useState(false);
    const [preview, setPreview] = useState<{ payload: WallboardPayloadV2; view: number } | null>(null);

    const view = views[Math.min(active, views.length - 1)];
    const widget = view?.widgets.find((w) => w.id === selected) ?? null;
    const problems = useMemo(() => views.flatMap((v) => layoutProblems(v.widgets).map((p) => `${v.name}: ${p}`)), [views]);
    const watch = data.watches.find((w) => w.id === form.watchId);

    useEffect(() => {
        if (!dirty) return;
        const warn = (e: BeforeUnloadEvent) => e.preventDefault();
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, [dirty]);

    const announce = (m: string) => setMessage(m);
    const setForm2 = (patch: Partial<WallboardInput>) => {
        setForm((f) => ({ ...f, ...patch }));
        setDirty(true);
    };
    const updateView = (index: number, change: (v: ViewInput) => ViewInput) => {
        setViews((list) => list.map((v, i) => (i === index ? change(v) : v)));
        setDirty(true);
    };
    const setWidgets = (widgets: Widget[]) => updateView(active, (v) => ({ ...v, widgets, customised: true }));

    const changeWidget = (next: Widget) => {
        const problem = placementProblem(view.widgets, next);
        if (problem) {
            announce(`${problem}. Not changed.`);
            return false;
        }
        setWidgets(view.widgets.map((w) => (w.id === next.id ? next : w)));
        return true;
    };
    const removeWidget = (id: string) => {
        const w = view.widgets.find((x) => x.id === id);
        if (view.widgets.length <= 1) return announce("A view needs at least one widget.");
        setWidgets(view.widgets.filter((x) => x.id !== id));
        setSelected(null);
        if (w) announce(`Removed ${w.settings.title || WIDGET_META[w.type].label}.`);
    };
    const addWidget = () => {
        const meta = WIDGET_META[addType];
        const slot = freeSlot(view.widgets, meta.size.w, meta.size.h) ?? freeSlot(view.widgets, meta.min.w, meta.min.h);
        if (!slot) return announce(`There's no room for ${meta.label}: make another widget smaller or remove one first.`);
        const fits = freeSlot(view.widgets, meta.size.w, meta.size.h);
        const w: Widget = {
            id: nextWidgetId(view.widgets),
            type: addType,
            ...slot,
            w: fits ? meta.size.w : meta.min.w,
            h: fits ? meta.size.h : meta.min.h,
            settings: {},
        };
        setWidgets([...view.widgets, w]);
        setSelected(w.id);
        announce(`Added ${meta.label}: ${describe(w)}.`);
    };
    const nudge = (dx: number, dy: number, resize: boolean) => {
        if (!widget) return;
        const next = resize ? { ...widget, w: widget.w + dx, h: widget.h + dy } : { ...widget, x: widget.x + dx, y: widget.y + dy };
        if (changeWidget(next)) announce(describe(next));
    };
    const moveView = (from: number, to: number) => {
        if (to < 0 || to >= views.length) return;
        setViews((list) => {
            const copy = [...list];
            const [v] = copy.splice(from, 1);
            copy.splice(to, 0, v);
            return copy;
        });
        setActive(to);
        setDirty(true);
    };

    const save = async () => {
        if (problems.length) return setError("Fix the layout problems listed first.");
        setBusy(true);
        setError(null);
        setConflict(false);
        try {
            // The board's original layout field can't be Local Situation without a watch area.
            const settings = { ...form, layout: !form.watchId && form.layout === "local" ? ("nsw" as const) : form.layout };
            const updated = await wallboardApi.update(board.id, { ...settings, version: board.version });
            const saved = await wallboardApi.saveViews(board.id, updated.wallboard.version, views);
            setBoard(saved.wallboard);
            setForm(boardInput(saved.wallboard));
            setViews(viewsOf(saved.wallboard));
            setDirty(false);
            toast.success("Wallboard saved", "Screens showing it pick the change up at their next refresh.");
        } catch (e) {
            if (e instanceof ApiError && e.status === 409) setConflict(true);
            else setError(errorMessage(e));
        } finally {
            setBusy(false);
        }
    };
    const showPreview = async () => {
        try {
            const { wallboard } = await wallboardApi.preview(board.id);
            setPreview({ payload: wallboard, view: Math.min(active, wallboard.views.length - 1) });
        } catch (e) {
            toast.error("Couldn't prepare the preview", errorMessage(e));
        }
    };

    return (
        <>
            <CentreHeader
                title={board.name}
                crumb="Wallboard layout"
                shell={data}
                description="Arrange each view's widgets on the screen's 12 × 12 grid. Screens rotate through the views in order."
                actions={
                    <>
                        <Button size="md" color="secondary" iconLeading={Monitor01} href={`${CENTRE}/wallboards`}>
                            All wallboards
                        </Button>
                        <Button size="md" color="secondary" iconLeading={Eye} onClick={() => void showPreview()}>
                            Preview saved layout
                        </Button>
                        <Button size="md" iconLeading={Save01} onClick={() => void save()} isLoading={busy} showTextWhileLoading isDisabled={!dirty && !busy}>
                            Save
                        </Button>
                    </>
                }
            />
            <CentreNotices shell={data} />
            {!data.wallboardOn && (
                <Notice color="warning" title="Wallboard displays are switched off">
                    You can design the layout now; screens are refused until an owner or admin switches displays on.
                </Notice>
            )}
            {conflict && (
                <Notice
                    color="error"
                    title="Someone else changed this wallboard"
                    actions={
                        <Button size="sm" color="link-color" onClick={() => window.location.reload()}>
                            Reload their version
                        </Button>
                    }
                >
                    Your changes weren't saved, so theirs aren't overwritten. Reload to see them, then make your changes again.
                </Notice>
            )}
            <FormError message={error} />
            {problems.length > 0 && (
                <Notice color="warning" title="This layout can't be saved yet">
                    <ul className="list-disc pl-5">
                        {problems.slice(0, 6).map((p) => (
                            <li key={p}>{p}</li>
                        ))}
                    </ul>
                </Notice>
            )}
            <p aria-live="polite" className="sr-only">
                {message}
            </p>

            <Card title="Views" icon={LayoutAlt04}>
                <div className="flex flex-col gap-4 px-4 py-4 sm:px-5">
                    <div className="flex flex-wrap gap-2" role="group" aria-label="Views">
                        {views.map((v, i) => (
                            <Button
                                key={`${v.id ?? "new"}-${i}`}
                                size="sm"
                                color={i === active ? "primary" : "secondary"}
                                aria-pressed={i === active}
                                onClick={() => (setActive(i), setSelected(null))}
                            >
                                {i + 1}. {v.name}
                            </Button>
                        ))}
                    </div>
                    {view && (
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
                            <Input
                                className="lg:w-72"
                                label="View name"
                                value={view.name}
                                maxLength={60}
                                onChange={(name) => updateView(active, (v) => ({ ...v, name }))}
                            />
                            <div className="flex flex-wrap gap-2">
                                <Button
                                    size="md"
                                    color="secondary"
                                    iconLeading={ChevronLeft}
                                    isDisabled={active === 0}
                                    onClick={() => moveView(active, active - 1)}
                                >
                                    Earlier
                                </Button>
                                <Button
                                    size="md"
                                    color="secondary"
                                    iconLeading={ChevronRight}
                                    isDisabled={active === views.length - 1}
                                    onClick={() => moveView(active, active + 1)}
                                >
                                    Later
                                </Button>
                                <Button
                                    size="md"
                                    color="secondary"
                                    iconLeading={RefreshCcw01}
                                    onClick={() => {
                                        updateView(active, (v) => ({ ...v, widgets: presetWidgets(v.preset), customised: false }));
                                        setSelected(null);
                                        announce(`Restored the ${PRESET_LABELS[view.preset]} layout.`);
                                    }}
                                >
                                    Restore {PRESET_LABELS[view.preset]}
                                </Button>
                                <Button
                                    size="md"
                                    color="secondary-destructive"
                                    iconLeading={Trash01}
                                    isDisabled={views.length <= 1}
                                    onClick={() => {
                                        setViews((list) => list.filter((_, i) => i !== active));
                                        setActive(Math.max(0, active - 1));
                                        setDirty(true);
                                    }}
                                >
                                    Remove view
                                </Button>
                            </div>
                        </div>
                    )}
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                        <NativeSelect
                            className="sm:w-72"
                            label="Add a view from a preset"
                            value={addPreset}
                            onChange={(e) => setAddPreset(e.target.value as WallboardPreset)}
                            options={WALLBOARD_PRESETS.map((p) => ({ label: PRESET_LABELS[p], value: p }))}
                        />
                        <Button
                            size="md"
                            color="secondary"
                            iconLeading={Plus}
                            isDisabled={views.length >= MAX_VIEWS}
                            onClick={() => {
                                setViews((list) => [...list, presetView(addPreset)]);
                                setActive(views.length);
                                setDirty(true);
                            }}
                        >
                            Add view
                        </Button>
                    </div>
                </div>
            </Card>

            {view && (
                <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                    <div className="flex flex-col gap-3">
                        <GridCanvas
                            widgets={view.widgets}
                            selected={selected}
                            onSelect={setSelected}
                            onChange={changeWidget}
                            onRemove={removeWidget}
                            announce={announce}
                        />
                        <p className="text-xs text-tertiary">
                            Drag a widget to move it and its corner to resize it, or select one and use the arrow keys (Shift with arrows resizes, Delete
                            removes). A change that would overlap another widget or leave the screen is refused.
                        </p>
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                            <NativeSelect
                                className="sm:w-72"
                                label="Add a widget"
                                value={addType}
                                onChange={(e) => setAddType(e.target.value as WidgetType)}
                                hint={WIDGET_META[addType].description}
                                options={WIDGET_TYPES.map((t) => ({ label: WIDGET_META[t].label, value: t }))}
                            />
                            <Button size="md" color="secondary" iconLeading={Plus} onClick={addWidget}>
                                Add widget
                            </Button>
                        </div>
                    </div>
                    <Card title={widget ? widget.settings.title || WIDGET_META[widget.type].label : "Widget settings"}>
                        <div className="flex flex-col gap-4 px-4 py-4 sm:px-5">
                            {widget ? (
                                <>
                                    <div className="flex flex-wrap gap-1" role="group" aria-label="Move and resize">
                                        <ButtonUtility size="sm" color="secondary" icon={ArrowLeft} tooltip="Move left" onClick={() => nudge(-1, 0, false)} />
                                        <ButtonUtility size="sm" color="secondary" icon={ArrowRight} tooltip="Move right" onClick={() => nudge(1, 0, false)} />
                                        <ButtonUtility size="sm" color="secondary" icon={ArrowUp} tooltip="Move up" onClick={() => nudge(0, -1, false)} />
                                        <ButtonUtility size="sm" color="secondary" icon={ArrowDown} tooltip="Move down" onClick={() => nudge(0, 1, false)} />
                                        <ButtonUtility size="sm" color="secondary" icon={Maximize01} tooltip="Wider" onClick={() => nudge(1, 0, true)} />
                                        <ButtonUtility size="sm" color="secondary" icon={Minimize01} tooltip="Narrower" onClick={() => nudge(-1, 0, true)} />
                                        <ButtonUtility size="sm" color="secondary" icon={ArrowDown} tooltip="Taller" onClick={() => nudge(0, 1, true)} />
                                        <ButtonUtility size="sm" color="secondary" icon={ArrowUp} tooltip="Shorter" onClick={() => nudge(0, -1, true)} />
                                        <ButtonUtility
                                            size="sm"
                                            color="secondary"
                                            icon={Trash01}
                                            tooltip="Remove widget"
                                            onClick={() => removeWidget(widget.id)}
                                        />
                                    </div>
                                    <p className="text-sm text-secondary">{describe(widget)}</p>
                                    <WidgetSettingsForm
                                        key={widget.id}
                                        widget={widget}
                                        data={data}
                                        onChange={(settings) => setWidgets(view.widgets.map((w) => (w.id === widget.id ? { ...w, settings } : w)))}
                                    />
                                </>
                            ) : (
                                <p className="text-sm text-tertiary">Select a widget on the grid to move, resize or set it up.</p>
                            )}
                        </div>
                    </Card>
                </div>
            )}

            <section id="settings">
                <Card title="Board settings" icon={Monitor01}>
                    <div className="grid grid-cols-1 gap-4 px-4 py-4 sm:px-5 lg:grid-cols-2">
                        <Input label="Name (shown on the screen)" value={form.name} onChange={(name) => setForm2({ name })} isRequired maxLength={60} />
                        <NativeSelect
                            label="Area"
                            value={form.watchId ?? ""}
                            onChange={(e) => setForm2({ watchId: e.target.value || null, showWatchOutline: false })}
                            hint="Widgets set to the board's area use this. Maps frame it rounded out to about 10 km."
                            options={[{ label: "All of NSW", value: "" }, ...data.watches.map((w) => ({ label: `Watch area: ${w.name}`, value: w.id }))]}
                        />
                        <NativeSelect
                            label="Theme"
                            value={form.theme}
                            onChange={(e) => setForm2({ theme: e.target.value as DisplayTheme })}
                            options={DISPLAY_THEMES.map((t) => ({ label: DISPLAY_THEME_LABELS[t], value: t }))}
                        />
                        <Input
                            label="Text size (%)"
                            type="number"
                            value={String(form.scale)}
                            onChange={(v) => setForm2({ scale: Math.min(175, Math.max(75, Math.round(Number(v) || 100))) })}
                            hint="75 to 175, on top of the size chosen for the screen's resolution"
                        />
                        <Input
                            label="Seconds per view"
                            type="number"
                            value={String(form.rotationSeconds)}
                            onChange={(v) => setForm2({ rotationSeconds: Math.min(600, Math.max(20, Math.round(Number(v) || 60))) })}
                            hint="20 to 600"
                        />
                        <Input
                            label="Refresh every (seconds)"
                            type="number"
                            value={String(form.refreshSeconds)}
                            onChange={(v) => setForm2({ refreshSeconds: Math.min(900, Math.max(30, Math.round(Number(v) || 60))) })}
                            hint="30 to 900"
                        />
                        <div className="flex flex-col gap-3">
                            <Toggle label="Rotate through the views" isSelected={form.rotate} onChange={(rotate) => setForm2({ rotate })} />
                            <Toggle label="Show the clock and date" isSelected={form.clock} onChange={(clock) => setForm2({ clock })} />
                            <Toggle
                                label="Burn-in protection"
                                hint="Moves the picture a few pixels every few minutes, for OLED and plasma screens."
                                isSelected={form.burnIn}
                                onChange={(burnIn) => setForm2({ burnIn })}
                            />
                            <Toggle
                                label="Show the latest AI interpretation"
                                hint="Only one you've already prepared in Briefings; a screen never runs a model."
                                isSelected={form.showInterpretation}
                                onChange={(showInterpretation) => setForm2({ showInterpretation })}
                            />
                            {watch?.definition.kind === "polygon" && (
                                <Toggle
                                    label="Draw the watch area's outline"
                                    hint="Off by default: the outline shows where this place is to anyone who can see the screen."
                                    isSelected={form.showWatchOutline}
                                    onChange={(showWatchOutline) => setForm2({ showWatchOutline })}
                                />
                            )}
                        </div>
                        <fieldset className="flex flex-col gap-2">
                            <legend className="mb-1 text-sm font-medium text-secondary">Map layers (for maps without their own)</legend>
                            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                {MAP_LAYERS.filter((l) => l !== "watch").map((l) => (
                                    <Checkbox
                                        key={l}
                                        label={MAP_LAYER_LABELS[l]}
                                        isSelected={form.layers.includes(l)}
                                        onChange={(on) => setForm2({ layers: on ? [...form.layers, l] : form.layers.filter((x): x is MapLayer => x !== l) })}
                                    />
                                ))}
                            </div>
                        </fieldset>
                    </div>
                </Card>
            </section>

            {preview && (
                <Card
                    title="Preview (saved layout)"
                    icon={Eye}
                    action={
                        <div className="flex items-center gap-2">
                            <NativeSelect
                                aria-label="View to preview"
                                size="sm"
                                value={String(preview.view)}
                                onChange={(e) => setPreview({ ...preview, view: Number(e.target.value) })}
                                options={preview.payload.views.map((v, i) => ({ label: `${i + 1}. ${v.name}`, value: String(i) }))}
                            />
                            <Button size="sm" color="secondary" onClick={() => setPreview(null)}>
                                Close
                            </Button>
                        </div>
                    }
                >
                    <div className="flex flex-col gap-2 px-4 py-4 sm:px-5">
                        <Preview payload={preview.payload} viewIndex={preview.view} />
                        <p className="text-xs text-tertiary">
                            What a 1920 × 1080 screen shows with the saved settings, in your portal's colours. Save first to preview changes. Larger screens
                            scale the same layout up.
                        </p>
                    </div>
                </Card>
            )}
        </>
    );
};
