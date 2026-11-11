import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-d1-sqlite'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.run(sql`CREATE TABLE \`homepage_about_paragraphs\` (
  	\`_order\` integer NOT NULL,
  	\`_parent_id\` integer NOT NULL,
  	\`id\` text PRIMARY KEY NOT NULL,
  	\`text\` text,
  	FOREIGN KEY (\`_parent_id\`) REFERENCES \`homepage\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`CREATE INDEX \`homepage_about_paragraphs_order_idx\` ON \`homepage_about_paragraphs\` (\`_order\`);`)
  await db.run(sql`CREATE INDEX \`homepage_about_paragraphs_parent_id_idx\` ON \`homepage_about_paragraphs\` (\`_parent_id\`);`)
  await db.run(sql`CREATE TABLE \`homepage\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`eyebrow\` text DEFAULT 'HELLO, I''M AIDAN',
  	\`heading\` text DEFAULT 'Some things are worth',
  	\`heading_emphasis\` text DEFAULT 'writing down.',
  	\`intro\` text DEFAULT 'A place for what I''m learning about people, work and the projects I get carried away with. Not everything fits a theme. That''s fine with me.',
  	\`cta_label\` text DEFAULT 'Have a read',
  	\`cta_href\` text DEFAULT '/blog',
  	\`latest_eyebrow\` text DEFAULT 'From the notebook',
  	\`latest_heading\` text DEFAULT 'Recent writing',
  	\`latest_count\` numeric DEFAULT 3,
  	\`about_heading\` text DEFAULT 'An assortment, really.',
  	\`show_contact_line\` integer DEFAULT true,
  	\`seo_title\` text,
  	\`seo_description\` text,
  	\`_status\` text DEFAULT 'draft',
  	\`updated_at\` text,
  	\`created_at\` text
  );
  `)
  await db.run(sql`CREATE INDEX \`homepage__status_idx\` ON \`homepage\` (\`_status\`);`)
  await db.run(sql`CREATE TABLE \`_homepage_v_version_about_paragraphs\` (
  	\`_order\` integer NOT NULL,
  	\`_parent_id\` integer NOT NULL,
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`text\` text,
  	\`_uuid\` text,
  	FOREIGN KEY (\`_parent_id\`) REFERENCES \`_homepage_v\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`CREATE INDEX \`_homepage_v_version_about_paragraphs_order_idx\` ON \`_homepage_v_version_about_paragraphs\` (\`_order\`);`)
  await db.run(sql`CREATE INDEX \`_homepage_v_version_about_paragraphs_parent_id_idx\` ON \`_homepage_v_version_about_paragraphs\` (\`_parent_id\`);`)
  await db.run(sql`CREATE TABLE \`_homepage_v\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`version_eyebrow\` text DEFAULT 'HELLO, I''M AIDAN',
  	\`version_heading\` text DEFAULT 'Some things are worth',
  	\`version_heading_emphasis\` text DEFAULT 'writing down.',
  	\`version_intro\` text DEFAULT 'A place for what I''m learning about people, work and the projects I get carried away with. Not everything fits a theme. That''s fine with me.',
  	\`version_cta_label\` text DEFAULT 'Have a read',
  	\`version_cta_href\` text DEFAULT '/blog',
  	\`version_latest_eyebrow\` text DEFAULT 'From the notebook',
  	\`version_latest_heading\` text DEFAULT 'Recent writing',
  	\`version_latest_count\` numeric DEFAULT 3,
  	\`version_about_heading\` text DEFAULT 'An assortment, really.',
  	\`version_show_contact_line\` integer DEFAULT true,
  	\`version_seo_title\` text,
  	\`version_seo_description\` text,
  	\`version__status\` text DEFAULT 'draft',
  	\`version_updated_at\` text,
  	\`version_created_at\` text,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`latest\` integer
  );
  `)
  await db.run(sql`CREATE INDEX \`_homepage_v_version_version__status_idx\` ON \`_homepage_v\` (\`version__status\`);`)
  await db.run(sql`CREATE INDEX \`_homepage_v_created_at_idx\` ON \`_homepage_v\` (\`created_at\`);`)
  await db.run(sql`CREATE INDEX \`_homepage_v_updated_at_idx\` ON \`_homepage_v\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`_homepage_v_latest_idx\` ON \`_homepage_v\` (\`latest\`);`)
  await db.run(sql`CREATE TABLE \`navigation_items\` (
  	\`_order\` integer NOT NULL,
  	\`_parent_id\` integer NOT NULL,
  	\`id\` text PRIMARY KEY NOT NULL,
  	\`label\` text NOT NULL,
  	\`type\` text DEFAULT 'page' NOT NULL,
  	\`page_id\` integer,
  	\`url\` text,
  	FOREIGN KEY (\`page_id\`) REFERENCES \`pages\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`_parent_id\`) REFERENCES \`navigation\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`CREATE INDEX \`navigation_items_order_idx\` ON \`navigation_items\` (\`_order\`);`)
  await db.run(sql`CREATE INDEX \`navigation_items_parent_id_idx\` ON \`navigation_items\` (\`_parent_id\`);`)
  await db.run(sql`CREATE INDEX \`navigation_items_page_idx\` ON \`navigation_items\` (\`page_id\`);`)
  await db.run(sql`CREATE TABLE \`navigation\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`updated_at\` text,
  	\`created_at\` text
  );
  `)
  await db.run(sql`CREATE TABLE \`site_settings_socials\` (
  	\`_order\` integer NOT NULL,
  	\`_parent_id\` integer NOT NULL,
  	\`id\` text PRIMARY KEY NOT NULL,
  	\`kind\` text NOT NULL,
  	\`label\` text NOT NULL,
  	\`url\` text NOT NULL,
  	FOREIGN KEY (\`_parent_id\`) REFERENCES \`site_settings\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`CREATE INDEX \`site_settings_socials_order_idx\` ON \`site_settings_socials\` (\`_order\`);`)
  await db.run(sql`CREATE INDEX \`site_settings_socials_parent_id_idx\` ON \`site_settings_socials\` (\`_parent_id\`);`)
  await db.run(sql`CREATE TABLE \`site_settings\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`name\` text DEFAULT 'Aidan Daly' NOT NULL,
  	\`short_name\` text DEFAULT 'AD' NOT NULL,
  	\`title\` text DEFAULT 'Aidan Daly' NOT NULL,
  	\`description\` text DEFAULT 'Aidan Daly''s little corner of the internet: what I''m thinking, what I''m learning, and the occasional project or idea worth putting into words.' NOT NULL,
  	\`blog_title\` text DEFAULT 'Blog' NOT NULL,
  	\`blog_description\` text DEFAULT 'What I''m thinking about, what I''m learning, and the occasional project or idea worth putting into words.' NOT NULL,
  	\`email\` text DEFAULT 'hello@daly.id.au',
  	\`contact_eyebrow\` text DEFAULT 'Contact' NOT NULL,
  	\`contact_heading\` text DEFAULT 'Get in touch' NOT NULL,
  	\`contact_intro\` text DEFAULT 'Questions, ideas or just saying hello. Here''s where to find me.' NOT NULL,
  	\`contact_email_description\` text DEFAULT 'The best way to reach me. I read everything, though replies can take a little while.' NOT NULL,
  	\`seo_image_id\` integer,
  	\`footer_text\` text,
  	\`updated_at\` text,
  	\`created_at\` text,
  	FOREIGN KEY (\`seo_image_id\`) REFERENCES \`media\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE INDEX \`site_settings_seo_image_idx\` ON \`site_settings\` (\`seo_image_id\`);`)
  await db.run(sql`ALTER TABLE \`pages\` ADD \`lede\` text;`)
  await db.run(sql`ALTER TABLE \`pages\` ADD \`hero_image_id\` integer REFERENCES media(id);`)
  await db.run(sql`ALTER TABLE \`pages\` ADD \`show_buttons\` integer DEFAULT false;`)
  await db.run(sql`ALTER TABLE \`pages\` ADD \`seo_title\` text;`)
  await db.run(sql`ALTER TABLE \`pages\` ADD \`seo_description\` text;`)
  await db.run(sql`ALTER TABLE \`pages\` ADD \`deleted_at\` text;`)
  await db.run(sql`CREATE INDEX \`pages_hero_image_idx\` ON \`pages\` (\`hero_image_id\`);`)
  await db.run(sql`CREATE INDEX \`pages_deleted_at_idx\` ON \`pages\` (\`deleted_at\`);`)
  await db.run(sql`ALTER TABLE \`_pages_v\` ADD \`version_lede\` text;`)
  await db.run(sql`ALTER TABLE \`_pages_v\` ADD \`version_hero_image_id\` integer REFERENCES media(id);`)
  await db.run(sql`ALTER TABLE \`_pages_v\` ADD \`version_show_buttons\` integer DEFAULT false;`)
  await db.run(sql`ALTER TABLE \`_pages_v\` ADD \`version_seo_title\` text;`)
  await db.run(sql`ALTER TABLE \`_pages_v\` ADD \`version_seo_description\` text;`)
  await db.run(sql`ALTER TABLE \`_pages_v\` ADD \`version_deleted_at\` text;`)
  await db.run(sql`CREATE INDEX \`_pages_v_version_version_hero_image_idx\` ON \`_pages_v\` (\`version_hero_image_id\`);`)
  await db.run(sql`CREATE INDEX \`_pages_v_version_version_deleted_at_idx\` ON \`_pages_v\` (\`version_deleted_at\`);`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.run(sql`DROP TABLE \`homepage_about_paragraphs\`;`)
  await db.run(sql`DROP TABLE \`homepage\`;`)
  await db.run(sql`DROP TABLE \`_homepage_v_version_about_paragraphs\`;`)
  await db.run(sql`DROP TABLE \`_homepage_v\`;`)
  await db.run(sql`DROP TABLE \`navigation_items\`;`)
  await db.run(sql`DROP TABLE \`navigation\`;`)
  await db.run(sql`DROP TABLE \`site_settings_socials\`;`)
  await db.run(sql`DROP TABLE \`site_settings\`;`)
  await db.run(sql`PRAGMA foreign_keys=OFF;`)
  await db.run(sql`CREATE TABLE \`__new_pages\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`title\` text,
  	\`slug\` text,
  	\`content\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`_status\` text DEFAULT 'draft'
  );
  `)
  await db.run(sql`INSERT INTO \`__new_pages\`("id", "title", "slug", "content", "updated_at", "created_at", "_status") SELECT "id", "title", "slug", "content", "updated_at", "created_at", "_status" FROM \`pages\`;`)
  await db.run(sql`DROP TABLE \`pages\`;`)
  await db.run(sql`ALTER TABLE \`__new_pages\` RENAME TO \`pages\`;`)
  await db.run(sql`PRAGMA foreign_keys=ON;`)
  await db.run(sql`CREATE UNIQUE INDEX \`pages_slug_idx\` ON \`pages\` (\`slug\`);`)
  await db.run(sql`CREATE INDEX \`pages_updated_at_idx\` ON \`pages\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`pages_created_at_idx\` ON \`pages\` (\`created_at\`);`)
  await db.run(sql`CREATE INDEX \`pages__status_idx\` ON \`pages\` (\`_status\`);`)
  await db.run(sql`CREATE TABLE \`__new__pages_v\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`parent_id\` integer,
  	\`version_title\` text,
  	\`version_slug\` text,
  	\`version_content\` text,
  	\`version_updated_at\` text,
  	\`version_created_at\` text,
  	\`version__status\` text DEFAULT 'draft',
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`latest\` integer,
  	FOREIGN KEY (\`parent_id\`) REFERENCES \`pages\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`INSERT INTO \`__new__pages_v\`("id", "parent_id", "version_title", "version_slug", "version_content", "version_updated_at", "version_created_at", "version__status", "created_at", "updated_at", "latest") SELECT "id", "parent_id", "version_title", "version_slug", "version_content", "version_updated_at", "version_created_at", "version__status", "created_at", "updated_at", "latest" FROM \`_pages_v\`;`)
  await db.run(sql`DROP TABLE \`_pages_v\`;`)
  await db.run(sql`ALTER TABLE \`__new__pages_v\` RENAME TO \`_pages_v\`;`)
  await db.run(sql`CREATE INDEX \`_pages_v_parent_idx\` ON \`_pages_v\` (\`parent_id\`);`)
  await db.run(sql`CREATE INDEX \`_pages_v_version_version_slug_idx\` ON \`_pages_v\` (\`version_slug\`);`)
  await db.run(sql`CREATE INDEX \`_pages_v_version_version_updated_at_idx\` ON \`_pages_v\` (\`version_updated_at\`);`)
  await db.run(sql`CREATE INDEX \`_pages_v_version_version_created_at_idx\` ON \`_pages_v\` (\`version_created_at\`);`)
  await db.run(sql`CREATE INDEX \`_pages_v_version_version__status_idx\` ON \`_pages_v\` (\`version__status\`);`)
  await db.run(sql`CREATE INDEX \`_pages_v_created_at_idx\` ON \`_pages_v\` (\`created_at\`);`)
  await db.run(sql`CREATE INDEX \`_pages_v_updated_at_idx\` ON \`_pages_v\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`_pages_v_latest_idx\` ON \`_pages_v\` (\`latest\`);`)
}
