// Untitled UI PRO activity feed, adapted: avatars fall back to initials, the name links only when
// given an href, and messages keep their line breaks.
import { FileIcon } from "@untitledui/file-icons";
import { Avatar } from "@/components/base/avatar/avatar";
import type { BadgeColors } from "@/components/base/badges/badge-types";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Dot } from "@/components/foundations/dot-icon";
import { cx } from "@/utils/cx";

export type FeedItemType = {
    /** Unique identifier for the entry. Not rendered — use it as the React key when mapping over a feed. */
    id: string | number;
    /** Whether the entry is unread, which shows a green dot in the top-right corner of the item. */
    unseen?: boolean;
    /** Quoted text rendered in a `<q>` element below the header, for entries that represent a comment. */
    comment?: string;
    /** Message body rendered in a bordered speech-bubble box at the bottom of the entry. */
    message?: string;
    /** Timestamp shown beside the user's name, rendered in a `<time>` element and used as its `dateTime` value. */
    date?: string;
    /** Machine-readable form of `date` when `date` is a friendly label such as "2 hours ago". */
    dateTime?: string;
    /** The person the entry belongs to. Renders their avatar with an optional status dot, their name as a link to `href`, and an optional `username` line. */
    user: {
        avatarUrl?: string;
        /** Shown when there's no avatar image (the portal stores no profile photos). */
        initials?: string;
        name: string;
        /** Makes the name a link. Omit it to show plain text. */
        href?: string;
        username?: string;
        status?: "online" | "offline";
    };
    /** File attached to the entry. Renders a file type icon (light and dark variants) alongside the file's name and size. */
    attachment?: {
        name: string;
        size: string;
        type: "jpg" | "txt" | "pdf" | "mp4";
    };
    /** Tags rendered as a row of small badges under the header. */
    labels?: {
        name: string;
        // href: "#";
        color: BadgeColors;
    }[];
    /** What the user did, shown under their name. `content` is the sentence, and `target` renders after it as a link to `href`. */
    action?: {
        content: string;
        target?: string;
        href?: string;
    };
};

interface FeedItemProps extends FeedItemType {
    /** Whether to draw a dotted vertical line below the avatar, joining this entry to the next one in the feed and adding spacing beneath it. */
    connector?: boolean;
    /** Size of the entry's avatar. */
    size?: "sm" | "md";
}

export const FeedItem = ({ user, date, dateTime, action, attachment, comment, labels, message, unseen, connector, size = "md" }: FeedItemProps) => {
    return (
        <article className="relative flex gap-3">
            {unseen && <Dot size="md" className="absolute top-0 right-0 text-fg-success-secondary" />}
            <div className="flex shrink-0 flex-col">
                <Avatar src={user.avatarUrl} initials={user.initials} alt={user.name} size={size === "sm" ? "sm" : "md"} status={user.status} />
                {connector && (
                    <div className="relative my-1 flex h-full w-full justify-center self-center overflow-hidden">
                        <svg className="absolute" width="2.4">
                            <line
                                x1="1.2"
                                y1="1.2"
                                x2="1.2"
                                y2="100%"
                                className="stroke-border-primary"
                                stroke="black"
                                strokeWidth="2.4"
                                strokeDasharray="0,6"
                                strokeLinecap="round"
                            />
                        </svg>
                    </div>
                )}
            </div>
            <div className={cx("flex flex-1 flex-col gap-3", connector && "pb-8")}>
                <header>
                    <div className="flex items-center gap-2">
                        {user.href ? (
                            <a
                                href={user.href}
                                className="rounded text-sm font-medium text-secondary outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-2"
                            >
                                {user.name}
                            </a>
                        ) : (
                            <span className="text-sm font-medium text-secondary">{user.name}</span>
                        )}
                        {date && (
                            <time className="text-xs text-tertiary" dateTime={dateTime ?? date}>
                                {date}
                            </time>
                        )}
                    </div>
                    {action && (
                        <p className="text-sm text-tertiary">
                            {action.content}{" "}
                            {action.target && (
                                <Button href={action.href as string} className="inline text-sm font-medium whitespace-normal" color="link-color" size="sm">
                                    {action.target}
                                </Button>
                            )}
                        </p>
                    )}
                    {user.username && <p className="text-sm text-tertiary">{user.username}</p>}
                </header>

                {attachment && (
                    <figure className="flex gap-3">
                        <FileIcon type={attachment.type} theme="light" className="size-10 dark:hidden" />
                        <FileIcon type={attachment.type} theme="dark" className="size-10 not-dark:hidden" />

                        <figcaption>
                            <p className="text-sm font-medium text-secondary">{attachment.name}</p>
                            <p className="text-sm text-tertiary">{attachment.size}</p>
                        </figcaption>
                    </figure>
                )}

                {labels && labels.length > 0 && (
                    <aside className="flex gap-1" aria-label="Labels">
                        {labels.map((label) => (
                            <Badge key={label.name} color={label.color} size="sm">
                                {label.name}
                            </Badge>
                        ))}
                    </aside>
                )}
                {comment && <q className="text-sm text-tertiary">{comment}</q>}
                {message && (
                    <section className={cx("gap-2 rounded-lg rounded-tl-none p-3 ring-1 ring-secondary ring-inset", connector && "py-2.5")}>
                        <p className="text-sm text-secondary">{message}</p>
                    </section>
                )}
            </div>
        </article>
    );
};
