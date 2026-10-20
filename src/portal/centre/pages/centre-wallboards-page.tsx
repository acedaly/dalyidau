// Wallboards: full-screen views for a monitor, TV or kiosk. Each has a layout, an area (one of your
// watch areas, or NSW), layers and optional rotation. A screen gets a display credential: an
// address shown once, which reads that wallboard and nothing else, and can be revoked at any time.
import { useState } from "react";
import { Copy01, Edit05, Monitor01, Plus, Trash01, XCircle } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Input } from "@/components/base/input/input";
import { NativeSelect } from "@/components/base/select/select-native";
import { Toggle } from "@/components/base/toggle/toggle";
import { PortalDialog } from "@/portal/components/dialog";
import { Empty } from "@/portal/components/empty";
import { FormError } from "@/portal/components/form";
import { Notice } from "@/portal/components/notice";
import { useToast } from "@/portal/components/toast";
import { Card } from "@/portal/knowledge/pages/knowledge-home-page";
import { errorMessage } from "@/portal/lib/api";
import type { PageData } from "@/portal/lib/page-types";
import type { Wallboard, WallboardInput, WallboardLayout } from "@/shared/centre/types";
import { MAP_LAYERS, MAP_LAYER_LABELS, WALLBOARD_LAYOUTS, WALLBOARD_LAYOUT_LABELS } from "@/shared/centre/types";
import { centreApi } from "../centre-api";
import { CentreHeader, CentreNotices, When } from "../shared";

const blank = (): WallboardInput => ({
    name: "",
    layout: "nsw",
    watchId: null,
    layers: ["fire", "warnings", "transport", "hotspot"],
    rotation: [],
    rotationSeconds: 60,
    refreshSeconds: 60,
    showInterpretation: false,
    showWatchOutline: false,
});

const BoardForm = ({
    initial,
    watches,
    onSaved,
    onClose,
}: {
    initial: Wallboard | null;
    watches: PageData<"centre-wallboards">["watches"];
    onSaved: (b: Wallboard) => void;
    onClose: () => void;
}) => {
    const [form, setForm] = useState<WallboardInput>(() => (initial ? { ...initial } : blank()));
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const toast = useToast();
    const save = async () => {
        setBusy(true);
        setError(null);
        try {
            const { wallboard } = initial
                ? await centreApi.updateWallboard(initial.id, { ...form, version: initial.version })
                : await centreApi.createWallboard(form);
            toast.success("Wallboard saved");
            onSaved(wallboard);
        } catch (e) {
            setError(errorMessage(e));
        } finally {
            setBusy(false);
        }
    };
    const watch = watches.find((w) => w.id === form.watchId);
    return (
        <PortalDialog
            isOpen
            onOpenChange={(o) => !o && onClose()}
            size="lg"
            title={initial ? "Edit wallboard" : "New wallboard"}
            icon={Monitor01}
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
                    label="Name (shown on the screen)"
                    value={form.name}
                    onChange={(name) => setForm((f) => ({ ...f, name }))}
                    isRequired
                    maxLength={60}
                    placeholder="e.g. Kitchen screen"
                />
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <NativeSelect
                        label="Layout"
                        value={form.layout}
                        onChange={(e) => setForm((f) => ({ ...f, layout: e.target.value as WallboardLayout }))}
                        options={WALLBOARD_LAYOUTS.map((l) => ({ label: WALLBOARD_LAYOUT_LABELS[l], value: l }))}
                    />
                    <NativeSelect
                        label="Area"
                        value={form.watchId ?? ""}
                        onChange={(e) => setForm((f) => ({ ...f, watchId: e.target.value || null }))}
                        hint="The map frames this area, rounded out to about 10 km, without your current location"
                        options={[{ label: "All of NSW", value: "" }, ...watches.map((w) => ({ label: `Watch area: ${w.name}`, value: w.id }))]}
                    />
                </div>
                <fieldset className="flex flex-col gap-2">
                    <legend className="mb-1 text-sm font-medium text-secondary">Map layers</legend>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {MAP_LAYERS.filter((l) => l !== "watch").map((l) => (
                            <Checkbox
                                key={l}
                                label={MAP_LAYER_LABELS[l]}
                                isSelected={form.layers.includes(l)}
                                onChange={(on) => setForm((f) => ({ ...f, layers: on ? [...f.layers, l] : f.layers.filter((x) => x !== l) }))}
                            />
                        ))}
                    </div>
                </fieldset>
                <fieldset className="flex flex-col gap-2">
                    <legend className="mb-1 text-sm font-medium text-secondary">Rotate between (optional; the screen can pause it)</legend>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {WALLBOARD_LAYOUTS.map((l) => (
                            <Checkbox
                                key={l}
                                label={WALLBOARD_LAYOUT_LABELS[l]}
                                isSelected={form.rotation.includes(l)}
                                onChange={(on) => setForm((f) => ({ ...f, rotation: on ? [...f.rotation, l] : f.rotation.filter((x) => x !== l) }))}
                            />
                        ))}
                    </div>
                </fieldset>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Input
                        label="Seconds per view"
                        type="number"
                        value={String(form.rotationSeconds)}
                        onChange={(v) => setForm((f) => ({ ...f, rotationSeconds: Number(v) }))}
                    />
                    <Input
                        label="Refresh every (seconds)"
                        type="number"
                        value={String(form.refreshSeconds)}
                        onChange={(v) => setForm((f) => ({ ...f, refreshSeconds: Number(v) }))}
                        hint="30 to 900"
                    />
                </div>
                <Toggle
                    label="Show the latest AI interpretation"
                    hint="Only one you've already prepared in Briefings; a screen never runs a model."
                    isSelected={form.showInterpretation}
                    onChange={(showInterpretation) => setForm((f) => ({ ...f, showInterpretation }))}
                />
                {watch?.definition.kind === "polygon" && (
                    <Toggle
                        label="Draw the watch area's outline"
                        hint="Off by default: the outline shows where this place is to anyone who can see the screen."
                        isSelected={form.showWatchOutline}
                        onChange={(showWatchOutline) => setForm((f) => ({ ...f, showWatchOutline }))}
                    />
                )}
            </div>
        </PortalDialog>
    );
};

