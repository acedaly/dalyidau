// The Amplenote plugin that publishes blog notes to the website (docs/AMPLENOTE.md). Amplenote wants a
// plugin note's code block to be a bare object; Portal settings → Website shows exactly that (this
// object without the export), and tests import it as a module.
export default {
    // daly.id.au publisher: an Amplenote plugin (https://www.amplenote.com/help/developing_amplenote_plugins).
    // Paste this whole block as the code block of a plugin note; docs/AMPLENOTE.md has the settings table.
    //
    // Whenever Amplenote loads the plugin or you move around the app (onNavigate), at most every ten
    // minutes, it sends the website every note tagged for the blog: whether Amplenote reports it as
    // published (app.getNotePublicURL) and, for published notes only, its title, website/ tags, dates
    // and content as markdown. It never publishes or changes a note. Drafts send nothing but their id.
    // "Publish to website now" in the app menu (Ctrl/Cmd-O) runs it immediately and shows the result.

    VERSION: "1.0.0",
    INTERVAL_MS: 10 * 60 * 1000,
    RETRY_MS: 2 * 60 * 1000,
    _running: false,
    _nextRun: 0,

    async onNavigate(app) {
        await this._sync(app, false);
    },

    appOption: {
        "Publish to website now": async function (app) {
            await this._sync(app, true);
        },
    },

    async _sync(app, manual) {
        if (this._running || (!manual && Date.now() < this._nextRun)) return;
        const token = (app.settings["Publishing token"] || "").trim();
        const site = (app.settings["Website"] || "https://daly.id.au").trim().replace(/\/+$/, "");
        const tag = (app.settings["Tag"] || "website/blog").trim().replace(/^#/, "").toLowerCase();
        const namespace = tag.includes("/") ? tag.slice(0, tag.lastIndexOf("/")) : tag;
        if (!token) {
            if (manual) await app.alert("Add the publishing token from Portal settings → Website to this plugin's settings first.");
            return;
        }
        this._running = true;
        this._nextRun = Date.now() + this.INTERVAL_MS;
        try {
            const handles = (await app.filterNotes({ tag })) || [];
            const notes = [];
            let complete = true;
            for (const handle of handles) {
                // Notes created offline can have a local-only id until they sync; they're sent next time.
                if (!handle || !/^[0-9a-f-]{36}$/i.test(handle.uuid || "")) {
                    complete = false;
                    continue;
                }
                const tags = (handle.tags || []).map((t) => String(t).toLowerCase()).filter((t) => t === tag || t.startsWith(namespace + "/"));
                let publicUrl = null;
                try {
                    publicUrl = await app.getNotePublicURL({ uuid: handle.uuid });
                } catch (error) {
                    // Offline or the request failed: leave this note out and say the list is incomplete,
                    // so the website changes nothing about it.
                    complete = false;
                    continue;
                }
                const entry = { uuid: handle.uuid, tags, publicUrl: publicUrl || null };
                if (publicUrl) {
                    entry.name = handle.name || null;
                    entry.created = handle.created || null;
                    entry.updated = handle.updated || null;
                    entry.markdown = await app.getNoteContent({ uuid: handle.uuid });
                }
                notes.push(entry);
            }
            const response = await fetch(site + "/api/amplenote/ingest", {
                method: "POST",
                headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
                body: JSON.stringify({ version: 1, complete, notes }),
            });
            const result = await response.json().catch(() => ({}));
            if (response.status === 409) this._nextRun = Date.now() + this.RETRY_MS;
            if (!manual) return;
            if (!response.ok && response.status !== 409) {
                await app.alert("The website didn't accept the update (" + response.status + "): " + (result.message || result.error || "unknown error"));
                return;
            }
            const lines = (result.log || []).slice(0, 12).join("\n");
            await app.alert(
                "Sent " +
                    notes.length +
                    " tagged note(s) to " +
                    site +
                    ".\n" +
                    (result.published || 0) +
                    " published, " +
                    (result.updated || 0) +
                    " updated, " +
                    (result.unpublished || 0) +
                    " unpublished." +
                    (lines ? "\n\n" + lines : ""),
            );
        } catch (error) {
            // Try again sooner after a failure (for example, no connection).
            this._nextRun = Date.now() + this.RETRY_MS;
            if (manual) await app.alert("Couldn't reach the website: " + (error && error.message ? error.message : error));
        } finally {
            this._running = false;
        }
    },
};
