// Today's Home & Assets section: what's overdue or due soon, each a sentence from a record with a
// link. Only for people who can open Home & Assets and kept it on
// (Home & Assets → Settings). Nothing shows when nothing is due.
import { ArrowRight, Package } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { AttentionList } from "@/portal/assets/shared";
import { Card } from "@/portal/components/card";
import type { TodayAssets } from "@/shared/assets/types";

export const AssetsTodaySection = ({ assets }: { assets: TodayAssets }) => {
    if (!assets.items.length) return null;
    return (
        <Card
            title="Home & Assets"
            icon={Package}
            action={
                <Button size="sm" color="link-color" iconTrailing={ArrowRight} href="/portal/assets">
                    {assets.total > assets.items.length ? `All ${assets.total}` : "Open"}
                </Button>
            }
        >
            <AttentionList items={assets.items} />
            <p className="border-t border-secondary px-4 py-2 text-xs text-quaternary sm:px-5">Due within {assets.horizonDays} days, from your records.</p>
        </Card>
    );
};
