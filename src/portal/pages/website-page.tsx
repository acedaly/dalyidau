import { useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, Eye, Globe02, Image01, Plus, RefreshCcw01, Trash01, UploadCloud02 } from "@untitledui/icons";
import { FileUploadDropZone } from "@/components/application/file-upload/file-upload-base";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Dropdown } from "@/components/base/dropdown/dropdown";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { TextArea } from "@/components/base/textarea/textarea";
import { Toggle } from "@/components/base/toggle/toggle";
import { ConfirmDialog } from "@/portal/components/dialog";
import { FormError, FormSection, useSubmit } from "@/portal/components/form";
import { Notice } from "@/portal/components/notice";
import { PageHeader } from "@/portal/components/page-header";
import { useToast } from "@/portal/components/toast";
import { api, errorMessage } from "@/portal/lib/api";
import type { PageData } from "@/portal/lib/page-types";
import { usePortal } from "@/portal/portal-context";
import type { Flags } from "@/shared/portal/flags";
import type { SectionKind, WebsiteContent, WebsiteItem, WebsiteMedia, WebsiteSection } from "@/shared/portal/types";

const KINDS: Record<SectionKind, { label: string; items?: { noun: string; titleLabel: string; bodyLabel: string; urlLabel?: string } }> = {
    story: { label: "Our story" },
    details: { label: "The big day" },
    venue: { label: "Venue", items: { noun: "detail", titleLabel: "Label (e.g. Address)", bodyLabel: "Details", urlLabel: "Map or directions link" } },
    accommodation: { label: "Accommodation", items: { noun: "place to stay", titleLabel: "Name", bodyLabel: "Details", urlLabel: "Booking or website link" } },
    travel: { label: "Getting there", items: { noun: "travel tip", titleLabel: "Heading", bodyLabel: "Details", urlLabel: "Map link" } },
    transport: { label: "Transport / courtesy bus" },
    children: { label: "Children and families" },
    dress: { label: "Dress code" },
    registry: { label: "Gifts / registry", items: { noun: "registry", titleLabel: "Name", bodyLabel: "Details", urlLabel: "Link" } },
    faq: { label: "Questions", items: { noun: "question", titleLabel: "Question", bodyLabel: "Answer" } },
    custom: { label: "Other" },
};

/** Section kinds whose layout includes a photograph. */
const PHOTO_KINDS: SectionKind[] = ["story", "venue", "accommodation", "travel", "transport", "children", "custom"];
const PHOTO_HINTS: Partial<Record<SectionKind, string>> = {
    venue: "A wide landscape photo of Rhino Lodge works best; it fills the width of the page.",
    accommodation: "Shown with the first place to stay (Rhino Lodge).",
    story: "A portrait-shaped photo of the two of you works best.",
};

const slug = (title: string, taken: string[]) => {
    const base =
        title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 30) || "section";
    let candidate = base;
    for (let n = 2; taken.includes(candidate); n++) candidate = `${base}-${n}`;
    return candidate;
};

const readFile = (file: File) =>
    new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });

