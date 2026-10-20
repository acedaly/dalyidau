// Wallboards: full-screen views for a monitor, TV or kiosk (docs/INTELLIGENCE_CENTRE_9_1.md#wallboard-20).
// Each profile has an area (one of your watch areas, or NSW) and one or more views (presets or
// your own layouts) that it rotates through. A screen gets a display credential: an address shown
// once, which reads that wallboard and nothing else, can expire, can renew itself if you allow it,
// and can be revoked at any time. Layouts are edited on each wallboard's own page.
import { useState } from "react";
import { Copy01, Copy06, Edit05, LayoutAlt04, Monitor01, Plus, Trash01, XCircle } from "@untitledui/icons";
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
import type { Wallboard, WallboardLayout } from "@/shared/centre/types";
import { DISPLAY_THEME_LABELS, PRESET_DESCRIPTIONS, PRESET_LABELS, WALLBOARD_PRESETS, type WallboardPreset, presetView } from "@/shared/centre/wallboard";
import { CENTRE, CentreHeader, CentreNotices, When } from "../shared";
import { boardInput, wallboardApi } from "../wallboard-api";

const LEGACY: readonly string[] = ["local", "nsw", "map", "weather"];

/** New board: a name, an area and the presets it starts with (each becomes a view it rotates through). */
const NewBoard = ({
    watches,
    onSaved,
    onClose,
}: {
    watches: PageData<"centre-wallboards">["watches"];
    onSaved: (b: Wallboard) => void;
    onClose: () => void;
}) => {
    const [name, setName] = useState("");
    const [watchId, setWatchId] = useState<string | null>(watches[0]?.id ?? null);
    const [presets, setPresets] = useState<WallboardPreset[]>(watches.length ? ["local"] : ["nsw"]);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const save = async () => {
        if (!presets.length) return setError("Choose at least one layout");
        if (presets.includes("local") && !watchId) return setError("Local Situation needs one of your watch areas as the area");
        setBusy(true);
        setError(null);
        try {
            const first = presets[0];
            const { wallboard } = await wallboardApi.create({
                name,
                layout: (LEGACY.includes(first) ? first : "nsw") as WallboardLayout,
                watchId,
                layers: ["fire", "warnings", "flood", "weather", "transport", "power", "hotspot", "emergency"],
                rotation: [],
                rotationSeconds: 60,
                refreshSeconds: 60,
                showInterpretation: false,
                showWatchOutline: false,
                theme: "dark",
                scale: 100,
                clock: true,
                burnIn: false,
                rotate: true,
                views: presets.map(presetView),
            });
            onSaved(wallboard);
        } catch (e) {
            setError(errorMessage(e));
        } finally {
            setBusy(false);
        }
    };
    return (
        <PortalDialog
            isOpen
            onOpenChange={(o) => !o && onClose()}
            size="lg"
            title="New wallboard"
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
                        Create
                    </Button>
                </>
            }
        >
            <div className="flex flex-col gap-4">
                <FormError message={error} />
                <Input label="Name (shown on the screen)" value={name} onChange={setName} isRequired maxLength={60} placeholder="e.g. Kitchen screen" />
                <NativeSelect
                    label="Area"
                    value={watchId ?? ""}
                    onChange={(e) => setWatchId(e.target.value || null)}
                    hint="Maps frame this area, rounded out to about 10 km. Its location and name are never sent to the screen."
                    options={[{ label: "All of NSW", value: "" }, ...watches.map((w) => ({ label: `Watch area: ${w.name}`, value: w.id }))]}
                />
                <fieldset className="flex flex-col gap-3">
                    <legend className="mb-1 text-sm font-medium text-secondary">
                        Layouts (the screen rotates through them; you can change each one later)
                    </legend>
                    {WALLBOARD_PRESETS.map((p) => (
                        <Checkbox
                            key={p}
                            label={PRESET_LABELS[p]}
                            hint={PRESET_DESCRIPTIONS[p]}
                            isSelected={presets.includes(p)}
                            onChange={(on) => setPresets((list) => (on ? [...list, p] : list.filter((x) => x !== p)))}
                        />
                    ))}
                </fieldset>
            </div>
        </PortalDialog>
    );
};

