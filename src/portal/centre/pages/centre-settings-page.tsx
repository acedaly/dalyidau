// Settings: your own preferences (Today, emails, quiet hours, calendar matching) for everyone, and
// the account's settings (retention, gauges, air quality sites, correlation) for owners and admins.
import { useState } from "react";
import { Settings01 } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Input } from "@/components/base/input/input";
import { NativeSelect } from "@/components/base/select/select-native";
import { Toggle } from "@/components/base/toggle/toggle";
import { FormGrid, FormSection } from "@/portal/components/form";
import { useToast } from "@/portal/components/toast";
import { Card } from "@/portal/knowledge/pages/knowledge-home-page";
import { errorMessage } from "@/portal/lib/api";
import type { PageData } from "@/portal/lib/page-types";
import type { CentrePreferences, CentreSettings } from "@/shared/centre/types";
import { centreApi } from "../centre-api";
import { CentreHeader, CentreNotices } from "../shared";

export const CentreSettingsPage = ({ data }: { data: PageData<"centre-settings"> }) => {
    const toast = useToast();
    const [prefs, setPrefs] = useState<CentrePreferences>(data.preferences);
    const [prefsVersion, setPrefsVersion] = useState(data.preferencesVersion);
    const [settings, setSettings] = useState<CentreSettings>(data.settings);
    const [settingsVersion, setSettingsVersion] = useState(data.settingsVersion);
    const [gaugesText, setGaugesText] = useState(data.settings.gauges.join(", "));
    const [busy, setBusy] = useState<"prefs" | "settings" | null>(null);

    const savePrefs = async () => {
        setBusy("prefs");
        try {
            const r = await centreApi.savePreferences(prefs, prefsVersion);
            setPrefs(r.preferences);
            setPrefsVersion(r.version);
            toast.success("Preferences saved");
        } catch (e) {
            toast.error("Couldn't save", errorMessage(e));
        } finally {
            setBusy(null);
        }
    };
    const saveSettings = async () => {
        setBusy("settings");
        try {
            const gauges = gaugesText
                .split(/[\s,]+/)
                .map((g) => g.trim())
                .filter(Boolean);
            const r = await centreApi.saveSettings({ ...settings, gauges }, settingsVersion);
            setSettings(r.settings);
            setSettingsVersion(r.version);
            toast.success("Settings saved");
        } catch (e) {
            toast.error("Couldn't save", errorMessage(e));
        } finally {
            setBusy(null);
        }
    };
    const retention = (key: keyof CentreSettings["retention"], label: string, hint?: string) => (
        <Input
            label={label}
            type="number"
            hint={hint}
            value={String(settings.retention[key])}
            onChange={(v) => setSettings((s) => ({ ...s, retention: { ...s.retention, [key]: Number(v) } }))}
            isDisabled={!data.canManage}
        />
    );

    return (
        <>
            <CentreHeader
                title="Settings"
                crumb="Settings"
                shell={data}
                description="Your own preferences, and how the Centre collects and keeps public information."
            />
            <CentreNotices shell={data} />
            <Card title="My preferences" icon={Settings01}>
                <form
                    className="flex flex-col gap-6 px-4 py-5 sm:px-5"
                    onSubmit={(e) => {
                        e.preventDefault();
                        void savePrefs();
                    }}
                >
                    <FormSection title="Today" description="A short Intelligence section on Today, only for your watch areas.">
                        <div className="flex flex-col gap-3">
                            <Toggle
                                label="Show it on Today"
                                isSelected={prefs.today.enabled}
                                onChange={(enabled) => setPrefs((p) => ({ ...p, today: { ...p.today, enabled } }))}
                            />
                            <Toggle
                                label="Include fire danger for my districts"
                                isSelected={prefs.today.showFireDanger}
                                onChange={(showFireDanger) => setPrefs((p) => ({ ...p, today: { ...p.today, showFireDanger } }))}
                            />
                            {(
                                [
                                    ["developments", "Significant changes in my watch areas"],
                                    ["ruleMatches", "My monitoring rules' matches"],
                                    ["reports", "The latest scheduled report"],
                                    ["sourceFailures", "Failures of the main warning sources"],
                                ] as const
                            ).map(([key, label]) => (
                                <Toggle
                                    key={key}
                                    label={label}
                                    isSelected={prefs.today[key]}
                                    onChange={(on) => setPrefs((p) => ({ ...p, today: { ...p.today, [key]: on } }))}
                                />
                            ))}
                            <NativeSelect
                                label="Incidents and warnings from"
                                value={String(prefs.today.minLevel)}
                                onChange={(e) => setPrefs((p) => ({ ...p, today: { ...p.today, minLevel: Number(e.target.value) } }))}
                                options={[
                                    { label: "Any", value: "0" },
                                    { label: "Advice and above", value: "1" },
                                    { label: "Watch and Act and above", value: "2" },
                                    { label: "Emergency Warning only", value: "3" },
                                ]}
                            />
                        </div>
                    </FormSection>
                    <FormSection
                        title="Email"
                        description={
                            data.emailOn
                                ? "Off unless you choose. Alerts email only for watch areas with email turned on. Delivery isn't guaranteed and never replaces official warnings."
                                : "Email from the Centre is switched off for the portal (Portal settings → Features). You can choose now; nothing is sent until it's on."
                        }
                    >
                        <div className="flex flex-col gap-3">
                            <Toggle
                                label="Email me alerts"
                                isSelected={prefs.email.alerts}
                                onChange={(alerts) => setPrefs((p) => ({ ...p, email: { ...p.email, alerts } }))}
                            />
                            <Toggle
                                label="Daily summary email"
                                isSelected={prefs.email.digest}
                                onChange={(digest) => setPrefs((p) => ({ ...p, email: { ...p.email, digest } }))}
                            />
                            <Input
                                label="Summary hour (0–23)"
                                type="number"
                                value={String(prefs.email.digestHour)}
                                onChange={(v) => setPrefs((p) => ({ ...p, email: { ...p.email, digestHour: Number(v) } }))}
                            />
                        </div>
                    </FormSection>
                    <FormSection
                        title="Quiet hours"
                        description="Emails wait until quiet hours end (in-app alerts still appear). A watch area's own quiet hours take precedence."
                    >
                        <FormGrid>
                            <Input
                                label="From"
                                type="time"
                                value={prefs.quietHours?.start ?? ""}
                                onChange={(v) => setPrefs((p) => ({ ...p, quietHours: v ? { start: v, end: p.quietHours?.end ?? "07:00" } : null }))}
                            />
                            <Input
                                label="Until"
                                type="time"
                                value={prefs.quietHours?.end ?? ""}
                                onChange={(v) => setPrefs((p) => ({ ...p, quietHours: p.quietHours ? { ...p.quietHours, end: v || "07:00" } : null }))}
                                isDisabled={!prefs.quietHours}
                            />
                        </FormGrid>
                    </FormSection>
                    <FormSection
                        title="Calendar"
                        description="Compare the locations of your events in the next seven days with places named in current official warnings and incidents. Private and sensitive events are never read."
                    >
                        <Toggle
                            label="Check my upcoming events"
                            isSelected={prefs.calendarMatching}
                            onChange={(calendarMatching) => setPrefs((p) => ({ ...p, calendarMatching }))}
                        />
                    </FormSection>
                    <div>
                        <Button size="md" type="submit" isLoading={busy === "prefs"} showTextWhileLoading>
                            Save preferences
                        </Button>
                    </div>
                </form>
            </Card>
            <Card title={data.canManage ? "Account settings" : "Account settings (owners and admins change these)"}>
                <form
                    className="flex flex-col gap-6 px-4 py-5 sm:px-5"
                    onSubmit={(e) => {
                        e.preventDefault();
                        void saveSettings();
                    }}
                >
                    <FormSection
                        title="River gauges"
                        description="BoM Water Data Online station numbers to follow (up to 20), e.g. 410001. Find them on the Water Data Online map."
                    >
                        <Input label="Station numbers" value={gaugesText} onChange={setGaugesText} isDisabled={!data.canManage} placeholder="410001, 212200" />
                    </FormSection>
                    <FormSection
                        title="Air quality sites"
                        description="Fewer sites give fresher readings: the NSW API is slow for many sites at once, so they're read a few at a time. None ticked: every site, in turn."
                    >
                        {data.airSites.length ? (
                            <div className="grid max-h-64 grid-cols-1 gap-2 overflow-y-auto sm:grid-cols-2">
                                {data.airSites.map((s) => (
                                    <Checkbox
                                        key={s.id}
                                        label={`${s.name} (${s.region})`}
                                        isDisabled={!data.canManage}
                                        isSelected={settings.airSites.includes(s.id)}
                                        onChange={(on) =>
                                            setSettings((x) => ({ ...x, airSites: on ? [...x.airSites, s.id] : x.airSites.filter((y) => y !== s.id) }))
                                        }
                                    />
                                ))}
                            </div>
                        ) : (
                            <p className="text-sm text-tertiary">The site list appears after the air quality source's first collection.</p>
                        )}
                    </FormSection>
                    <FormSection title="Retention" description="How long history is kept. Raw snapshots are kept only for sources whose terms allow history.">
                        <FormGrid>
                            {retention("recordDays", "Records no longer current (days)")}
                            {retention("changeDays", "Changes (days)")}
                            {retention("seriesDays", "Measurements (days)")}
                            {retention("fetchRunDays", "Collection history (days)")}
                            {retention("alertDays", "Alerts (days)")}
                            {retention("snapshotsPerSource", "Raw snapshots per source", "0 keeps none")}
                            {retention("versionDays", "Record history for timelines and replay (days)", "Replay can't go back further than this")}
                            {retention("sourceDailyDays", "Daily source reliability (days)")}
                            {retention("ruleMatchDays", "Monitoring rule matches (days)")}
                            {retention("reportDays", "Situation reports (days)")}
                        </FormGrid>
                    </FormSection>
                    <FormSection
                        title="Basemap"
                        description="The detailed map is served from this site's own storage: no map company sees which areas are viewed."
                    >
                        <NativeSelect
                            label="Map background"
                            value={settings.basemap}
                            onChange={(e) => setSettings((s) => ({ ...s, basemap: e.target.value as CentreSettings["basemap"] }))}
                            disabled={!data.canManage}
                            options={[
                                { label: "Detailed (towns, roads, waterways, boundaries, labels)", value: "detailed" },
                                { label: "Outline of the states only", value: "outline" },
                            ]}
                            hint="Detailed needs the OpenStreetMap basemap archive installed (docs/INTELLIGENCE_CENTRE_9_1.md); until then maps show the outline."
                        />
                    </FormSection>
                    <FormSection title="Correlation" description="How near and how recent records must be to be shown as possibly related.">
                        <FormGrid>
                            <Input
                                label="Distance (km)"
                                type="number"
                                value={String(settings.correlation.distanceKm)}
                                onChange={(v) => setSettings((s) => ({ ...s, correlation: { ...s.correlation, distanceKm: Number(v) } }))}
                                isDisabled={!data.canManage}
                            />
                            <Input
                                label="Window (hours)"
                                type="number"
                                value={String(settings.correlation.windowHours)}
                                onChange={(v) => setSettings((s) => ({ ...s, correlation: { ...s.correlation, windowHours: Number(v) } }))}
                                isDisabled={!data.canManage}
                            />
                            <Input
                                label="Material river level change (m)"
                                type="number"
                                value={String(settings.riverChangeMetres)}
                                onChange={(v) => setSettings((s) => ({ ...s, riverChangeMetres: Number(v) }))}
                                isDisabled={!data.canManage}
                            />
                            <Input
                                label="Records on the map at once"
                                type="number"
                                value={String(settings.maxMapRecords)}
                                onChange={(v) => setSettings((s) => ({ ...s, maxMapRecords: Number(v) }))}
                                isDisabled={!data.canManage}
                            />
                        </FormGrid>
                    </FormSection>
                    {data.canManage && (
                        <div>
                            <Button size="md" type="submit" isLoading={busy === "settings"} showTextWhileLoading>
                                Save settings
                            </Button>
                        </div>
                    )}
                </form>
            </Card>
        </>
    );
};
