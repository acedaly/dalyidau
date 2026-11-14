-- Search and sharing settings for a post published from Payload (docs/AUDIT-2026-11.md, Phase 2b): a JSON
-- object (title, description, canonical, socialTitle, socialDescription, image, noindex), or NULL when the
-- post sets none and the defaults apply. Additive: earlier code never reads or writes the column.
-- (0032 and 0033 are the held-back files in docs/pending; their numbers stay reserved.)
ALTER TABLE posts ADD COLUMN seo TEXT;
