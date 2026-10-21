// Portal settings → Website & Blog: Amplenote publishing. Nothing here is per article: articles are
// published by tagging and publishing them in Amplenote. This page is for the one-time setup (the
// plugin, the optional API connection) and for seeing what each tagged note is doing and why.
import { useEffect, useState } from "react";
import { BookOpen01, Code02, Link03, RefreshCw01, Stars02 } from "@untitledui/icons";
import { Badge, type BadgeColor } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { CopyCode } from "@/portal/components/copy-code";
import { Notice } from "@/portal/components/notice";
import { Timestamp } from "@/portal/components/timestamp";
import { useToast } from "@/portal/components/toast";
import { api, errorMessage } from "@/portal/lib/api";
import { SettingsCard, StatusRow } from "@/portal/settings/settings-card";
import type { AmplenoteStatus } from "@/shared/website";
import pluginSource from "../../../amplenote/plugin.js?raw";

/** What goes in the plugin note's code block: the plugin object itself, without the module wrapper. */
const pluginCode = pluginSource.slice(pluginSource.indexOf("export default ") + "export default ".length).replace(/;\s*$/, "\n");

const STATES: Record<AmplenoteStatus["articles"][number]["state"], { label: string; color: BadgeColor<"pill-color"> }> = {
    published: { label: "Published", color: "success" },
    pending: { label: "Not published", color: "gray" },
    withdrawn: { label: "Unpublished", color: "warning" },
};

const CONNECT_RESULTS: Record<string, { title: string; color: "success" | "warning" | "error"; body: string }> = {
    connected: { title: "Amplenote API connected", color: "success", body: "The website now checks your blog notes with Amplenote every 15 minutes." },
    declined: { title: "Amplenote wasn't connected", color: "warning", body: "The sign-in was cancelled in Amplenote. Nothing changed." },
    expired: { title: "That sign-in had expired", color: "warning", body: "Start again with Connect Amplenote. Sign-ins last ten minutes." },
    failed: {
        title: "Amplenote didn't complete the connection",
        color: "error",
        body: "Check that the redirect address below is registered for your Amplenote API application, then try again.",
    },
};

const PLUGIN_TABLE = (tag: string) =>
    [
        "| | |",
        "|-|-|",
        "| name | daly.id.au publisher |",
        "| icon | publish |",
        `| description | Publishes notes tagged ${tag} (and published in Amplenote) to the website. |`,
        "| setting | Publishing token |",
        "| setting | Website |",
        "| setting | Tag |",
    ].join("\n");

