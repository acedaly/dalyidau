// Your favourites across every space you belong to. They're yours alone: nobody else in a shared
// space sees them, and one disappears as soon as you lose access to its space.
import { Star01 } from "@untitledui/icons";
import { Empty } from "@/portal/components/empty";
import type { PageData } from "@/portal/lib/page-types";
import { KnowledgeHeader } from "../knowledge-header";
import { Card, ObjectRows } from "./knowledge-home-page";

export const KnowledgeFavouritesPage = ({ data }: { data: PageData<"knowledge-favourites"> }) => {
    const { space, spaces, types } = data;
    const bySpace = spaces.map((s) => ({ space: s, items: data.favourites.filter((f) => f.spaceId === s.id) })).filter((g) => g.items.length);

    return (
        <>
            <KnowledgeHeader
                title="Favourites"
                description="Your shortcuts. Star any object to add it; only you see your favourites."
                space={space}
                spaces={spaces}
                types={types}
                templates={data.templates}
                crumb="Favourites"
            />
            {bySpace.length ? (
                bySpace.map((group) => (
                    // Only this space's types are loaded; favourites from other spaces show a plain page icon.
                    <Card key={group.space.id} title={bySpace.length > 1 || group.space.id !== space.id ? group.space.name : "This space"} icon={Star01}>
                        <ObjectRows objects={group.items} types={types} />
                    </Card>
                ))
            ) : (
                <Empty icon={Star01} title="No favourites yet" description="Open an object and press the star next to History to keep it here and in the sidebar." />
            )}
        </>
    );
};