export const CentreWallboardsPage = ({ data }: { data: PageData<"centre-wallboards"> }) => {
    const toast = useToast();
    const [boards, setBoards] = useState<Wallboard[]>(data.wallboards);
    const [creating, setCreating] = useState(false);
    const [deleting, setDeleting] = useState<Wallboard | null>(null);
    const [issuing, setIssuing] = useState<Wallboard | null>(null);
    const [label, setLabel] = useState("");
    const [days, setDays] = useState("");
    const [renewable, setRenewable] = useState(false);
    const [issued, setIssued] = useState<{ url: string } | null>(null);
    const reload = async () => setBoards((await wallboardApi.list()).wallboards);
    const areaOf = (b: Wallboard) => (b.watchId ? `Watch area: ${data.watches.find((w) => w.id === b.watchId)?.name ?? "removed"}` : "All of NSW");

    const issue = async () => {
        if (!issuing) return;
        try {
            const expires = days ? Number(days) : null;
            const r = await wallboardApi.createDisplay(issuing.id, { label, expiresInDays: expires, renewable: !!expires && renewable });
            setIssued({ url: `${window.location.origin}${r.path}` });
            await reload();
        } catch (e) {
            toast.error("Couldn't create the display address", errorMessage(e));
        }
    };
    const duplicate = async (b: Wallboard) => {
        try {
            const { wallboard } = await wallboardApi.duplicate(b.id);
            setBoards((list) => [...list, wallboard].sort((x, y) => x.name.localeCompare(y.name)));
            toast.success("Copied", "The copy has no screens: add one when it's ready.");
        } catch (e) {
            toast.error("Couldn't copy it", errorMessage(e));
        }
    };
    const toggleRotate = async (b: Wallboard, rotate: boolean) => {
        try {
            const { wallboard } = await wallboardApi.update(b.id, { ...boardInput(b), rotate, version: b.version });
            setBoards((list) => list.map((x) => (x.id === b.id ? wallboard : x)));
        } catch (e) {
            toast.error("Couldn't change it", errorMessage(e));
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
                    <Button size="md" iconLeading={Plus} onClick={() => setCreating(true)}>
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
                            <div className="flex flex-wrap justify-end gap-1">
                                <Button size="sm" color="secondary" iconLeading={LayoutAlt04} href={`${CENTRE}/wallboards/${b.id}`}>
                                    Edit layout
                                </Button>
                                <Button
                                    size="sm"
                                    color="secondary"
                                    iconLeading={Plus}
                                    onClick={() => (setIssuing(b), setLabel(""), setDays(""), setRenewable(false), setIssued(null))}
                                >
                                    Add a screen
                                </Button>
                                <ButtonUtility size="sm" color="tertiary" icon={Copy06} tooltip={`Duplicate ${b.name}`} onClick={() => void duplicate(b)} />
                                <ButtonUtility
                                    size="sm"
                                    color="tertiary"
                                    icon={Edit05}
                                    tooltip={`Settings for ${b.name}`}
                                    href={`${CENTRE}/wallboards/${b.id}#settings`}
                                />
                                <ButtonUtility size="sm" color="tertiary" icon={Trash01} tooltip={`Delete ${b.name}`} onClick={() => setDeleting(b)} />
                            </div>
                        }
                    >
                        <div className="flex flex-col gap-3 px-4 py-4 sm:px-5">
                            <p className="text-sm text-tertiary">
                                {areaOf(b)} · {DISPLAY_THEME_LABELS[b.theme]} · refreshes every {b.refreshSeconds} s
                                {b.views.length > 1 ? ` · ${b.rotate ? `rotates every ${b.rotationSeconds} s` : "rotation off"}` : ""}
                            </p>
                            <ul className="flex flex-wrap gap-1.5" aria-label="Views">
                                {b.views.map((v, i) => (
                                    <li key={v.id}>
                                        <Badge size="md" type="color" color={v.customised ? "brand" : "gray"}>
                                            {i + 1}. {v.name}
                                            {v.customised ? " (custom)" : ""}
                                        </Badge>
                                    </li>
                                ))}
                            </ul>
                            {b.views.length > 1 && (
                                <Toggle label="Rotate through the views" isSelected={b.rotate} onChange={(on) => void toggleRotate(b, on)} />
                            )}
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
                                                ) : t.renewable ? (
                                                    <Badge size="sm" type="color" color="blue">
                                                        Renews itself
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
                                                    {t.expiresAt ? ` · expires ${t.expiresAt.slice(0, 10)}` : " · no expiry"}
                                                    {t.renewedAt ? ` · renewed ${t.renewedAt.slice(0, 10)}` : ""}
                                                </span>
                                            </span>
                                            {!t.revokedAt && (
                                                <Button
                                                    size="sm"
                                                    color="secondary-destructive"
                                                    iconLeading={XCircle}
                                                    onClick={() =>
                                                        void wallboardApi
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
                                <p className="text-sm text-tertiary">No screens yet. Add one to get its address, or preview the layout from Edit layout.</p>
                            )}
                        </div>
                    </Card>
                ))
            ) : (
                <Empty
                    icon={Monitor01}
                    title="No wallboards yet"
                    description="Start from Local Situation, NSW Situation Overview, Weather & Environment, Transport & Infrastructure or Intelligence & Trends, then adjust the layout and add a screen."
                    actions={
                        <Button size="md" iconLeading={Plus} onClick={() => setCreating(true)}>
                            New wallboard
                        </Button>
                    }
                />
            )}
            {creating && (
                <NewBoard
                    watches={data.watches}
                    onClose={() => setCreating(false)}
                    onSaved={(b) => {
                        setBoards((list) => [...list, b].sort((x, y) => x.name.localeCompare(y.name)));
                        setCreating(false);
                        toast.success("Wallboard created", "Edit its layout or add a screen.");
                    }}
                />
            )}
            {deleting && (
                <PortalDialog
                    isOpen
                    onOpenChange={(o) => !o && setDeleting(null)}
                    title={`Delete ${deleting.name}?`}
                    description="Its layouts are deleted and every screen showing it stops at its next refresh. This can't be undone."
                    icon={Trash01}
                    iconColor="error"
                    footer={
                        <>
                            <Button size="md" color="secondary" onClick={() => setDeleting(null)}>
                                Cancel
                            </Button>
                            <Button
                                size="md"
                                color="primary-destructive"
                                onClick={() =>
                                    void wallboardApi
                                        .remove(deleting.id)
                                        .then(() => setBoards((list) => list.filter((x) => x.id !== deleting.id)))
                                        .then(() => setDeleting(null))
                                        .catch((e: unknown) => toast.error("Couldn't delete it", errorMessage(e)))
                                }
                            >
                                Delete
                            </Button>
                        </>
                    }
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
                            <p className="text-xs text-tertiary">
                                Kiosk setup for Safari, Chrome and TV browsers: see the Intelligence Centre documentation (Kiosk setup).
                            </p>
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
                            {days && Number(days) > 0 && (
                                <Toggle
                                    label="Let this screen renew its own address before it expires"
                                    hint="In its last 14 days the screen swaps the address for a new one with the same lifetime. You can still revoke it at any time."
                                    isSelected={renewable}
                                    onChange={setRenewable}
                                />
                            )}
                        </div>
                    )}
                </PortalDialog>
            )}
        </>
    );
};
