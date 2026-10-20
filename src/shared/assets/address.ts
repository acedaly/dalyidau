// An asset's portal address, as printed in its QR label, and recognising one when it's scanned.
// The address holds the asset's id and the label version only: nothing private, nothing that
// grants access (opening it still needs the Cloudflare Access sign-in and the asset's own rights).

export const assetPath = (id: string) => `/portal/assets/item/${id}`;

export const assetAddress = (site: string, id: string, labelVersion?: number) =>
    `${site.replace(/\/+$/, "")}${assetPath(id)}${labelVersion ? `?v=${labelVersion}` : ""}`;

/** Where a scanned code points, if it's one of this portal's asset addresses. Anything else is null and is never followed. */
export function parseAssetAddress(text: string, site: string): { id: string; labelVersion: number | null } | null {
    let url: URL;
    try {
        url = new URL(text.trim());
    } catch {
        return null;
    }
    if (url.origin !== new URL(site).origin) return null;
    const match = /^\/portal\/assets\/item\/(ast_[a-z0-9]{14})$/.exec(url.pathname);
    if (!match) return null;
    const v = Number(url.searchParams.get("v"));
    return { id: match[1], labelVersion: Number.isInteger(v) && v > 0 ? v : null };
}