export const CentreWallboardsPage = ({ data }: { data: PageData<"centre-wallboards"> }) => {
    const toast = useToast();
    const [boards, setBoards] = useState<Wallboard[]>(data.wallboards);
    const [editing, setEditing] = useState<Wallboard | "new" | null>(null);
    const [issuing, setIssuing] = useState<Wallboard | null>(null);
    const [label, setLabel] = useState("");
    const [days, setDays] = useState("");
    const [issued, setIssued] = useState<{ url: string } | null>(null);
    const reload = async () => setBoards((await centreApi.wallboards()).wallboards);

    const issue = async () => {
        if (!issuing) return;
        try {
            const r = await centreApi.createDisplay(issuing.id, { label, expiresInDays: days ? Number(days) : null });
            setIssued({ url: `${window.location.origin}${r.path}` });
            await reload();
        } catch (e) {
            toast.error("Couldn't create the display address", errorMessage(e));
        }
    };

    return (
        <>
            <CentreHeader
                title="Wallboards"
                crumb="Wallboards"
                shell={data}
                description="Full-screen views for a monitor, TV or kiosk. Not an official warning service or guaranteed real-time monitoring."
                actions={
                    <Button size="md" iconLeading={Plus} onClick={() => setEditing("new")}>
                        New wallboard
                    </Button>
                }
            />
            <CentreNotices shell={data} />
            {!data.wallboardOn && (
                <Notice
                    color="warning"
                    title="Wallboard displays are switched off"
                    actions={
                        <Button size="sm" color="link-color" href="/portal/settings/features#features-centre">
                            Portal settings → Features
                        </Button>
                    }
                >
                    You can set wallboards up now, but screens are refused until an owner or admin switches displays on.
                </Notice>
            )}
            {boards.length ? (
                boards.map((b) => (
                    <Card
                        key={b.id}
                        title={b.name}
                        icon={Monitor01}
                        action={
                            <div className="flex gap-1">
                                <Button
                                    size="sm"
                                    color="secondary"
                                    iconLeading={Plus}
                                    onClick={() => (setIssuing(b), setLabel(""), setDays(""), setIssued(null))}
                                >
                                    Add a screen
                                </Button>
                                <ButtonUtility size="sm" color="tertiary" icon={Edit05} tooltip={`Edit ${b.name}`} onClick={() => setEditing(b)} />
                                <ButtonUtility
                                    size="sm"
                                    color="tertiary"
                                    icon={Trash01}
                                    tooltip={`Delete ${b.name}`}
                                    onClick={() =>
                                        void centreApi
                                            .deleteWallboard(b.id)
                                            .then(() => setBoards((list) => list.filter((x) => x.id !== b.id)))
                                            .catch((e: unknown) => toast.error("Couldn't delete it", errorMessage(e)))
                                    }
                                />
                            </div>
                        }
                    >
                        <div className="flex flex-col gap-3 px-4 py-4 sm:px-5">
                            <p className="text-sm text-tertiary">
                                {WALLBOARD_LAYOUT_LABELS[b.layout]} ·{" "}
                                {b.watchId ? `Watch area: ${data.watches.find((w) => w.id === b.watchId)?.name ?? "removed"}` : "All of NSW"}
                                {b.rotation.length ? ` · Rotates: ${b.rotation.map((r) => WALLBOARD_LAYOUT_LABELS[r]).join(", ")}` : ""} · Refreshes every{" "}
                                {b.refreshSeconds} s
                            </p>
                            <h3 className="text-sm font-semibold text-secondary">Screens</h3>
                            {b.tokens.length ? (
                                <ul className="divide-y divide-secondary rounded-lg ring-1 ring-secondary">
                                    {b.tokens.map((t) => (
                                        <li key={t.id} className="flex flex-col gap-1 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                                            <span className="text-sm text-secondary">
                                                {t.label}{" "}
                                                {t.revokedAt ? (
                                                    <Badge size="sm" type="color" color="gray">
                                                        Revoked
                                                    </Badge>
                                                ) : t.expiresAt && Date.parse(t.expiresAt) < Date.now() ? (
                                                    <Badge size="sm" type="color" color="gray">
                                                        Expired
                                                    </Badge>
                                                ) : null}
                                                <span className="block text-xs text-tertiary">
                                                    Created <When iso={t.createdAt} />
                                                    {t.lastUsedAt ? (
                                                        <>
                                                            {" "}
                                                            · last seen <When iso={t.lastUsedAt} />
                                                        </>
                                                    ) : (
                                                        " · never used"
                                                    )}
                                                    {t.expiresAt ? ` · expires ${t.expiresAt.slice(0, 10)}` : ""}
                                                </span>
                                            </span>
                                            {!t.revokedAt && (
                                                <Button
                                                    size="sm"
                                                    color="secondary-destructive"
                                                    iconLeading={XCircle}
                                                    onClick={() =>
                                                        void centreApi
                                                            .revokeDisplay(b.id, t.id)
                                                            .then(reload)
                                                            .then(() => toast.success("Revoked. That screen stops at its next refresh."))
                                                            .catch((e: unknown) => toast.error("Couldn't revoke it", errorMessage(e)))
                                                    }
                                                >
                                                    Revoke
                                                </Button>
                                            )}
                                        </li>
                                    ))}
                                </ul>
                            ) : (
                                <p className="text-sm text-tertiary">No screens yet. Add one to get its address.</p>
                            )}
                        </div>
                    </Card>
                ))
            ) : (
                <Empty
                    icon={Monitor01}
                    title="No wallboards yet"
                    description="Choose a layout (Local Situation, NSW Overview, Map Focus or Weather & Environment) and an area, then add a screen."
                    actions={
                        <Button size="md" iconLeading={Plus} onClick={() => setEditing("new")}>
                            New wallboard
                        </Button>
                    }
                />
            )}
            {editing && (
                <BoardForm
                    initial={editing === "new" ? null : editing}
                    watches={data.watches}
                    onClose={() => setEditing(null)}
                    onSaved={(b) => {
                        setBoards((list) => [...list.filter((x) => x.id !== b.id), b]);
                        setEditing(null);
                    }}
                />
            )}
            {issuing && (
                <PortalDialog
                    isOpen
                    onOpenChange={(o) => !o && setIssuing(null)}
                    title={issued ? "The screen's address" : `Add a screen to ${issuing.name}`}
                    description={
                        issued
                            ? "Open this on the screen. It's shown once: copy it now. Anyone with it can see this wallboard (only this wallboard) until you revoke it."
                            : "The screen gets its own address that reads this wallboard and nothing else in the portal."
                    }
                    icon={Monitor01}
                    onSubmit={(e) => {
                        e.preventDefault();
                        if (!issued) void issue();
                    }}
                    footer={
                        issued ? (
                            <Button size="md" onClick={() => setIssuing(null)}>
                                Done
                            </Button>
                        ) : (
                            <>
                                <Button size="md" color="secondary" onClick={() => setIssuing(null)}>
                                    Cancel
                                </Button>
                                <Button size="md" type="submit">
                                    Create address
                                </Button>
                            </>
                        )
                    }
                >
                    {issued ? (
                        <div className="flex flex-col gap-3">
                            <code className="rounded-lg bg-secondary p-3 text-xs break-all text-secondary">{issued.url}</code>
                            <Button
                                size="sm"
                                color="secondary"
                                iconLeading={Copy01}
                                onClick={() =>
                                    void navigator.clipboard
                                        .writeText(issued.url)
                                        .then(() => toast.success("Copied"))
                                        .catch(() => toast.error("Couldn't copy", "Select the address and copy it."))
                                }
                            >
                                Copy address
                            </Button>
                        </div>
                    ) : (
                        <div className="flex flex-col gap-4">
                            <Input label="Screen name" value={label} onChange={setLabel} isRequired maxLength={60} placeholder="e.g. Kitchen TV" />
                            <Input
                                label="Expires after (days, optional)"
                                type="number"
                                value={days}
                                onChange={setDays}
                                hint="Leave empty to keep it until you revoke it"
                            />
                        </div>
                    )}
                </PortalDialog>
            )}
        </>
    );
};
