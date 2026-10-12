import { useState } from "react";
import { ArrowDown, ArrowUp, Eye, Globe02, Plus, Trash01 } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Input } from "@/components/base/input/input";
import { TextArea } from "@/components/base/textarea/textarea";
import { Toggle } from "@/components/base/toggle/toggle";
import { ConfirmDialog } from "@/portal/components/dialog";
import { FormSection, useSubmit } from "@/portal/components/form";
import { Notice } from "@/portal/components/notice";
import { PageHeader } from "@/portal/components/page-header";
import { useToast } from "@/portal/components/toast";
import { api, errorMessage } from "@/portal/lib/api";
import type { PageData } from "@/portal/lib/page-types";
import { usePortal } from "@/portal/portal-context";
import type { Flags } from "@/shared/portal/flags";
import type { WebsiteContent, WebsiteSection } from "@/shared/portal/types";

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

export const WebsitePage = ({ data }: { data: PageData<"website"> }) => {
    const { can, isOn, setFlags, wedding } = usePortal();
    const toast = useToast();
    const [content, setContent] = useState<WebsiteContent>(data.content);
    const [saved, setSaved] = useState<WebsiteContent>(data.content);
    const [confirmPublish, setConfirmPublish] = useState<boolean | null>(null);
    const canEdit = can("wedding.website.edit");
    const published = isOn("wedding.site.public");
    const dirty = JSON.stringify(content) !== JSON.stringify(saved);
    const publicEvents = data.events.filter((e) => e.isPublic);

    const save = useSubmit(() => api<{ value: WebsiteContent }>("PUT", "/api/portal/settings/website", content), {
        success: "Website saved",
        onSuccess: ({ value }) => {
            setContent(value);
            setSaved(value);
        },
    });

    const setSection = (index: number, patch: Partial<WebsiteSection>) =>
        setContent({ ...content, sections: content.sections.map((s, i) => (i === index ? { ...s, ...patch } : s)) });
    const moveSection = (index: number, delta: number) => {
        const sections = [...content.sections];
        [sections[index], sections[index + delta]] = [sections[index + delta], sections[index]];
        setContent({ ...content, sections });
    };

    const setPublished = async (on: boolean) => {
        try {
            const { flags } = await api<{ flags: Flags }>("PUT", "/api/portal/flags/wedding.site.public", { enabled: on });
            setFlags(flags);
            toast.success(on ? "Website published" : "Website hidden", on ? "It's live at /wedding." : "/wedding now returns “not found”.");
        } catch (e) {
            toast.error("Couldn't change the website", errorMessage(e));
        }
    };

    return (
        <>
            <PageHeader
                title="Wedding website"
                description="The public page guests visit for details and to RSVP. It has its own look, separate from this portal."
                breadcrumbs={[{ label: "Website" }]}
                actions={
                    <>
                        <Button color="secondary" iconLeading={Eye} href="/portal/wedding/website/preview" target="_blank">
                            Preview
                        </Button>
                        {canEdit && (
                            <Button onClick={() => save.submit()} isLoading={save.busy} showTextWhileLoading isDisabled={!dirty}>
                                Save changes
                            </Button>
                        )}
                    </>
                }
            />

            <section className="flex flex-col gap-4 rounded-xl bg-primary p-5 shadow-xs ring-1 ring-secondary ring-inset md:flex-row md:items-center md:justify-between">
                <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                        <h2 className="text-md font-semibold text-primary">Visibility</h2>
                        <Badge size="sm" type="pill-color" color={published ? "success" : "gray"}>
                            {published ? "Published" : "Hidden"}
                        </Badge>
                    </div>
                    <p className="text-sm text-tertiary">
                        {published
                            ? "Anyone with the link can see /wedding. Guest details are never shown; RSVPs need a household code."
                            : "Only you can see it, through Preview. Visitors to /wedding get a “not found” page."}
                    </p>
                </div>
                {can("portal.settings.manage") && (
                    <Button color={published ? "secondary" : "primary"} iconLeading={Globe02} onClick={() => setConfirmPublish(!published)}>
                        {published ? "Hide website" : "Publish website"}
                    </Button>
                )}
            </section>

            {!wedding.date && <Notice title="The wedding date isn't set">Add it in Settings → General so the website and countdown can show it.</Notice>}

            <form
                noValidate
                className="flex flex-col gap-8"
                onSubmit={(e) => {
                    e.preventDefault();
                    void save.submit();
                }}
            >
                <fieldset disabled={!canEdit} className="flex flex-col gap-8">
                    <FormSection title="Welcome" description="The first thing guests see. Names and the date come from Settings → General.">
                        <Input
                            label="Small heading"
                            placeholder="Together with their families"
                            value={content.heroEyebrow}
                            onChange={(v) => setContent({ ...content, heroEyebrow: v })}
                        />
                        <Input
                            label="Title"
                            placeholder={`${wedding.partnerOne} & ${wedding.partnerTwo}`}
                            value={content.heroTitle}
                            onChange={(v) => setContent({ ...content, heroTitle: v })}
                            hint="Leave empty to use your names."
                        />
                        <Input label="Subtitle" value={content.heroSubtitle} onChange={(v) => setContent({ ...content, heroSubtitle: v })} />
                        <TextArea
                            label="Welcome message"
                            rows={5}
                            value={content.welcome}
                            onChange={(v) => setContent({ ...content, welcome: v })}
                            hint="Plain text. Blank lines start new paragraphs."
                        />
                    </FormSection>

                    <FormSection title="Schedule" description="Public events appear automatically, in order.">
                        {publicEvents.length === 0 ? (
                            <p className="text-sm text-tertiary">No public events yet.</p>
                        ) : (
                            <ul className="flex flex-wrap gap-2">
                                {publicEvents.map((e) => (
                                    <li key={e.id}>
                                        <Badge size="md" type="modern" color="gray">
                                            {e.name}
                                        </Badge>
                                    </li>
                                ))}
                            </ul>
                        )}
                        <div>
                            <Button size="sm" color="link-color" href="/portal/wedding/events">
                                Manage events
                            </Button>
                        </div>
                    </FormSection>

                    <FormSection title="Sections" description="Travel, accommodation, gifts, FAQs: anything guests need. Sections without text are hidden.">
                        {content.sections.map((section, index) => (
                            <div key={section.id} className="flex flex-col gap-3 rounded-xl bg-secondary p-4">
                                <div className="flex items-end gap-2">
                                    <Input
                                        label="Heading"
                                        value={section.title}
                                        onChange={(v) => setSection(index, { title: v })}
                                        className="flex-1"
                                        isRequired
                                    />
                                    <div className="flex pb-1">
                                        <ButtonUtility
                                            size="sm"
                                            color="tertiary"
                                            icon={ArrowUp}
                                            tooltip="Move up"
                                            isDisabled={index === 0}
                                            onClick={() => moveSection(index, -1)}
                                        />
                                        <ButtonUtility
                                            size="sm"
                                            color="tertiary"
                                            icon={ArrowDown}
                                            tooltip="Move down"
                                            isDisabled={index === content.sections.length - 1}
                                            onClick={() => moveSection(index, 1)}
                                        />
                                        <ButtonUtility
                                            size="sm"
                                            color="tertiary"
                                            icon={Trash01}
                                            tooltip="Remove section"
                                            onClick={() => setContent({ ...content, sections: content.sections.filter((_, i) => i !== index) })}
                                        />
                                    </div>
                                </div>
                                <TextArea label="Text" rows={5} value={section.body} onChange={(v) => setSection(index, { body: v })} />
                            </div>
                        ))}
                        {canEdit && content.sections.length < 20 && (
                            <div>
                                <Button
                                    size="sm"
                                    color="secondary"
                                    iconLeading={Plus}
                                    onClick={() =>
                                        setContent({
                                            ...content,
                                            sections: [
                                                ...content.sections,
                                                {
                                                    id: slug(
                                                        "New section",
                                                        content.sections.map((s) => s.id),
                                                    ),
                                                    title: "New section",
                                                    body: "",
                                                },
                                            ],
                                        })
                                    }
                                >
                                    Add section
                                </Button>
                            </div>
                        )}
                    </FormSection>

                    <FormSection title="Contact and privacy">
                        <Input
                            label="Contact email"
                            type="email"
                            value={content.contactEmail}
                            onChange={(v) => setContent({ ...content, contactEmail: v })}
                            hint={save.fieldError("contactEmail") ?? "Shown at the bottom of the website for questions."}
                            isInvalid={!!save.fieldError("contactEmail")}
                        />
                        <Toggle
                            label="Hide from search engines"
                            hint="Recommended. Guests use the link you send them; Google won't list the page."
                            isSelected={content.noindex}
                            onChange={(v) => setContent({ ...content, noindex: v })}
                        />
                    </FormSection>
                </fieldset>
                {canEdit && (
                    <div className="flex justify-end gap-3">
                        <Button color="secondary" onClick={() => setContent(saved)} isDisabled={!dirty || save.busy}>
                            Discard changes
                        </Button>
                        <Button type="submit" isLoading={save.busy} showTextWhileLoading isDisabled={!dirty}>
                            Save changes
                        </Button>
                    </div>
                )}
            </form>

            <ConfirmDialog
                isOpen={confirmPublish !== null}
                onOpenChange={(o) => !o && setConfirmPublish(null)}
                title={confirmPublish ? "Publish the wedding website?" : "Hide the wedding website?"}
                description={
                    confirmPublish
                        ? "Anyone with the link will be able to see /wedding: names, date, location and public event details. Check the preview first."
                        : "Visitors to /wedding will see a “not found” page until you publish it again."
                }
                confirmLabel={confirmPublish ? "Publish" : "Hide"}
                onConfirm={() => setPublished(!!confirmPublish)}
            />
        </>
    );
};
