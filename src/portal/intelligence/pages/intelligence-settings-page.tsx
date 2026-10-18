// AI and storage settings: usage against budgets, each person's briefing preferences and AI
// exclusions, and (owners and admins) the feature switches, models, budgets, limits and retention.
// Budgets are the portal's own safeguard: the page says plainly that they aren't a billing cap.
import { useState } from "react";
import { BarChart10, Database01, Settings01, ShieldTick, Stars02, Sunrise } from "@untitledui/icons";
import { Tabs } from "@/components/application/tabs/tabs";
import { Button } from "@/components/base/buttons/button";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { Toggle } from "@/components/base/toggle/toggle";
import { getReadableFileSize } from "@/components/application/file-upload/file-upload-base";
import { FormGrid, FormSection } from "@/portal/components/form";
import { MetricCard } from "@/portal/components/metric-card";
import { Notice } from "@/portal/components/notice";
import { PageHeader } from "@/portal/components/page-header";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import { formatDate, formatNumber } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import {
    BRIEFING_SECTIONS,
    BRIEFING_SECTION_LABELS,
    BUDGET_FEATURES,
    FEATURE_KEYS,
    FEATURE_LABELS,
    type IntelligenceConfig,
    type IntelligencePreferences,
    MODELS,
    type ModelTask,
} from "@/shared/intelligence/config";
import { downloadUrl, intelligenceApi } from "../api";

const ROLES: { key: keyof IntelligenceConfig["models"]; label: string; task: ModelTask; hint: string }[] = [
    { key: "classify", label: "Tags and classification", task: "text", hint: "A small model is enough." },
    { key: "extract", label: "Extraction (tasks, decisions, dates)", task: "text", hint: "Needs reliable JSON." },
    { key: "summarise", label: "Summaries and briefing suggestions", task: "text", hint: "" },
    { key: "synthesis", label: "Detailed meeting summaries", task: "text", hint: "The most capable model; used sparingly." },
    { key: "embed", label: "Embeddings (semantic search)", task: "embed", hint: "Changing it re-embeds everything; dimensions must match the index." },
    { key: "transcribe", label: "Speech to text", task: "transcribe", hint: "" },
];

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const NumberField = ({ label, value, onChange, hint }: { label: string; value: number; onChange: (n: number) => void; hint?: string }) => (
    <Input label={label} type="number" inputMode="numeric" value={String(value)} onChange={(v) => onChange(Math.max(0, Math.round(Number(v) || 0)))} hint={hint} />
);

