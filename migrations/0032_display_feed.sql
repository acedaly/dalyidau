-- Display feed credentials (docs/INTELLIGENCE_CENTRE.md#display-feed). A display credential's scope
-- says what it may read: 'wallboard' (every credential issued before this migration) reads its own
-- wallboard at /api/display/wallboard, and 'display:<name>' reads only /api/display/feed. Additive:
-- existing credentials keep working unchanged.
ALTER TABLE ic_display_tokens ADD COLUMN scope TEXT NOT NULL DEFAULT 'wallboard';