const ItemsEditor = ({
    kind,
    items,
    onChange,
    photoOptions,
}: {
    kind: SectionKind;
    items: WebsiteItem[];
    onChange: (items: WebsiteItem[]) => void;
    photoOptions: { id: string; label: string }[];
}) => {
    const spec = KINDS[kind].items;
    if (!spec) return null;
    const set = (i: number, patch: Partial<WebsiteItem>) => onChange(items.map((it, j) => (j === i ? { ...it, ...patch } : it)));
    return (
        <div className="flex flex-col gap-3">
            {items.map((item, i) => (
                <div key={i} className="flex flex-col gap-3 rounded-lg bg-primary p-3 ring-1 ring-secondary ring-inset">
                    <div className="flex items-end gap-2">
                        <Input label={spec.titleLabel} value={item.title} onChange={(v) => set(i, { title: v })} className="flex-1" isRequired />
                        <ButtonUtility
                            size="sm"
                            color="tertiary"
                            icon={Trash01}
                            tooltip={`Remove ${spec.noun}`}
                            onClick={() => onChange(items.filter((_, j) => j !== i))}
                        />
                    </div>
                    <TextArea label={spec.bodyLabel} rows={3} value={item.body} onChange={(v) => set(i, { body: v })} />
                    {spec.urlLabel && <Input label={spec.urlLabel} type="url" placeholder="https://" value={item.url} onChange={(v) => set(i, { url: v })} />}
                    {kind === "accommodation" && (
                        <>
                            <Input
                                label="Small label"
                                placeholder="5.2 km from the ceremony"
                                value={item.detail}
                                onChange={(v) => set(i, { detail: v })}
                                hint="Shown above the name, e.g. the distance from the venue."
                            />
                            <Select
                                label="Photo"
                                items={photoOptions}
                                value={item.imageId ?? "none"}
                                onChange={(v) => set(i, { imageId: v === "none" ? null : String(v) })}
                                hint="Use a photo you have permission to use."
                            >
                                {(option) => <Select.Item id={option.id}>{option.label}</Select.Item>}
                            </Select>
                        </>
                    )}
                </div>
            ))}
            <div>
                <Button
                    size="sm"
                    color="secondary"
                    iconLeading={Plus}
                    onClick={() => onChange([...items, { title: "", body: "", url: "", detail: "", imageId: null }])}
                >
                    Add {spec.noun}
                </Button>
            </div>
        </div>
    );
};