export const IntelligenceSettingsPage = ({ data }: { data: PageData<"intelligence-settings"> }) => {
    const toast = useToast();
    const [config, setConfig] = useState(data.config);
    const [configVersion, setConfigVersion] = useState(data.configVersion);
    const [prefs, setPrefs] = useState(data.preferences);
    const [prefsVersion, setPrefsVersion] = useState(data.preferencesVersion);
    const [spaces, setSpaces] = useState(data.spaces);
    const [busy, setBusy] = useState<string | null>(null);
    const { usage, storage } = data;

    const run = async (key: string, work: () => Promise<void>, success: string) => {
        setBusy(key);
        try {
            await work();
            toast.success(success);
        } catch (e) {
            toast.error("Couldn't save", errorMessage(e));
        } finally {
            setBusy(null);
        }
    };
    const saveConfig = () =>
        run(
            "config",
            async () => {
                const saved = await intelligenceApi.saveSettings(configVersion, config);
                setConfig(saved.config);
                setConfigVersion(saved.version);
            },
            "Intelligence settings saved",
        );
    const savePrefs = () =>
        run(
            "prefs",
            async () => {
                const saved = await intelligenceApi.savePreferences(prefsVersion, prefs);
                setPrefs(saved.preferences);
                setPrefsVersion(saved.version);
            },
            "Your briefing preferences are saved",
        );
    const setPref = <K extends keyof IntelligencePreferences>(key: K, value: IntelligencePreferences[K]) => setPrefs((p) => ({ ...p, [key]: value }));
    const setBudget = (key: keyof IntelligenceConfig["budgets"], value: unknown) => setConfig((c) => ({ ...c, budgets: { ...c.budgets, [key]: value } }));
    const percent = (used: number, limit: number) => (limit ? Math.min(100, (used / limit) * 100) : 0);
    const manage = data.canManage;

    return (
        <>
            <PageHeader title="AI and storage settings" description="Usage, budgets, models, briefings, privacy and file retention for Daly Intelligence." breadcrumbs={[{ label: "Intelligence", href: "/portal/intelligence" }, { label: "Settings" }]} />
            <Tabs defaultSelectedKey="usage">
                <Tabs.List type="underline" size="sm" className="overflow-x-auto">
                    <Tabs.Item id="usage" icon={BarChart10}>Usage</Tabs.Item>
                    <Tabs.Item id="briefings" icon={Sunrise}>My briefings</Tabs.Item>
                    <Tabs.Item id="privacy" icon={ShieldTick}>Privacy</Tabs.Item>
                    <Tabs.Item id="storage" icon={Database01}>Storage</Tabs.Item>
                    {manage && <Tabs.Item id="features" icon={Stars02}>Features and models</Tabs.Item>}
                    {manage && <Tabs.Item id="budgets" icon={Settings01}>Budgets and limits</Tabs.Item>}
                </Tabs.List>

                <Tabs.Panel id="usage" className="flex flex-col gap-6 pt-8">
                    <Notice title="Budgets are a safeguard, not a billing cap" color="gray">
                        The portal refuses new AI work once a budget is reached. Cloudflare bills what it measures: its rates and the free allowance ({formatNumber(usage.freeNeuronsPerDay)} Neurons a day at present) can change, and two requests at the same moment can both pass the check. Figures are estimates from prices published on {formatDate(usage.pricingAsOf)}; check the Workers AI dashboard for billed usage.
                    </Notice>
                    <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
                        <MetricCard label="Today (account)" value={formatNumber(Math.round(usage.today.neurons))} detail={`of ${formatNumber(usage.budgets.dailyNeurons)} Neurons · ~US$${usage.today.estimatedUsd.toFixed(3)} · ${usage.today.calls} calls`} progress={percent(usage.today.neurons, usage.budgets.dailyNeurons)} />
                        <MetricCard label="This month" value={formatNumber(Math.round(usage.thisMonth.neurons))} detail={`of ${formatNumber(usage.budgets.monthlyNeurons)} Neurons · ~US$${usage.thisMonth.estimatedUsd.toFixed(2)}`} progress={percent(usage.thisMonth.neurons, usage.budgets.monthlyNeurons)} />
                        <MetricCard label="You, today" value={formatNumber(Math.round(usage.mine.neurons))} detail={`of your ${formatNumber(usage.budgets.perUserDailyNeurons)} Neurons · ${usage.mine.failures} failed`} progress={percent(usage.mine.neurons, usage.budgets.perUserDailyNeurons)} />
                    </div>
                    {usage.alerts.length > 0 && (
                        <Notice title="Budget alerts" color="warning">
                            {usage.alerts.map((a) => `${a.scope}: ${a.threshold}% reached (${a.period})`).join(" · ")}
                        </Notice>
                    )}
                    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                        <FormSection title="By feature this month">
                            <ul className="divide-y divide-secondary rounded-xl ring-1 ring-secondary">
                                {usage.byFeature.length ? usage.byFeature.map((f) => <li key={f.feature} className="flex justify-between px-4 py-2 text-sm"><span className="text-secondary">{f.feature}</span><span className="text-tertiary tabular-nums">{formatNumber(f.neurons)} · {f.calls} calls</span></li>) : <li className="px-4 py-3 text-sm text-tertiary">No AI used this month.</li>}
                            </ul>
                        </FormSection>
                        <FormSection title="By model this month">
                            <ul className="divide-y divide-secondary rounded-xl ring-1 ring-secondary">
                                {usage.byModel.length ? usage.byModel.map((m) => <li key={m.model} className="flex justify-between gap-3 px-4 py-2 text-sm"><span className="min-w-0 truncate text-secondary">{m.model}</span><span className="shrink-0 text-tertiary tabular-nums">{formatNumber(m.neurons)}</span></li>) : <li className="px-4 py-3 text-sm text-tertiary">None yet.</li>}
                            </ul>
                        </FormSection>
                    </div>
                    <FormSection title="Last 14 days" description="Neurons per UTC day, all features.">
                        <ol className="flex h-24 items-end gap-1" aria-label="Daily usage">
                            {usage.last14Days.map((d) => (
                                <li key={d.day} className="flex-1" title={`${d.day}: ${d.neurons}`}>
                                    <div className="rounded-sm bg-brand-solid" style={{ height: `${Math.max(2, percent(d.neurons, Math.max(usage.budgets.dailyNeurons, ...usage.last14Days.map((x) => x.neurons))))}%` }} />
                                    <span className="sr-only">{`${d.day}: ${d.neurons} Neurons`}</span>
                                </li>
                            ))}
                        </ol>
                    </FormSection>
                </Tabs.Panel>

                <Tabs.Panel id="briefings" className="flex flex-col gap-6 pt-8">
                    <FormSection title="Sections" description="What your daily briefing includes.">
                        <div className="grid gap-3 sm:grid-cols-2">
                            {BRIEFING_SECTIONS.map((s) => (
                                <Checkbox key={s} label={BRIEFING_SECTION_LABELS[s]} isSelected={prefs.sections.includes(s)} onChange={(on) => setPref("sections", on ? [...prefs.sections, s] : prefs.sections.filter((x) => x !== s))} />
                            ))}
                        </div>
                    </FormSection>
                    <FormSection title="Timing and style">
                        <FormGrid>
                            <Input label="Daily briefing time" type="time" value={prefs.dailyTime} onChange={(v) => setPref("dailyTime", v)} hint="In your Tasks time zone" />
                            <Select label="Weekly review day" value={String(prefs.weeklyDay)} onChange={(k) => setPref("weeklyDay", Number(k))} items={DAYS.map((d, i) => ({ id: String(i), label: d }))}>
                                {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                            </Select>
                            <Input label="Weekly review time" type="time" value={prefs.weeklyTime} onChange={(v) => setPref("weeklyTime", v)} />
                            <Select label="Mode" value={prefs.mode} onChange={(k) => setPref("mode", k as "concise" | "detailed")} items={[{ id: "concise", label: "Concise" }, { id: "detailed", label: "Detailed" }]}>
                                {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                            </Select>
                            <Select label="Scope" value={prefs.scope} onChange={(k) => setPref("scope", k as "personal" | "all")} items={[{ id: "all", label: "Personal and shared" }, { id: "personal", label: "Personal only" }]}>
                                {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                            </Select>
                        </FormGrid>
                        <div className="mt-4 flex flex-col gap-3">
                            <Toggle label="Suggest next actions with AI" hint="When the owner has switched recommendations on." isSelected={prefs.recommendations} onChange={(v) => setPref("recommendations", v)} />
                            <Toggle label="Show a notice when a briefing is ready" hint="In the portal. No email is sent." isSelected={prefs.notifyInApp} onChange={(v) => setPref("notifyInApp", v)} />
                            <Toggle label="Pause scheduled briefings" hint="Opening the briefing still shows today's facts." isSelected={prefs.paused} onChange={(v) => setPref("paused", v)} />
                        </div>
                    </FormSection>
                    <div><Button isLoading={busy === "prefs"} onClick={savePrefs}>Save preferences</Button></div>
                </Tabs.Panel>

                <Tabs.Panel id="privacy" className="flex flex-col gap-6 pt-8">
                    <Notice title="What AI can see" color="gray">
                        AI only ever works with what you can see yourself. A space left out of AI is never embedded or analysed, for anyone in it, and its search vectors are removed. Space editors decide for shared spaces. Leaving a space out of your briefings affects only you.
                    </Notice>
                    <ul className="divide-y divide-secondary rounded-xl ring-1 ring-secondary">
                        {spaces.map((s) => (
                            <li key={s.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                                <span className="text-sm font-medium text-secondary">{s.name} <span className="font-normal text-tertiary">({s.kind}, {s.role})</span></span>
                                <div className="flex flex-wrap gap-4">
                                    <Toggle
                                        label="Exclude from AI"
                                        isSelected={s.excluded}
                                        isDisabled={s.role === "viewer"}
                                        onChange={(v) =>
                                            run(`x-${s.id}`, async () => {
                                                await intelligenceApi.exclude(s.id, v);
                                                setSpaces((list) => list.map((x) => (x.id === s.id ? { ...x, excluded: v } : x)));
                                            }, v ? "Left out of AI" : "Included in AI")
                                        }
                                    />
                                    <Checkbox label="Leave out of my briefings" isSelected={prefs.excludedSpaceIds.includes(s.id)} onChange={(on) => setPref("excludedSpaceIds", on ? [...prefs.excludedSpaceIds, s.id] : prefs.excludedSpaceIds.filter((x) => x !== s.id))} />
                                    {s.role === "owner" && data.status.available.semantic && (
                                        <Button size="sm" color="link-gray" onClick={() => run(`r-${s.id}`, () => intelligenceApi.reindex(s.id).then(() => undefined), "The space will be re-indexed shortly")}>Rebuild index</Button>
                                    )}
                                </div>
                            </li>
                        ))}
                    </ul>
                    <div><Button color="secondary" isLoading={busy === "prefs"} onClick={savePrefs}>Save briefing exclusions</Button></div>
                </Tabs.Panel>

                <Tabs.Panel id="storage" className="flex flex-col gap-6 pt-8">
                    <Notice title="How long files are kept" color="gray">
                        Files kept in Knowledge are permanent until someone deletes them. Task files stay while their task exists, then {config.retention.unreferencedGraceDays} days. Recordings and documents uploaded for processing are deleted {config.retention.temporaryDays} days after processing ({config.retention.failedDays} days if processing failed). Nothing marked to keep is ever deleted automatically.
                    </Notice>
                    <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
                        {storage.totals.map((t) => <MetricCard key={`${t.purpose}-${t.retention}`} label={`${t.purpose} (${t.retention})`} value={getReadableFileSize(t.bytes)} detail={`${formatNumber(t.files)} files, whole portal`} />)}
                    </div>
                    <FormSection title="Your files" description={storage.purgeDue ? `${storage.purgeDue} temporary file(s) are due for deletion within a day.` : undefined}>
                        <ul className="divide-y divide-secondary rounded-xl ring-1 ring-secondary">
                            {storage.attachments.length ? storage.attachments.map((a) => (
                                <li key={a.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                                    <span className="min-w-0">
                                        <span className="block truncate text-sm font-medium text-secondary">{a.filename}</span>
                                        <span className="block text-xs text-tertiary">{getReadableFileSize(a.bytes)} · {a.keep ? "kept permanently" : a.purgeAfter ? `deleted after ${formatDate(a.purgeAfter.slice(0, 10))}` : a.retention}</span>
                                    </span>
                                    <span className="flex gap-2">
                                        <Button size="sm" color="link-gray" href={downloadUrl(a.id)}>Download</Button>
                                        {!a.keep && a.retention === "temporary" && (
                                            <Button size="sm" color="link-destructive" onClick={() => run(`d-${a.id}`, () => intelligenceApi.deleteFile(a.id).then(() => undefined), "File deleted")}>Delete now</Button>
                                        )}
                                    </span>
                                </li>
                            )) : <li className="px-4 py-3 text-sm text-tertiary">You have no files.</li>}
                        </ul>
                    </FormSection>
                </Tabs.Panel>

                {manage && (
                    <Tabs.Panel id="features" className="flex flex-col gap-6 pt-8">
                        <Notice title="Cloudflare bindings" color={data.status.bindings.ai ? "success" : "warning"}>
                            Workers AI: {data.status.bindings.ai ? "connected" : "not connected"} · Vectorize: {data.status.bindings.vectors ? "connected" : "not connected"} · AI Gateway: {data.status.bindings.gateway ? "on" : "off"}. Bindings are added in wrangler.jsonc by the owner (docs/INTELLIGENCE.md); a switch below does nothing without its binding.
                        </Notice>
                        <FormSection title="Features" description="Everything is off by default. Switching Intelligence off stops all AI work at once.">
                            <div className="flex flex-col gap-4">
                                {FEATURE_KEYS.map((k) => (
                                    <Toggle key={k} label={FEATURE_LABELS[k].label} hint={FEATURE_LABELS[k].description} isSelected={config.features[k]} isDisabled={k !== "enabled" && !config.features.enabled} onChange={(v) => setConfig((c) => ({ ...c, features: { ...c.features, [k]: v } }))} />
                                ))}
                            </div>
                        </FormSection>
                        <FormSection title="Models" description="Small models for simple work, larger ones only where they're needed.">
                            <FormGrid>
                                {ROLES.map((r) => (
                                    <Select key={r.key} label={r.label} hint={r.hint || undefined} value={config.models[r.key]} onChange={(k) => k && setConfig((c) => ({ ...c, models: { ...c.models, [r.key]: String(k) } }))} items={MODELS.filter((m) => m.task === r.task).map((m) => ({ id: m.id, label: m.label, supportingText: m.tier }))}>
                                        {(item) => <Select.Item id={item.id} supportingText={item.supportingText}>{item.label}</Select.Item>}
                                    </Select>
                                ))}
                            </FormGrid>
                        </FormSection>
                        {data.status.available.semantic && (
                            <div><Button color="secondary" isLoading={busy === "sync"} onClick={() => run("sync", async () => { const { report } = await intelligenceApi.syncIndex(); toast.success(`Indexed ${report.embedded}, removed ${report.removed}`); }, "Index updated")}>Update the semantic index now</Button></div>
                        )}
                        <div><Button isLoading={busy === "config"} onClick={saveConfig}>Save settings</Button></div>
                    </Tabs.Panel>
                )}

                {manage && (
                    <Tabs.Panel id="budgets" className="flex flex-col gap-6 pt-8">
                        <FormSection title="Budgets (Neurons)" description="Per UTC day unless stated. Defaults stay inside the free daily allocation.">
                            <FormGrid>
                                <NumberField label="Account, per day" value={config.budgets.dailyNeurons} onChange={(n) => setBudget("dailyNeurons", n)} />
                                <NumberField label="Account, per month" value={config.budgets.monthlyNeurons} onChange={(n) => setBudget("monthlyNeurons", n)} />
                                <NumberField label="Each person, per day" value={config.budgets.perUserDailyNeurons} onChange={(n) => setBudget("perUserDailyNeurons", n)} />
                                <NumberField label="Ask before work estimated above" value={config.budgets.confirmAboveNeurons} onChange={(n) => setBudget("confirmAboveNeurons", n)} />
                                {BUDGET_FEATURES.map((f) => (
                                    <NumberField key={f} label={`Feature: ${f}`} value={config.budgets.features[f]} onChange={(n) => setBudget("features", { ...config.budgets.features, [f]: n })} />
                                ))}
                                <NumberField label="Items per background pass" value={config.budgets.maxBatch} onChange={(n) => setBudget("maxBatch", Math.max(1, n))} />
                            </FormGrid>
                        </FormSection>
                        <FormSection title="Processing limits">
                            <FormGrid>
                                <NumberField label="Capture length (characters)" value={config.limits.maxCaptureCharacters} onChange={(n) => setConfig((c) => ({ ...c, limits: { ...c.limits, maxCaptureCharacters: n } }))} />
                                <NumberField label="Context per model call (characters)" value={config.limits.maxContextCharacters} onChange={(n) => setConfig((c) => ({ ...c, limits: { ...c.limits, maxContextCharacters: n } }))} />
                                <NumberField label="Document size (bytes)" value={config.limits.maxDocumentBytes} onChange={(n) => setConfig((c) => ({ ...c, limits: { ...c.limits, maxDocumentBytes: n } }))} />
                                <NumberField label="PDF pages" value={config.limits.maxDocumentPages} onChange={(n) => setConfig((c) => ({ ...c, limits: { ...c.limits, maxDocumentPages: n } }))} />
                                <NumberField label="Recording size (bytes)" value={config.limits.maxAudioBytes} onChange={(n) => setConfig((c) => ({ ...c, limits: { ...c.limits, maxAudioBytes: n } }))} />
                                <NumberField label="Recording length (minutes)" value={config.limits.maxAudioMinutes} onChange={(n) => setConfig((c) => ({ ...c, limits: { ...c.limits, maxAudioMinutes: n } }))} />
                            </FormGrid>
                        </FormSection>
                        <FormSection title="Retention (days)">
                            <FormGrid>
                                <NumberField label="Processed recordings and documents" value={config.retention.temporaryDays} onChange={(n) => setConfig((c) => ({ ...c, retention: { ...c.retention, temporaryDays: n } }))} />
                                <NumberField label="Failed processing files (1–30)" value={config.retention.failedDays} onChange={(n) => setConfig((c) => ({ ...c, retention: { ...c.retention, failedDays: n } }))} />
                                <NumberField label="Task files after the task is deleted" value={config.retention.unreferencedGraceDays} onChange={(n) => setConfig((c) => ({ ...c, retention: { ...c.retention, unreferencedGraceDays: n } }))} />
                                <NumberField label="Stored briefings" value={config.retention.briefingDays} onChange={(n) => setConfig((c) => ({ ...c, retention: { ...c.retention, briefingDays: n } }))} />
                                <NumberField label="Reviewed captures" value={config.retention.captureDays} onChange={(n) => setConfig((c) => ({ ...c, retention: { ...c.retention, captureDays: n } }))} />
                            </FormGrid>
                        </FormSection>
                        <div><Button isLoading={busy === "config"} onClick={saveConfig}>Save settings</Button></div>
                    </Tabs.Panel>
                )}
            </Tabs>
        </>
    );
};
