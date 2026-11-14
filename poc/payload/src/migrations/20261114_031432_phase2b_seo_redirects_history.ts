import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-d1-sqlite'

// `up` is additive only: new tables, new indexes, new nullable columns (see docs/AUDIT-2026-11.md, Phase 2b).
// Edited by hand in one respect: the six `seo_image_id` columns say ON DELETE set null, as every other
// reference to `media` created with its table does. Without it, deleting an image that was ever used as a
// sharing image (even in an old version) would be refused by the database.
// Never run `down` in production.
export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.run(sql`CREATE TABLE \`_navigation_v_version_items\` (
  	\`_order\` integer NOT NULL,
  	\`_parent_id\` integer NOT NULL,
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`label\` text NOT NULL,
  	\`type\` text DEFAULT 'page' NOT NULL,
  	\`page_id\` integer,
  	\`url\` text,
  	\`_uuid\` text,
  	FOREIGN KEY (\`page_id\`) REFERENCES \`pages\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`_parent_id\`) REFERENCES \`_navigation_v\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`CREATE INDEX \`_navigation_v_version_items_order_idx\` ON \`_navigation_v_version_items\` (\`_order\`);`)
  await db.run(sql`CREATE INDEX \`_navigation_v_version_items_parent_id_idx\` ON \`_navigation_v_version_items\` (\`_parent_id\`);`)
  await db.run(sql`CREATE INDEX \`_navigation_v_version_items_page_idx\` ON \`_navigation_v_version_items\` (\`page_id\`);`)
  await db.run(sql`CREATE TABLE \`_navigation_v\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`version_changed_by\` text,
  	\`version_updated_at\` text,
  	\`version_created_at\` text,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
  );
  `)
  await db.run(sql`CREATE INDEX \`_navigation_v_created_at_idx\` ON \`_navigation_v\` (\`created_at\`);`)
  await db.run(sql`CREATE INDEX \`_navigation_v_updated_at_idx\` ON \`_navigation_v\` (\`updated_at\`);`)
  await db.run(sql`CREATE TABLE \`redirects_items\` (
  	\`_order\` integer NOT NULL,
  	\`_parent_id\` integer NOT NULL,
  	\`id\` text PRIMARY KEY NOT NULL,
  	\`from\` text NOT NULL,
  	\`to\` text NOT NULL,
  	\`status\` text DEFAULT '301' NOT NULL,
  	\`enabled\` integer DEFAULT true,
  	\`note\` text,
  	\`created_at\` text,
  	FOREIGN KEY (\`_parent_id\`) REFERENCES \`redirects\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`CREATE INDEX \`redirects_items_order_idx\` ON \`redirects_items\` (\`_order\`);`)
  await db.run(sql`CREATE INDEX \`redirects_items_parent_id_idx\` ON \`redirects_items\` (\`_parent_id\`);`)
  await db.run(sql`CREATE TABLE \`redirects\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`changed_by\` text,
  	\`updated_at\` text,
  	\`created_at\` text
  );
  `)
  await db.run(sql`CREATE TABLE \`_redirects_v_version_items\` (
  	\`_order\` integer NOT NULL,
  	\`_parent_id\` integer NOT NULL,
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`from\` text NOT NULL,
  	\`to\` text NOT NULL,
  	\`status\` text DEFAULT '301' NOT NULL,
  	\`enabled\` integer DEFAULT true,
  	\`note\` text,
  	\`created_at\` text,
  	\`_uuid\` text,
  	FOREIGN KEY (\`_parent_id\`) REFERENCES \`_redirects_v\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`CREATE INDEX \`_redirects_v_version_items_order_idx\` ON \`_redirects_v_version_items\` (\`_order\`);`)
  await db.run(sql`CREATE INDEX \`_redirects_v_version_items_parent_id_idx\` ON \`_redirects_v_version_items\` (\`_parent_id\`);`)
  await db.run(sql`CREATE TABLE \`_redirects_v\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`version_changed_by\` text,
  	\`version_updated_at\` text,
  	\`version_created_at\` text,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
  );
  `)
  await db.run(sql`CREATE INDEX \`_redirects_v_created_at_idx\` ON \`_redirects_v\` (\`created_at\`);`)
  await db.run(sql`CREATE INDEX \`_redirects_v_updated_at_idx\` ON \`_redirects_v\` (\`updated_at\`);`)
  await db.run(sql`CREATE TABLE \`_site_settings_v_version_socials\` (
  	\`_order\` integer NOT NULL,
  	\`_parent_id\` integer NOT NULL,
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`kind\` text NOT NULL,
  	\`label\` text NOT NULL,
  	\`url\` text NOT NULL,
  	\`_uuid\` text,
  	FOREIGN KEY (\`_parent_id\`) REFERENCES \`_site_settings_v\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`CREATE INDEX \`_site_settings_v_version_socials_order_idx\` ON \`_site_settings_v_version_socials\` (\`_order\`);`)
  await db.run(sql`CREATE INDEX \`_site_settings_v_version_socials_parent_id_idx\` ON \`_site_settings_v_version_socials\` (\`_parent_id\`);`)
  await db.run(sql`CREATE TABLE \`_site_settings_v\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`version_name\` text DEFAULT 'Aidan Daly' NOT NULL,
  	\`version_short_name\` text DEFAULT 'AD' NOT NULL,
  	\`version_title\` text DEFAULT 'Aidan Daly' NOT NULL,
  	\`version_description\` text DEFAULT 'Aidan Daly''s little corner of the internet: what I''m thinking, what I''m learning, and the occasional project or idea worth putting into words.' NOT NULL,
  	\`version_blog_title\` text DEFAULT 'Blog' NOT NULL,
  	\`version_blog_description\` text DEFAULT 'What I''m thinking about, what I''m learning, and the occasional project or idea worth putting into words.' NOT NULL,
  	\`version_email\` text DEFAULT 'hello@daly.id.au',
  	\`version_contact_eyebrow\` text DEFAULT 'Contact' NOT NULL,
  	\`version_contact_heading\` text DEFAULT 'Get in touch' NOT NULL,
  	\`version_contact_intro\` text DEFAULT 'Questions, ideas or just saying hello. Here''s where to find me.' NOT NULL,
  	\`version_contact_email_description\` text DEFAULT 'The best way to reach me. I read everything, though replies can take a little while.' NOT NULL,
  	\`version_seo_image_id\` integer,
  	\`version_footer_text\` text,
  	\`version_changed_by\` text,
  	\`version_updated_at\` text,
  	\`version_created_at\` text,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	FOREIGN KEY (\`version_seo_image_id\`) REFERENCES \`media\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE INDEX \`_site_settings_v_version_version_seo_image_idx\` ON \`_site_settings_v\` (\`version_seo_image_id\`);`)
  await db.run(sql`CREATE INDEX \`_site_settings_v_created_at_idx\` ON \`_site_settings_v\` (\`created_at\`);`)
  await db.run(sql`CREATE INDEX \`_site_settings_v_updated_at_idx\` ON \`_site_settings_v\` (\`updated_at\`);`)
  await db.run(sql`ALTER TABLE \`pages\` ADD \`seo_social_title\` text;`)
  await db.run(sql`ALTER TABLE \`pages\` ADD \`seo_social_description\` text;`)
  await db.run(sql`ALTER TABLE \`pages\` ADD \`seo_image_id\` integer REFERENCES media(id) ON DELETE set null;`)
  await db.run(sql`ALTER TABLE \`pages\` ADD \`seo_canonical\` text;`)
  await db.run(sql`ALTER TABLE \`pages\` ADD \`seo_noindex\` integer DEFAULT false;`)
  await db.run(sql`CREATE INDEX \`pages_seo_seo_image_idx\` ON \`pages\` (\`seo_image_id\`);`)
  await db.run(sql`ALTER TABLE \`_pages_v\` ADD \`version_seo_social_title\` text;`)
  await db.run(sql`ALTER TABLE \`_pages_v\` ADD \`version_seo_social_description\` text;`)
  await db.run(sql`ALTER TABLE \`_pages_v\` ADD \`version_seo_image_id\` integer REFERENCES media(id) ON DELETE set null;`)
  await db.run(sql`ALTER TABLE \`_pages_v\` ADD \`version_seo_canonical\` text;`)
  await db.run(sql`ALTER TABLE \`_pages_v\` ADD \`version_seo_noindex\` integer DEFAULT false;`)
  await db.run(sql`CREATE INDEX \`_pages_v_version_seo_version_seo_image_idx\` ON \`_pages_v\` (\`version_seo_image_id\`);`)
  await db.run(sql`ALTER TABLE \`projects\` ADD \`seo_social_title\` text;`)
  await db.run(sql`ALTER TABLE \`projects\` ADD \`seo_social_description\` text;`)
  await db.run(sql`ALTER TABLE \`projects\` ADD \`seo_image_id\` integer REFERENCES media(id) ON DELETE set null;`)
  await db.run(sql`ALTER TABLE \`projects\` ADD \`seo_canonical\` text;`)
  await db.run(sql`ALTER TABLE \`projects\` ADD \`seo_noindex\` integer DEFAULT false;`)
  await db.run(sql`CREATE INDEX \`projects_seo_seo_image_idx\` ON \`projects\` (\`seo_image_id\`);`)
  await db.run(sql`ALTER TABLE \`_projects_v\` ADD \`version_seo_social_title\` text;`)
  await db.run(sql`ALTER TABLE \`_projects_v\` ADD \`version_seo_social_description\` text;`)
  await db.run(sql`ALTER TABLE \`_projects_v\` ADD \`version_seo_image_id\` integer REFERENCES media(id) ON DELETE set null;`)
  await db.run(sql`ALTER TABLE \`_projects_v\` ADD \`version_seo_canonical\` text;`)
  await db.run(sql`ALTER TABLE \`_projects_v\` ADD \`version_seo_noindex\` integer DEFAULT false;`)
  await db.run(sql`CREATE INDEX \`_projects_v_version_seo_version_seo_image_idx\` ON \`_projects_v\` (\`version_seo_image_id\`);`)
  await db.run(sql`ALTER TABLE \`posts\` ADD \`seo_title\` text;`)
  await db.run(sql`ALTER TABLE \`posts\` ADD \`seo_description\` text;`)
  await db.run(sql`ALTER TABLE \`posts\` ADD \`seo_social_title\` text;`)
  await db.run(sql`ALTER TABLE \`posts\` ADD \`seo_social_description\` text;`)
  await db.run(sql`ALTER TABLE \`posts\` ADD \`seo_image_id\` integer REFERENCES media(id) ON DELETE set null;`)
  await db.run(sql`ALTER TABLE \`posts\` ADD \`seo_canonical\` text;`)
  await db.run(sql`ALTER TABLE \`posts\` ADD \`seo_noindex\` integer DEFAULT false;`)
  await db.run(sql`CREATE INDEX \`posts_seo_seo_image_idx\` ON \`posts\` (\`seo_image_id\`);`)
  await db.run(sql`ALTER TABLE \`_posts_v\` ADD \`version_seo_title\` text;`)
  await db.run(sql`ALTER TABLE \`_posts_v\` ADD \`version_seo_description\` text;`)
  await db.run(sql`ALTER TABLE \`_posts_v\` ADD \`version_seo_social_title\` text;`)
  await db.run(sql`ALTER TABLE \`_posts_v\` ADD \`version_seo_social_description\` text;`)
  await db.run(sql`ALTER TABLE \`_posts_v\` ADD \`version_seo_image_id\` integer REFERENCES media(id) ON DELETE set null;`)
  await db.run(sql`ALTER TABLE \`_posts_v\` ADD \`version_seo_canonical\` text;`)
  await db.run(sql`ALTER TABLE \`_posts_v\` ADD \`version_seo_noindex\` integer DEFAULT false;`)
  await db.run(sql`CREATE INDEX \`_posts_v_version_seo_version_seo_image_idx\` ON \`_posts_v\` (\`version_seo_image_id\`);`)
  await db.run(sql`ALTER TABLE \`navigation\` ADD \`changed_by\` text;`)
  await db.run(sql`ALTER TABLE \`site_settings\` ADD \`changed_by\` text;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.run(sql`DROP TABLE \`_navigation_v_version_items\`;`)
  await db.run(sql`DROP TABLE \`_navigation_v\`;`)
  await db.run(sql`DROP TABLE \`redirects_items\`;`)
  await db.run(sql`DROP TABLE \`redirects\`;`)
  await db.run(sql`DROP TABLE \`_redirects_v_version_items\`;`)
  await db.run(sql`DROP TABLE \`_redirects_v\`;`)
  await db.run(sql`DROP TABLE \`_site_settings_v_version_socials\`;`)
  await db.run(sql`DROP TABLE \`_site_settings_v\`;`)
  await db.run(sql`PRAGMA foreign_keys=OFF;`)
  await db.run(sql`CREATE TABLE \`__new_pages\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`title\` text,
  	\`slug\` text,
  	\`lede\` text,
  	\`hero_image_id\` integer,
  	\`content\` text,
  	\`show_buttons\` integer DEFAULT false,
  	\`seo_title\` text,
  	\`seo_description\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`deleted_at\` text,
  	\`_status\` text DEFAULT 'draft',
  	FOREIGN KEY (\`hero_image_id\`) REFERENCES \`media\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`INSERT INTO \`__new_pages\`("id", "title", "slug", "lede", "hero_image_id", "content", "show_buttons", "seo_title", "seo_description", "updated_at", "created_at", "deleted_at", "_status") SELECT "id", "title", "slug", "lede", "hero_image_id", "content", "show_buttons", "seo_title", "seo_description", "updated_at", "created_at", "deleted_at", "_status" FROM \`pages\`;`)
  await db.run(sql`DROP TABLE \`pages\`;`)
  await db.run(sql`ALTER TABLE \`__new_pages\` RENAME TO \`pages\`;`)
  await db.run(sql`PRAGMA foreign_keys=ON;`)
  await db.run(sql`CREATE UNIQUE INDEX \`pages_slug_idx\` ON \`pages\` (\`slug\`);`)
  await db.run(sql`CREATE INDEX \`pages_hero_image_idx\` ON \`pages\` (\`hero_image_id\`);`)
  await db.run(sql`CREATE INDEX \`pages_updated_at_idx\` ON \`pages\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`pages_created_at_idx\` ON \`pages\` (\`created_at\`);`)
  await db.run(sql`CREATE INDEX \`pages_deleted_at_idx\` ON \`pages\` (\`deleted_at\`);`)
  await db.run(sql`CREATE INDEX \`pages__status_idx\` ON \`pages\` (\`_status\`);`)
  await db.run(sql`CREATE TABLE \`__new__pages_v\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`parent_id\` integer,
  	\`version_title\` text,
  	\`version_slug\` text,
  	\`version_lede\` text,
  	\`version_hero_image_id\` integer,
  	\`version_content\` text,
  	\`version_show_buttons\` integer DEFAULT false,
  	\`version_seo_title\` text,
  	\`version_seo_description\` text,
  	\`version_updated_at\` text,
  	\`version_created_at\` text,
  	\`version_deleted_at\` text,
  	\`version__status\` text DEFAULT 'draft',
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`latest\` integer,
  	FOREIGN KEY (\`parent_id\`) REFERENCES \`pages\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`version_hero_image_id\`) REFERENCES \`media\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`INSERT INTO \`__new__pages_v\`("id", "parent_id", "version_title", "version_slug", "version_lede", "version_hero_image_id", "version_content", "version_show_buttons", "version_seo_title", "version_seo_description", "version_updated_at", "version_created_at", "version_deleted_at", "version__status", "created_at", "updated_at", "latest") SELECT "id", "parent_id", "version_title", "version_slug", "version_lede", "version_hero_image_id", "version_content", "version_show_buttons", "version_seo_title", "version_seo_description", "version_updated_at", "version_created_at", "version_deleted_at", "version__status", "created_at", "updated_at", "latest" FROM \`_pages_v\`;`)
  await db.run(sql`DROP TABLE \`_pages_v\`;`)
  await db.run(sql`ALTER TABLE \`__new__pages_v\` RENAME TO \`_pages_v\`;`)
  await db.run(sql`CREATE INDEX \`_pages_v_parent_idx\` ON \`_pages_v\` (\`parent_id\`);`)
  await db.run(sql`CREATE INDEX \`_pages_v_version_version_slug_idx\` ON \`_pages_v\` (\`version_slug\`);`)
  await db.run(sql`CREATE INDEX \`_pages_v_version_version_hero_image_idx\` ON \`_pages_v\` (\`version_hero_image_id\`);`)
  await db.run(sql`CREATE INDEX \`_pages_v_version_version_updated_at_idx\` ON \`_pages_v\` (\`version_updated_at\`);`)
  await db.run(sql`CREATE INDEX \`_pages_v_version_version_created_at_idx\` ON \`_pages_v\` (\`version_created_at\`);`)
  await db.run(sql`CREATE INDEX \`_pages_v_version_version_deleted_at_idx\` ON \`_pages_v\` (\`version_deleted_at\`);`)
  await db.run(sql`CREATE INDEX \`_pages_v_version_version__status_idx\` ON \`_pages_v\` (\`version__status\`);`)
  await db.run(sql`CREATE INDEX \`_pages_v_created_at_idx\` ON \`_pages_v\` (\`created_at\`);`)
  await db.run(sql`CREATE INDEX \`_pages_v_updated_at_idx\` ON \`_pages_v\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`_pages_v_latest_idx\` ON \`_pages_v\` (\`latest\`);`)
  await db.run(sql`CREATE TABLE \`__new_projects\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`title\` text,
  	\`slug\` text,
  	\`summary\` text,
  	\`hero_image_id\` integer,
  	\`content\` text,
  	\`website_url\` text,
  	\`github_url\` text,
  	\`seo_title\` text,
  	\`seo_description\` text,
  	\`status\` text DEFAULT 'active',
  	\`listed\` integer DEFAULT true,
  	\`featured\` integer DEFAULT false,
  	\`order\` numeric DEFAULT 100,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`deleted_at\` text,
  	\`_status\` text DEFAULT 'draft',
  	FOREIGN KEY (\`hero_image_id\`) REFERENCES \`media\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`INSERT INTO \`__new_projects\`("id", "title", "slug", "summary", "hero_image_id", "content", "website_url", "github_url", "seo_title", "seo_description", "status", "listed", "featured", "order", "updated_at", "created_at", "deleted_at", "_status") SELECT "id", "title", "slug", "summary", "hero_image_id", "content", "website_url", "github_url", "seo_title", "seo_description", "status", "listed", "featured", "order", "updated_at", "created_at", "deleted_at", "_status" FROM \`projects\`;`)
  await db.run(sql`DROP TABLE \`projects\`;`)
  await db.run(sql`ALTER TABLE \`__new_projects\` RENAME TO \`projects\`;`)
  await db.run(sql`CREATE UNIQUE INDEX \`projects_slug_idx\` ON \`projects\` (\`slug\`);`)
  await db.run(sql`CREATE INDEX \`projects_hero_image_idx\` ON \`projects\` (\`hero_image_id\`);`)
  await db.run(sql`CREATE INDEX \`projects_updated_at_idx\` ON \`projects\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`projects_created_at_idx\` ON \`projects\` (\`created_at\`);`)
  await db.run(sql`CREATE INDEX \`projects_deleted_at_idx\` ON \`projects\` (\`deleted_at\`);`)
  await db.run(sql`CREATE INDEX \`projects__status_idx\` ON \`projects\` (\`_status\`);`)
  await db.run(sql`CREATE TABLE \`__new__projects_v\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`parent_id\` integer,
  	\`version_title\` text,
  	\`version_slug\` text,
  	\`version_summary\` text,
  	\`version_hero_image_id\` integer,
  	\`version_content\` text,
  	\`version_website_url\` text,
  	\`version_github_url\` text,
  	\`version_seo_title\` text,
  	\`version_seo_description\` text,
  	\`version_status\` text DEFAULT 'active',
  	\`version_listed\` integer DEFAULT true,
  	\`version_featured\` integer DEFAULT false,
  	\`version_order\` numeric DEFAULT 100,
  	\`version_updated_at\` text,
  	\`version_created_at\` text,
  	\`version_deleted_at\` text,
  	\`version__status\` text DEFAULT 'draft',
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`latest\` integer,
  	FOREIGN KEY (\`parent_id\`) REFERENCES \`projects\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`version_hero_image_id\`) REFERENCES \`media\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`INSERT INTO \`__new__projects_v\`("id", "parent_id", "version_title", "version_slug", "version_summary", "version_hero_image_id", "version_content", "version_website_url", "version_github_url", "version_seo_title", "version_seo_description", "version_status", "version_listed", "version_featured", "version_order", "version_updated_at", "version_created_at", "version_deleted_at", "version__status", "created_at", "updated_at", "latest") SELECT "id", "parent_id", "version_title", "version_slug", "version_summary", "version_hero_image_id", "version_content", "version_website_url", "version_github_url", "version_seo_title", "version_seo_description", "version_status", "version_listed", "version_featured", "version_order", "version_updated_at", "version_created_at", "version_deleted_at", "version__status", "created_at", "updated_at", "latest" FROM \`_projects_v\`;`)
  await db.run(sql`DROP TABLE \`_projects_v\`;`)
  await db.run(sql`ALTER TABLE \`__new__projects_v\` RENAME TO \`_projects_v\`;`)
  await db.run(sql`CREATE INDEX \`_projects_v_parent_idx\` ON \`_projects_v\` (\`parent_id\`);`)
  await db.run(sql`CREATE INDEX \`_projects_v_version_version_slug_idx\` ON \`_projects_v\` (\`version_slug\`);`)
  await db.run(sql`CREATE INDEX \`_projects_v_version_version_hero_image_idx\` ON \`_projects_v\` (\`version_hero_image_id\`);`)
  await db.run(sql`CREATE INDEX \`_projects_v_version_version_updated_at_idx\` ON \`_projects_v\` (\`version_updated_at\`);`)
  await db.run(sql`CREATE INDEX \`_projects_v_version_version_created_at_idx\` ON \`_projects_v\` (\`version_created_at\`);`)
  await db.run(sql`CREATE INDEX \`_projects_v_version_version_deleted_at_idx\` ON \`_projects_v\` (\`version_deleted_at\`);`)
  await db.run(sql`CREATE INDEX \`_projects_v_version_version__status_idx\` ON \`_projects_v\` (\`version__status\`);`)
  await db.run(sql`CREATE INDEX \`_projects_v_created_at_idx\` ON \`_projects_v\` (\`created_at\`);`)
  await db.run(sql`CREATE INDEX \`_projects_v_updated_at_idx\` ON \`_projects_v\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`_projects_v_latest_idx\` ON \`_projects_v\` (\`latest\`);`)
  await db.run(sql`CREATE TABLE \`__new_posts\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`title\` text,
  	\`slug\` text,
  	\`subtitle\` text,
  	\`summary\` text,
  	\`hero_image_id\` integer,
  	\`content\` text,
  	\`published_at\` text,
  	\`updated_date\` text,
  	\`category\` text,
  	\`featured\` integer,
  	\`public_id\` text,
  	\`legacy_source\` text,
  	\`legacy_body_html\` text,
  	\`legacy_toc\` text,
  	\`legacy_search_text\` text,
  	\`legacy_word_count\` numeric,
  	\`legacy_reading_minutes\` numeric,
  	\`legacy_image_key\` text,
  	\`legacy_image_alt\` text,
  	\`legacy_image_width\` numeric,
  	\`legacy_image_height\` numeric,
  	\`legacy_original_row\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`deleted_at\` text,
  	\`_status\` text DEFAULT 'draft',
  	FOREIGN KEY (\`hero_image_id\`) REFERENCES \`media\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`INSERT INTO \`__new_posts\`("id", "title", "slug", "subtitle", "summary", "hero_image_id", "content", "published_at", "updated_date", "category", "featured", "public_id", "legacy_source", "legacy_body_html", "legacy_toc", "legacy_search_text", "legacy_word_count", "legacy_reading_minutes", "legacy_image_key", "legacy_image_alt", "legacy_image_width", "legacy_image_height", "legacy_original_row", "updated_at", "created_at", "deleted_at", "_status") SELECT "id", "title", "slug", "subtitle", "summary", "hero_image_id", "content", "published_at", "updated_date", "category", "featured", "public_id", "legacy_source", "legacy_body_html", "legacy_toc", "legacy_search_text", "legacy_word_count", "legacy_reading_minutes", "legacy_image_key", "legacy_image_alt", "legacy_image_width", "legacy_image_height", "legacy_original_row", "updated_at", "created_at", "deleted_at", "_status" FROM \`posts\`;`)
  await db.run(sql`DROP TABLE \`posts\`;`)
  await db.run(sql`ALTER TABLE \`__new_posts\` RENAME TO \`posts\`;`)
  await db.run(sql`CREATE UNIQUE INDEX \`posts_slug_idx\` ON \`posts\` (\`slug\`);`)
  await db.run(sql`CREATE INDEX \`posts_hero_image_idx\` ON \`posts\` (\`hero_image_id\`);`)
  await db.run(sql`CREATE UNIQUE INDEX \`posts_public_id_idx\` ON \`posts\` (\`public_id\`);`)
  await db.run(sql`CREATE INDEX \`posts_updated_at_idx\` ON \`posts\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`posts_created_at_idx\` ON \`posts\` (\`created_at\`);`)
  await db.run(sql`CREATE INDEX \`posts_deleted_at_idx\` ON \`posts\` (\`deleted_at\`);`)
  await db.run(sql`CREATE INDEX \`posts__status_idx\` ON \`posts\` (\`_status\`);`)
  await db.run(sql`CREATE TABLE \`__new__posts_v\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`parent_id\` integer,
  	\`version_title\` text,
  	\`version_slug\` text,
  	\`version_subtitle\` text,
  	\`version_summary\` text,
  	\`version_hero_image_id\` integer,
  	\`version_content\` text,
  	\`version_published_at\` text,
  	\`version_updated_date\` text,
  	\`version_category\` text,
  	\`version_featured\` integer,
  	\`version_public_id\` text,
  	\`version_legacy_source\` text,
  	\`version_legacy_body_html\` text,
  	\`version_legacy_toc\` text,
  	\`version_legacy_search_text\` text,
  	\`version_legacy_word_count\` numeric,
  	\`version_legacy_reading_minutes\` numeric,
  	\`version_legacy_image_key\` text,
  	\`version_legacy_image_alt\` text,
  	\`version_legacy_image_width\` numeric,
  	\`version_legacy_image_height\` numeric,
  	\`version_legacy_original_row\` text,
  	\`version_updated_at\` text,
  	\`version_created_at\` text,
  	\`version_deleted_at\` text,
  	\`version__status\` text DEFAULT 'draft',
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`latest\` integer,
  	FOREIGN KEY (\`parent_id\`) REFERENCES \`posts\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`version_hero_image_id\`) REFERENCES \`media\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`INSERT INTO \`__new__posts_v\`("id", "parent_id", "version_title", "version_slug", "version_subtitle", "version_summary", "version_hero_image_id", "version_content", "version_published_at", "version_updated_date", "version_category", "version_featured", "version_public_id", "version_legacy_source", "version_legacy_body_html", "version_legacy_toc", "version_legacy_search_text", "version_legacy_word_count", "version_legacy_reading_minutes", "version_legacy_image_key", "version_legacy_image_alt", "version_legacy_image_width", "version_legacy_image_height", "version_legacy_original_row", "version_updated_at", "version_created_at", "version_deleted_at", "version__status", "created_at", "updated_at", "latest") SELECT "id", "parent_id", "version_title", "version_slug", "version_subtitle", "version_summary", "version_hero_image_id", "version_content", "version_published_at", "version_updated_date", "version_category", "version_featured", "version_public_id", "version_legacy_source", "version_legacy_body_html", "version_legacy_toc", "version_legacy_search_text", "version_legacy_word_count", "version_legacy_reading_minutes", "version_legacy_image_key", "version_legacy_image_alt", "version_legacy_image_width", "version_legacy_image_height", "version_legacy_original_row", "version_updated_at", "version_created_at", "version_deleted_at", "version__status", "created_at", "updated_at", "latest" FROM \`_posts_v\`;`)
  await db.run(sql`DROP TABLE \`_posts_v\`;`)
  await db.run(sql`ALTER TABLE \`__new__posts_v\` RENAME TO \`_posts_v\`;`)
  await db.run(sql`CREATE INDEX \`_posts_v_parent_idx\` ON \`_posts_v\` (\`parent_id\`);`)
  await db.run(sql`CREATE INDEX \`_posts_v_version_version_slug_idx\` ON \`_posts_v\` (\`version_slug\`);`)
  await db.run(sql`CREATE INDEX \`_posts_v_version_version_hero_image_idx\` ON \`_posts_v\` (\`version_hero_image_id\`);`)
  await db.run(sql`CREATE INDEX \`_posts_v_version_version_public_id_idx\` ON \`_posts_v\` (\`version_public_id\`);`)
  await db.run(sql`CREATE INDEX \`_posts_v_version_version_updated_at_idx\` ON \`_posts_v\` (\`version_updated_at\`);`)
  await db.run(sql`CREATE INDEX \`_posts_v_version_version_created_at_idx\` ON \`_posts_v\` (\`version_created_at\`);`)
  await db.run(sql`CREATE INDEX \`_posts_v_version_version_deleted_at_idx\` ON \`_posts_v\` (\`version_deleted_at\`);`)
  await db.run(sql`CREATE INDEX \`_posts_v_version_version__status_idx\` ON \`_posts_v\` (\`version__status\`);`)
  await db.run(sql`CREATE INDEX \`_posts_v_created_at_idx\` ON \`_posts_v\` (\`created_at\`);`)
  await db.run(sql`CREATE INDEX \`_posts_v_updated_at_idx\` ON \`_posts_v\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`_posts_v_latest_idx\` ON \`_posts_v\` (\`latest\`);`)
  await db.run(sql`ALTER TABLE \`navigation\` DROP COLUMN \`changed_by\`;`)
  await db.run(sql`ALTER TABLE \`site_settings\` DROP COLUMN \`changed_by\`;`)
}
