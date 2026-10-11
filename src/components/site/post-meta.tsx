import type { PostSummary } from "@/shared/types";
import { formatDate } from "@/utils/format";

export const PostMeta = ({ post, className }: { post: PostSummary; className?: string }) => (
    <p className={className ?? "text-sm text-tertiary"}>
        <time dateTime={post.publishedAt}>{formatDate(post.publishedAt)}</time>
        <span aria-hidden="true" className="px-1.5">
            ·
        </span>
        <span>{post.readingMinutes} min read</span>
    </p>
);