export const WebsitePanel = ({ initial }: { initial: AmplenoteStatus }) => {
    const toast = useToast();
    const [status, setStatus] = useState(initial);
    const [busy, setBusy] = useState<"connect" | "check" | "disconnect" | null>(null);
    const [result, setResult] = useState<string | null>(null);

    useEffect(() => {
        // The OAuth callback lands back here with ?amplenote=…; show it once, then tidy the address.
        const value = new URLSearchParams(window.location.search).get("amplenote");
        if (value && CONNECT_RESULTS[value]) {
            setResult(value);
            window.history.replaceState(null, "", window.location.pathname);
        }
    }, []);

    const run = async (kind: "connect" | "check" | "disconnect") => {
        setBusy(kind);
        try {
            if (kind === "connect") {
                const { url } = await api<{ url: string }>("POST", "/api/portal/website/amplenote/connect", {});
                window.location.assign(url);
                return;
            }
            if (kind === "check") {
                const response = await api<{ status: AmplenoteStatus; summary: { published: number; updated: number; unpublished: number; status: string } }>(
                    "POST",
                    "/api/portal/website/amplenote/check",
                    {},
                );
                setStatus(response.status);
                const { summary } = response;
                if (summary.status === "skipped") toast.success("Nothing to check yet", "Another check is running, or publishing isn't set up.");
                else toast.success("Checked", `${summary.published} published, ${summary.updated} updated, ${summary.unpublished} unpublished`);
            } else {
                setStatus((await api<{ status: AmplenoteStatus }>("POST", "/api/portal/website/amplenote/disconnect", {})).status);
                toast.success("Amplenote API disconnected");
            }
        } catch (error) {
            toast.error("That didn't work", errorMessage(error));
        } finally {
            setBusy(null);
        }
    };

    const published = status.articles.filter((a) => a.state === "published").length;
    const message = result ? CONNECT_RESULTS[result] : null;

    return (
        <div className="flex max-w-5xl flex-col gap-6">
            {message && (
                <Notice title={message.title} color={message.color}>
                    {message.body}
                </Notice>
            )}

            <SettingsCard
                id="website-how"
                icon={BookOpen01}
                title="How articles are published"
                description="Write in Amplenote. Nothing is entered here for each article."
            >
                <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm text-secondary">
                    <li>Write the article as an Amplenote note. Its title becomes the article's title.</li>
                    <li>
                        Tag it <code className="rounded bg-secondary px-1 font-mono">{status.tag}</code>, and use Amplenote's Publish.
                    </li>
                    <li>The next time the plugin runs (when you next move around Amplenote, at most every ten minutes) it appears on the blog.</li>
                    <li>Edits follow the same way. Unpublishing it or removing the tag takes it off the website; the note itself is never changed.</li>
                </ol>
                <p className="text-sm text-tertiary">
                    Optional: tags <code className="font-mono">website/category/…</code>, <code className="font-mono">website/tag/…</code> and{" "}
                    <code className="font-mono">website/featured</code>, and a section headed “Website” with lines such as{" "}
                    <code className="font-mono">summary: …</code> or <code className="font-mono">slug: …</code>.
                </p>
            </SettingsCard>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                <SettingsCard
                    id="website-plugin"
                    icon={Code02}
                    title="Amplenote plugin"
                    description="Sends tagged notes from Amplenote, with each published note's link and content. Installed once."
                >
                    <dl className="flex flex-col divide-y divide-secondary">
                        <StatusRow
                            label="Publishing token"
                            detail="AMPLENOTE_PUBLISH_TOKEN on the Worker; paste the same value into the plugin's settings."
                            value={status.configured.plugin ? "Set" : "Not set"}
                            ok={status.configured.plugin}
                        />
                    </dl>
                    <details className="group rounded-lg ring-1 ring-secondary ring-inset">
                        <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-primary">Set up the plugin</summary>
                        <div className="flex flex-col gap-3 border-t border-secondary px-4 py-4 text-sm text-tertiary">
                            <p>1. In Amplenote, create a note named “daly.id.au publisher” and paste this table (the plugin's settings) at the top:</p>
                            <div className="flex items-start gap-2">
                                <pre className="min-w-0 flex-1 overflow-x-auto rounded-md bg-secondary p-3 font-mono text-xs text-secondary">
                                    {PLUGIN_TABLE(status.tag)}
                                </pre>
                                <CopyCode code={PLUGIN_TABLE(status.tag)} label="Copy table" hideCode />
                            </div>
                            <p>2. Below it, add a code block containing the plugin's code:</p>
                            <div className="flex items-start gap-2">
                                <pre className="max-h-48 min-w-0 flex-1 overflow-auto rounded-md bg-secondary p-3 font-mono text-xs text-secondary">
                                    {pluginCode}
                                </pre>
                                <CopyCode code={pluginCode} label="Copy plugin code" hideCode />
                            </div>
                            <p>
                                3. In Amplenote, open Settings → Plugins, choose this note next to “Add a plugin” and select Add Plugin. Then open its settings
                                (the gear icon) and fill in “Publishing token” (and “Website” if this isn't {new URL(status.ingestUrl).origin}).
                            </p>
                            <p>4. Run “daly.id.au publisher: Publish to website now” from the app menu once to confirm it works.</p>
                        </div>
                    </details>
                </SettingsCard>

                <SettingsCard
                    id="website-api"
                    icon={Link03}
                    title="Amplenote API"
                    description="Optional and read-only. Every 15 minutes it confirms each article is still published, tagged and not deleted, and follows title changes, even while Amplenote is closed."
                    actions={
                        status.connection ? (
                            <div className="flex gap-2">
                                <Button
                                    size="sm"
                                    color="secondary"
                                    isDisabled={!status.configured.api}
                                    isLoading={busy === "connect"}
                                    onClick={() => run("connect")}
                                >
                                    Reconnect
                                </Button>
                                <Button size="sm" color="secondary-destructive" isLoading={busy === "disconnect"} onClick={() => run("disconnect")}>
                                    Disconnect
                                </Button>
                            </div>
                        ) : (
                            <Button
                                size="sm"
                                color="secondary"
                                isDisabled={!status.configured.api}
                                isLoading={busy === "connect"}
                                onClick={() => run("connect")}
                            >
                                Connect Amplenote
                            </Button>
                        )
                    }
                >
                    <dl className="flex flex-col divide-y divide-secondary">
                        <StatusRow
                            label="API application"
                            detail="AMPLENOTE_CLIENT_ID and AMPLENOTE_TOKEN_KEY on the Worker."
                            value={status.configured.api ? "Configured" : "Not set up"}
                            ok={status.configured.api}
                        />
                        <StatusRow
                            label="Connection"
                            detail={status.connection ? `By ${status.connection.connectedBy}` : "Asks Amplenote only to list notes (notes:list)."}
                            value={status.connection ? "Connected" : "Not connected"}
                            ok={!!status.connection && !status.connection.lastError}
                        />
                    </dl>
                    {status.connection && (
                        <dl className="flex flex-col gap-1 text-sm">
                            <div className="flex justify-between gap-4">
                                <dt className="text-tertiary">Connected</dt>
                                <dd className="text-primary">
                                    <Timestamp iso={status.connection.connectedAt} relative />
                                </dd>
                            </div>
                            <div className="flex justify-between gap-4">
                                <dt className="text-tertiary">Last full check with Amplenote</dt>
                                <dd className="text-primary">
                                    {status.connection.fullListedAt ? <Timestamp iso={status.connection.fullListedAt} relative /> : "Not yet"}
                                </dd>
                            </div>
                        </dl>
                    )}
                    {status.connection?.lastError && (
                        <Notice title="The last check had a problem" color="warning">
                            {status.connection.lastError}
                        </Notice>
                    )}
                    <div className="flex flex-col gap-1 text-sm text-tertiary">
                        <span>Redirect address to register with Amplenote:</span>
                        <CopyCode code={status.redirectUri} label="Copy address" />
                    </div>
                </SettingsCard>
            </div>

            <SettingsCard
                id="website-articles"
                icon={Stars02}
                title="Amplenote articles"
                description={
                    <>
                        {published} published. Notes tagged {status.tag} that aren't public show why.
                        {status.runs[0]?.finishedAt && (
                            <>
                                {" "}
                                Last sync <Timestamp iso={status.runs[0].finishedAt} relative /> ({status.runs[0].status}).
                            </>
                        )}
                    </>
                }
                actions={
                    <Button size="sm" color="secondary" iconLeading={RefreshCw01} isLoading={busy === "check"} onClick={() => run("check")}>
                        Check now
                    </Button>
                }
            >
                {status.articles.length === 0 ? (
                    <p className="text-sm text-tertiary">No tagged notes have been reported yet.</p>
                ) : (
                    <ul className="flex flex-col divide-y divide-secondary" aria-label="Amplenote articles">
                        {status.articles.map((article) => (
                            <li
                                key={article.uuid}
                                className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
                            >
                                <div className="min-w-0">
                                    <p className="text-sm font-medium break-words text-primary">
                                        {article.state === "published" && article.slug ? (
                                            <a href={`/blog/${article.slug}`} className="underline underline-offset-2">
                                                {article.title}
                                            </a>
                                        ) : (
                                            (article.title ?? `Unpublished note ${article.uuid.slice(0, 8)}`)
                                        )}
                                    </p>
                                    {article.reason && <p className="text-sm text-tertiary">{article.reason}</p>}
                                    <p className="text-xs text-quaternary">
                                        Updated <Timestamp iso={article.updatedAt} relative />
                                    </p>
                                </div>
                                <Badge size="sm" color={STATES[article.state].color} className="shrink-0">
                                    {STATES[article.state].label}
                                </Badge>
                            </li>
                        ))}
                    </ul>
                )}
                {status.runs.length > 0 && (
                    <details className="rounded-lg ring-1 ring-secondary ring-inset">
                        <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-primary">Recent runs</summary>
                        <ul className="flex flex-col divide-y divide-secondary border-t border-secondary text-sm">
                            {status.runs.map((run) => (
                                <li key={run.id} className="flex flex-col gap-1 px-4 py-3">
                                    <span className="font-medium text-primary">
                                        {run.trigger.replace("amplenote:", "")} · {run.status}
                                        {run.finishedAt && (
                                            <>
                                                {" "}
                                                · <Timestamp iso={run.finishedAt} relative />
                                            </>
                                        )}
                                    </span>
                                    {run.log.length > 0 && <span className="break-words whitespace-pre-line text-tertiary">{run.log.join("\n")}</span>}
                                </li>
                            ))}
                        </ul>
                    </details>
                )}
            </SettingsCard>
        </div>
    );
};
