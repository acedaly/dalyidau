/**
 * A deliberately unindexed test of Amplenote's official published-note embed.
 *
 * This does not read private notes or alter the existing Capacities publishing pipeline.
 * The iframe and deferred embed script are permitted by CSP only on this route.
 * Article discovery, metadata automation, RSS and server-rendered indexing are NOT included.
 */
export const AmplenotePreviewPage = () => (
    <article className="mx-auto max-w-container px-4 py-12 md:px-8 md:py-20">
        <div className="mx-auto max-w-3xl">
            <a href="/blog" className="personal-text-link text-sm font-semibold text-secondary underline underline-offset-4">
                Back to the writing
            </a>
            <p className="personal-eyebrow mt-14 text-sm text-tertiary">PUBLISHING EXPERIMENT</p>
            <h1 className="personal-display mt-4 text-[clamp(3rem,6vw,5rem)] leading-[1.04] text-primary">
                A note from Amplenote.
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-relaxed text-secondary">
                An early preview of how a published Amplenote article could look here.
                The note below is live from Amplenote; this page is unlisted and excluded from search indexing.
            </p>
        </div>
        <div className="amplenote-preview-panel mx-auto mt-12 max-w-4xl p-4 md:mt-16 md:p-10">
            <div className="amplenote-embed" data-note-token="32pmddtDM8Xfgwca3nbmfTLm">
                <iframe
                    title="Published Amplenote article"
                    src="https://public.amplenote.com/embed/32pmddtDM8Xfgwca3nbmfTLm"
                    loading="lazy"
                    referrerPolicy="strict-origin-when-cross-origin"
                />
            </div>
        </div>
        <p className="mx-auto mt-6 max-w-3xl text-sm leading-relaxed text-tertiary">
            If the embedded note does not display,{" "}
            <a
                className="personal-text-link underline underline-offset-4"
                href="https://public.amplenote.com/embed/32pmddtDM8Xfgwca3nbmfTLm"
                target="_blank"
                rel="noopener noreferrer"
            >
                open the published note directly
            </a>
            . The embed's layout is controlled by Amplenote; the surrounding page uses this site's styling.
        </p>
    </article>
);
