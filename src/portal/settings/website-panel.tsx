// Portal settings → Website & Blog: the blog's Capacities articles and their archive in Cloudflare
// (capacities-card.tsx). Articles are published from Capacities by its sync (Portal settings →
// Features → Website & Blog); publishing from Amplenote was retired (docs/DECOMMISSION_PORTAL_APPS.md),
// and the articles it published stay on the site exactly as they are.
import { CapacitiesCard } from "@/portal/settings/capacities-card";
import type { CapacitiesStatus } from "@/shared/website";

export const WebsitePanel = ({ initial }: { initial: CapacitiesStatus }) => (
    <div className="flex max-w-5xl flex-col gap-6">
        <CapacitiesCard status={initial} />
    </div>
);