export const WebsitePage = ({ data }: { data: PageData<"website"> }) => {
    const { can, isOn, setFlags } = usePortal();
    const toast = useToast();
    const [content, setContent] = useState<WebsiteContent>(data.content);
    const [savedDraft, setSavedDraft] = useState<WebsiteContent>(data.content);
    const [published, setPublished] = useState<WebsiteContent>(data.published);
    const [media, setMedia] = useState<WebsiteMedia[]>(data.media);
    const [confirm, setConfirm] = useState<"publish" | "discard" | "visible" | "hidden" | null>(null);
    const [uploading, setUploading] = useState(false);
    const canEdit = can("wedding.website.edit");
    const siteOn = isOn("wedding.site.public");
    const unsaved = JSON.stringify(content) !== JSON.stringify(savedDraft);
    const unpublished = JSON.stringify(savedDraft) !== JSON.stringify(published);

    const saveDraft = useSubmit(() => api<{ value: WebsiteContent }>("PUT", "/api/portal/settings/website_draft", content), {
        success: "Draft saved",
        onSuccess: ({ value }) => {
            setContent(value);
            setSavedDraft(value);
        },
    });

    const setSection = (i: number, patch: Partial<WebsiteSection>) =>
        setContent({ ...content, sections: content.sections.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
    const moveSection = (i: number, delta: number) => {
        const sections = [...content.sections];
        [sections[i], sections[i + delta]] = [sections[i + delta], sections[i]];
        setContent({ ...content, sections });
    };
    const addSection = (kind: SectionKind) => {
        const title = KINDS[kind].label;
        setContent({
            ...content,
            sections: [
                ...content.sections,
                {
                    id: slug(
                        title,
                        content.sections.map((s) => s.id),
                    ),
                    kind,
                    title,
                    body: "",
                    items: [],
                    imageId: null,
                    visible: false,
                },
            ],
        });
    };

    const upload = async (files: FileList) => {
        setUploading(true);
        try {
            for (const file of [...files]) {
                const { media: added } = await api<{ media: WebsiteMedia }>("POST", "/api/portal/wedding/media", { data: await readFile(file), alt: "" });
                setMedia((list) => [...list, added]);
            }
            toast.success("Photos uploaded", "Add a short description to each so everyone can enjoy them.");
        } catch (error) {
            toast.error("Couldn't upload", errorMessage(error));
        } finally {
            setUploading(false);
        }
    };

    const updatePhoto = async (photo: WebsiteMedia, patch: Partial<Pick<WebsiteMedia, "alt" | "caption" | "inGallery">>) => {
        setMedia((list) => list.map((m) => (m.id === photo.id ? { ...m, ...patch } : m)));
        try {
            await api("PATCH", `/api/portal/wedding/media/${photo.id}`, patch);
        } catch (error) {
            toast.error("Couldn't update the photo", errorMessage(error));
        }
    };

    const act = async () => {
        try {
            if (confirm === "publish") {
                if (unsaved) await saveDraft.submit();
                const result = await api<{ published: WebsiteContent }>("POST", "/api/portal/wedding/website/publish", {});
                setPublished(result.published);
                toast.success("Changes published", siteOn ? "They're live on /wedding." : "They'll show when the website is made visible.");
            } else if (confirm === "discard") {
                const { draft } = await api<{ draft: WebsiteContent }>("POST", "/api/portal/wedding/website/discard", {});
                setContent(draft);
                setSavedDraft(draft);
                toast.success("Draft reset to the published version");
            } else if (confirm === "visible" || confirm === "hidden") {
                const { flags } = await api<{ flags: Flags }>("PUT", "/api/portal/flags/wedding.site.public", { enabled: confirm === "visible" });
                setFlags(flags);
                toast.success(confirm === "visible" ? "The website is visible" : "The website is hidden");
            }
        } catch (error) {
            toast.error("That didn't work", errorMessage(error));
        }
    };

    const photoOptions = [{ id: "none", label: "No photo" }, ...media.map((m, i) => ({ id: m.id, label: m.alt || m.caption || `Photo ${i + 1}` }))];
    const missingKinds = (Object.keys(KINDS) as SectionKind[]).filter((k) => k === "custom" || !content.sections.some((s) => s.kind === k));

    return (
        <>
            <PageHeader
                title="Wedding website"
                description="Edit a draft, preview it, then publish. The public site only changes when you publish."
                breadcrumbs={[{ label: "Website" }]}
                actions={
                    <>
                        <Button color="secondary" iconLeading={Eye} href="/portal/wedding/website/preview" target="_blank">
                            Preview draft
                        </Button>
                        {canEdit && (
                            <Button onClick={() => saveDraft.submit()} isLoading={saveDraft.busy} showTextWhileLoading isDisabled={!unsaved}>
                                Save draft
                            </Button>
                        )}
                    </>
                }
            />

            <section
                aria-label="Publishing"
                className="grid grid-cols-1 gap-4 rounded-xl bg-primary p-5 shadow-xs ring-1 ring-secondary ring-inset md:grid-cols-2"
            >
                <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                        <h2 className="text-md font-semibold text-primary">Content</h2>
                        <Badge size="sm" type="pill-color" color={unsaved ? "warning" : unpublished ? "brand" : "success"}>
                            {unsaved ? "Unsaved changes" : unpublished ? "Draft differs from the published site" : "Published version is up to date"}
                        </Badge>
                    </div>
                    <p className="text-sm text-tertiary">
                        Hidden sections and unconfirmed details stay in the draft. Publishing copies the draft to the public site.
                    </p>
                    {canEdit && (
                        <div className="flex flex-wrap gap-3">
                            <Button size="sm" iconLeading={Globe02} onClick={() => setConfirm("publish")} isDisabled={!unpublished && !unsaved}>
                                Publish changes
                            </Button>
                            <Button size="sm" color="secondary" iconLeading={RefreshCcw01} onClick={() => setConfirm("discard")} isDisabled={!unpublished}>
                                Discard draft
                            </Button>
                        </div>
                    )}
                </div>
                <div className="flex flex-col gap-2 md:border-l md:border-secondary md:pl-4">
                    <div className="flex items-center gap-2">
                        <h2 className="text-md font-semibold text-primary">Visibility</h2>
                        <Badge size="sm" type="pill-color" color={siteOn ? "success" : "gray"}>
                            {siteOn ? "Visible at /wedding" : "Hidden"}
                        </Badge>
                    </div>
                    <p className="text-sm text-tertiary">
                        {siteOn ? "Anyone with the link can see the published content." : "Visitors to /wedding see “not found”. Only you can see the preview."}
                    </p>
                    {can("portal.settings.manage") && (
                        <div>
                            <Button size="sm" color="secondary" onClick={() => setConfirm(siteOn ? "hidden" : "visible")}>
                                {siteOn ? "Hide the website" : "Make the website visible"}
                            </Button>
                        </div>
                    )}
                </div>
            </section>

            <FormError message={saveDraft.error?.message} />

            <form
                noValidate
                className="flex flex-col gap-8"
                onSubmit={(e) => {
                    e.preventDefault();
                    void saveDraft.submit();
                }}
            >
                <fieldset disabled={!canEdit} className="flex flex-col gap-8">
                    <FormSection title="Welcome" description="The first thing guests see. Names and the date come from Wedding settings → General.">
                        <Input
                            label="Small heading"
                            placeholder="Together with our families"
                            value={content.heroEyebrow}
                            onChange={(v) => setContent({ ...content, heroEyebrow: v })}
                        />
                        <Input
                            label="Title"
                            placeholder="Aidan & Amelia"
                            value={content.heroTitle}
                            onChange={(v) => setContent({ ...content, heroTitle: v })}
                            hint="Leave empty to use your names."
                        />
                        <Input
                            label="Subtitle"
                            placeholder="We're getting married"
                            value={content.heroSubtitle}
                            onChange={(v) => setContent({ ...content, heroSubtitle: v })}
                        />
                        <Select
                            label="Hero photo"
                            items={[{ id: "none", label: "No photo" }, ...media.map((m, i) => ({ id: m.id, label: m.alt || m.caption || `Photo ${i + 1}` }))]}
                            value={content.heroImageId ?? "none"}
                            onChange={(v) => setContent({ ...content, heroImageId: v === "none" ? null : String(v) })}
                            hint="A portrait-shaped photo of the two of you works best. Upload photos in the Photos section below."
                        >
                            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                        </Select>
                        <TextArea
                            label="Welcome message"
                            rows={5}
                            value={content.welcome}
                            onChange={(v) => setContent({ ...content, welcome: v })}
                            hint="Plain text. Blank lines start new paragraphs. The first paragraph is set large, like the opening line of an invitation."
                        />
                    </FormSection>

                    <FormSection title="RSVP invitation" description="The closing section that asks guests to reply. The deadline comes from RSVPs → Settings.">
                        <Input
                            label="Heading"
                            placeholder="We hope you'll celebrate with us."
                            value={content.rsvpHeading}
                            onChange={(v) => setContent({ ...content, rsvpHeading: v })}
                        />
                        <TextArea
                            label="Extra text (optional)"
                            rows={3}
                            value={content.rsvpText}
                            onChange={(v) => setContent({ ...content, rsvpText: v })}
                            hint="For example, how to reply if you'd rather not do it online."
                        />
                    </FormSection>

                    <FormSection
                        title="Sections"
                        description="Turn a section on once its details are confirmed. Hidden sections never appear on the site, even after publishing."
                    >
                        {content.sections.map((section, i) => (
                            <div key={section.id} className="flex flex-col gap-4 rounded-xl bg-secondary p-4">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <div className="flex items-center gap-2">
                                        <Badge size="sm" type="modern" color="gray">
                                            {KINDS[section.kind].label}
                                        </Badge>
                                        {!section.visible && (
                                            <Badge size="sm" type="pill-color" color="gray">
                                                Hidden
                                            </Badge>
                                        )}
                                    </div>
                                    <div className="flex items-center">
                                        <Toggle
                                            size="sm"
                                            label="Show on the site"
                                            isSelected={section.visible}
                                            onChange={(v) => setSection(i, { visible: v })}
                                        />
                                        <ButtonUtility
                                            size="sm"
                                            color="tertiary"
                                            icon={ArrowUp}
                                            tooltip="Move up"
                                            isDisabled={i === 0}
                                            onClick={() => moveSection(i, -1)}
                                        />
                                        <ButtonUtility
                                            size="sm"
                                            color="tertiary"
                                            icon={ArrowDown}
                                            tooltip="Move down"
                                            isDisabled={i === content.sections.length - 1}
                                            onClick={() => moveSection(i, 1)}
                                        />
                                        <ButtonUtility
                                            size="sm"
                                            color="tertiary"
                                            icon={Trash01}
                                            tooltip="Remove section"
                                            onClick={() => setContent({ ...content, sections: content.sections.filter((_, j) => j !== i) })}
                                        />
                                    </div>
                                </div>
                                <Input label="Heading" isRequired value={section.title} onChange={(v) => setSection(i, { title: v })} />
                                <TextArea
                                    label="Text"
                                    rows={4}
                                    value={section.body}
                                    onChange={(v) => setSection(i, { body: v })}
                                    hint="Plain text. Blank lines start new paragraphs."
                                />
                                {PHOTO_KINDS.includes(section.kind) && (
                                    <Select
                                        label="Photo"
                                        items={photoOptions}
                                        value={section.imageId ?? "none"}
                                        onChange={(v) => setSection(i, { imageId: v === "none" ? null : String(v) })}
                                        hint={PHOTO_HINTS[section.kind] ?? "Optional. Without a photo the section uses an illustration or text-only layout."}
                                    >
                                        {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                                    </Select>
                                )}
                                <ItemsEditor
                                    kind={section.kind}
                                    items={section.items}
                                    onChange={(items) => setSection(i, { items })}
                                    photoOptions={photoOptions}
                                />
                            </div>
                        ))}
                        {canEdit && (
                            <Dropdown.Root>
                                <Button size="sm" color="secondary" iconLeading={Plus} iconTrailing={ChevronDown} className="self-start">
                                    Add a section
                                </Button>
                                <Dropdown.Popover className="w-64">
                                    <Dropdown.Menu onAction={(key) => addSection(key as SectionKind)}>
                                        {missingKinds.map((k) => (
                                            <Dropdown.Item key={k} id={k} label={KINDS[k].label} />
                                        ))}
                                    </Dropdown.Menu>
                                </Dropdown.Popover>
                            </Dropdown.Root>
                        )}
                    </FormSection>

                    <FormSection title="Photos" description="Upload photos for the hero image and an optional gallery. JPEG, PNG or WebP, up to 5 MB each.">
                        <Toggle
                            label="Show a photo gallery on the site"
                            isSelected={content.showGallery}
                            onChange={(v) => setContent({ ...content, showGallery: v })}
                        />
                        {canEdit && (
                            <FileUploadDropZone
                                accept="image/jpeg,image/png,image/webp"
                                allowsMultiple
                                maxSize={5 * 1024 * 1024}
                                hint="JPEG, PNG or WebP · up to 5 MB"
                                isDisabled={uploading}
                                onDropFiles={upload}
                                onDropUnacceptedFiles={() => toast.error("Use a JPEG, PNG or WebP photo")}
                                onSizeLimitExceed={() => toast.error("Photos can be up to 5 MB")}
                            />
                        )}
                        {media.length === 0 ? (
                            <p className="flex items-center gap-2 text-sm text-tertiary">
                                <Image01 className="size-4" aria-hidden="true" /> No photos yet.
                            </p>
                        ) : (
                            <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                                {media.map((photo) => (
                                    <li key={photo.id} className="flex flex-col gap-3 rounded-xl bg-secondary p-3">
                                        <img
                                            src={photo.url}
                                            alt={photo.alt}
                                            width={photo.width ?? undefined}
                                            height={photo.height ?? undefined}
                                            className="aspect-[4/3] w-full rounded-lg object-cover"
                                            loading="lazy"
                                        />
                                        <Input
                                            label="Description (for screen readers)"
                                            size="sm"
                                            defaultValue={photo.alt}
                                            onBlur={(e) => e.target.value !== photo.alt && updatePhoto(photo, { alt: e.target.value })}
                                        />
                                        <Input
                                            label="Caption"
                                            size="sm"
                                            defaultValue={photo.caption ?? ""}
                                            onBlur={(e) => e.target.value !== (photo.caption ?? "") && updatePhoto(photo, { caption: e.target.value })}
                                        />
                                        <div className="flex items-center justify-between">
                                            <Toggle
                                                size="sm"
                                                label="In gallery"
                                                isSelected={photo.inGallery}
                                                onChange={(v) => updatePhoto(photo, { inGallery: v })}
                                            />
                                            <ButtonUtility
                                                size="sm"
                                                color="tertiary"
                                                icon={Trash01}
                                                tooltip="Delete photo"
                                                onClick={async () => {
                                                    try {
                                                        await api("DELETE", `/api/portal/wedding/media/${photo.id}`);
                                                        setMedia((list) => list.filter((m) => m.id !== photo.id));
                                                        // Anything that used the photo falls back to no photo.
                                                        setContent((current) => ({
                                                            ...current,
                                                            heroImageId: current.heroImageId === photo.id ? null : current.heroImageId,
                                                            sections: current.sections.map((sec) =>
                                                                sec.imageId === photo.id ? { ...sec, imageId: null } : sec,
                                                            ),
                                                        }));
                                                    } catch (error) {
                                                        toast.error("Couldn't delete", errorMessage(error));
                                                    }
                                                }}
                                            />
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        )}
                        {uploading && (
                            <p className="flex items-center gap-2 text-sm text-tertiary">
                                <UploadCloud02 className="size-4" aria-hidden="true" /> Uploading…
                            </p>
                        )}
                    </FormSection>

                    <FormSection title="Contact and privacy">
                        <Input
                            label="Contact email"
                            type="email"
                            value={content.contactEmail}
                            onChange={(v) => setContent({ ...content, contactEmail: v })}
                            hint={saveDraft.fieldError("contactEmail") ?? "Shown at the bottom of the website for questions."}
                            isInvalid={!!saveDraft.fieldError("contactEmail")}
                        />
                        <Toggle
                            label="Hide from search engines"
                            hint="Recommended. Guests use the link you send them; Google won't list the page."
                            isSelected={content.noindex}
                            onChange={(v) => setContent({ ...content, noindex: v })}
                        />
                    </FormSection>
                </fieldset>
            </form>

            {!siteOn && unpublished && (
                <Notice title="Not live yet">Publishing updates the content, but visitors only see it once the website is made visible.</Notice>
            )}

            <ConfirmDialog
                isOpen={confirm !== null}
                onOpenChange={(o) => !o && setConfirm(null)}
                title={
                    confirm === "publish"
                        ? "Publish these changes?"
                        : confirm === "discard"
                          ? "Discard the draft?"
                          : confirm === "visible"
                            ? "Make the website visible?"
                            : "Hide the website?"
                }
                description={
                    confirm === "publish"
                        ? siteOn
                            ? "The public website will show the draft as it is now. Check the preview first."
                            : "The published version is updated. It stays hidden until the website is made visible."
                        : confirm === "discard"
                          ? "Your unpublished edits are replaced by what's currently published."
                          : confirm === "visible"
                            ? "Anyone with the link will see the published content at /wedding: names, date, venue and public event details."
                            : "Visitors to /wedding will see “not found” until you make it visible again."
                }
                confirmLabel={confirm === "publish" ? "Publish" : confirm === "discard" ? "Discard" : confirm === "visible" ? "Make visible" : "Hide"}
                destructive={confirm === "discard"}
                onConfirm={act}
            />
        </>
    );
};
