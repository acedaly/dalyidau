import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-d1-sqlite'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.run(sql`CREATE TABLE \`projects_gallery\` (
  	\`_order\` integer NOT NULL,
  	\`_parent_id\` integer NOT NULL,
  	\`id\` text PRIMARY KEY NOT NULL,
  	\`image_id\` integer,
  	\`caption\` text,
  	FOREIGN KEY (\`image_id\`) REFERENCES \`media\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`_parent_id\`) REFERENCES \`projects\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`CREATE INDEX \`projects_gallery_order_idx\` ON \`projects_gallery\` (\`_order\`);`)
  await db.run(sql`CREATE INDEX \`projects_gallery_parent_id_idx\` ON \`projects_gallery\` (\`_parent_id\`);`)
  await db.run(sql`CREATE INDEX \`projects_gallery_image_idx\` ON \`projects_gallery\` (\`image_id\`);`)
  await db.run(sql`CREATE TABLE \`projects_links\` (
  	\`_order\` integer NOT NULL,
  	\`_parent_id\` integer NOT NULL,
  	\`id\` text PRIMARY KEY NOT NULL,
  	\`label\` text,
  	\`url\` text,
  	FOREIGN KEY (\`_parent_id\`) REFERENCES \`projects\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`CREATE INDEX \`projects_links_order_idx\` ON \`projects_links\` (\`_order\`);`)
  await db.run(sql`CREATE INDEX \`projects_links_parent_id_idx\` ON \`projects_links\` (\`_parent_id\`);`)
  await db.run(sql`CREATE TABLE \`projects_tags\` (
  	\`_order\` integer NOT NULL,
  	\`_parent_id\` integer NOT NULL,
  	\`id\` text PRIMARY KEY NOT NULL,
  	\`tag\` text,
  	FOREIGN KEY (\`_parent_id\`) REFERENCES \`projects\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`CREATE INDEX \`projects_tags_order_idx\` ON \`projects_tags\` (\`_order\`);`)
  await db.run(sql`CREATE INDEX \`projects_tags_parent_id_idx\` ON \`projects_tags\` (\`_parent_id\`);`)
  await db.run(sql`CREATE TABLE \`projects\` (
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
  await db.run(sql`CREATE UNIQUE INDEX \`projects_slug_idx\` ON \`projects\` (\`slug\`);`)
  await db.run(sql`CREATE INDEX \`projects_hero_image_idx\` ON \`projects\` (\`hero_image_id\`);`)
  await db.run(sql`CREATE INDEX \`projects_updated_at_idx\` ON \`projects\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`projects_created_at_idx\` ON \`projects\` (\`created_at\`);`)
  await db.run(sql`CREATE INDEX \`projects_deleted_at_idx\` ON \`projects\` (\`deleted_at\`);`)
  await db.run(sql`CREATE INDEX \`projects__status_idx\` ON \`projects\` (\`_status\`);`)
  await db.run(sql`CREATE TABLE \`_projects_v_version_gallery\` (
  	\`_order\` integer NOT NULL,
  	\`_parent_id\` integer NOT NULL,
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`image_id\` integer,
  	\`caption\` text,
  	\`_uuid\` text,
  	FOREIGN KEY (\`image_id\`) REFERENCES \`media\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`_parent_id\`) REFERENCES \`_projects_v\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`CREATE INDEX \`_projects_v_version_gallery_order_idx\` ON \`_projects_v_version_gallery\` (\`_order\`);`)
  await db.run(sql`CREATE INDEX \`_projects_v_version_gallery_parent_id_idx\` ON \`_projects_v_version_gallery\` (\`_parent_id\`);`)
  await db.run(sql`CREATE INDEX \`_projects_v_version_gallery_image_idx\` ON \`_projects_v_version_gallery\` (\`image_id\`);`)
  await db.run(sql`CREATE TABLE \`_projects_v_version_links\` (
  	\`_order\` integer NOT NULL,
  	\`_parent_id\` integer NOT NULL,
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`label\` text,
  	\`url\` text,
  	\`_uuid\` text,
  	FOREIGN KEY (\`_parent_id\`) REFERENCES \`_projects_v\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`CREATE INDEX \`_projects_v_version_links_order_idx\` ON \`_projects_v_version_links\` (\`_order\`);`)
  await db.run(sql`CREATE INDEX \`_projects_v_version_links_parent_id_idx\` ON \`_projects_v_version_links\` (\`_parent_id\`);`)
  await db.run(sql`CREATE TABLE \`_projects_v_version_tags\` (
  	\`_order\` integer NOT NULL,
  	\`_parent_id\` integer NOT NULL,
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`tag\` text,
  	\`_uuid\` text,
  	FOREIGN KEY (\`_parent_id\`) REFERENCES \`_projects_v\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`CREATE INDEX \`_projects_v_version_tags_order_idx\` ON \`_projects_v_version_tags\` (\`_order\`);`)
  await db.run(sql`CREATE INDEX \`_projects_v_version_tags_parent_id_idx\` ON \`_projects_v_version_tags\` (\`_parent_id\`);`)
  await db.run(sql`CREATE TABLE \`_projects_v\` (
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
  await db.run(sql`ALTER TABLE \`payload_locked_documents_rels\` ADD \`projects_id\` integer REFERENCES projects(id);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_projects_id_idx\` ON \`payload_locked_documents_rels\` (\`projects_id\`);`)
  await db.run(sql`ALTER TABLE \`homepage\` ADD \`projects_home_hero_title\` text DEFAULT 'Building things that interest me.';`)
  await db.run(sql`ALTER TABLE \`homepage\` ADD \`projects_home_hero_intro\` text DEFAULT 'A collection of personal projects, experiments, ideas and the occasional bit of writing.';`)
  await db.run(sql`ALTER TABLE \`homepage\` ADD \`projects_home_hero_cta_label\` text DEFAULT 'Explore projects';`)
  await db.run(sql`ALTER TABLE \`homepage\` ADD \`projects_home_projects_heading\` text DEFAULT 'Selected projects';`)
  await db.run(sql`ALTER TABLE \`homepage\` ADD \`projects_home_projects_intro\` text DEFAULT 'Things I''ve built, am building, or am still working out.';`)
  await db.run(sql`ALTER TABLE \`homepage\` ADD \`projects_home_show_more_projects\` integer DEFAULT true;`)
  await db.run(sql`ALTER TABLE \`homepage\` ADD \`projects_home_show_writing\` integer DEFAULT true;`)
  await db.run(sql`ALTER TABLE \`homepage\` ADD \`projects_home_writing_heading\` text DEFAULT 'Latest writing';`)
  await db.run(sql`ALTER TABLE \`homepage\` ADD \`projects_home_writing_count\` numeric DEFAULT 3;`)
  await db.run(sql`ALTER TABLE \`homepage\` ADD \`projects_home_show_about\` integer DEFAULT true;`)
  await db.run(sql`ALTER TABLE \`homepage\` ADD \`projects_home_about_heading\` text DEFAULT 'About';`)
  await db.run(sql`ALTER TABLE \`homepage\` ADD \`projects_home_about_text\` text DEFAULT 'Hi, I''m Aidan. I write about leadership and learning, building useful things, personal projects, and life in general.';`)
  await db.run(sql`ALTER TABLE \`_homepage_v\` ADD \`version_projects_home_hero_title\` text DEFAULT 'Building things that interest me.';`)
  await db.run(sql`ALTER TABLE \`_homepage_v\` ADD \`version_projects_home_hero_intro\` text DEFAULT 'A collection of personal projects, experiments, ideas and the occasional bit of writing.';`)
  await db.run(sql`ALTER TABLE \`_homepage_v\` ADD \`version_projects_home_hero_cta_label\` text DEFAULT 'Explore projects';`)
  await db.run(sql`ALTER TABLE \`_homepage_v\` ADD \`version_projects_home_projects_heading\` text DEFAULT 'Selected projects';`)
  await db.run(sql`ALTER TABLE \`_homepage_v\` ADD \`version_projects_home_projects_intro\` text DEFAULT 'Things I''ve built, am building, or am still working out.';`)
  await db.run(sql`ALTER TABLE \`_homepage_v\` ADD \`version_projects_home_show_more_projects\` integer DEFAULT true;`)
  await db.run(sql`ALTER TABLE \`_homepage_v\` ADD \`version_projects_home_show_writing\` integer DEFAULT true;`)
  await db.run(sql`ALTER TABLE \`_homepage_v\` ADD \`version_projects_home_writing_heading\` text DEFAULT 'Latest writing';`)
  await db.run(sql`ALTER TABLE \`_homepage_v\` ADD \`version_projects_home_writing_count\` numeric DEFAULT 3;`)
  await db.run(sql`ALTER TABLE \`_homepage_v\` ADD \`version_projects_home_show_about\` integer DEFAULT true;`)
  await db.run(sql`ALTER TABLE \`_homepage_v\` ADD \`version_projects_home_about_heading\` text DEFAULT 'About';`)
  await db.run(sql`ALTER TABLE \`_homepage_v\` ADD \`version_projects_home_about_text\` text DEFAULT 'Hi, I''m Aidan. I write about leadership and learning, building useful things, personal projects, and life in general.';`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.run(sql`DROP TABLE \`projects_gallery\`;`)
  await db.run(sql`DROP TABLE \`projects_links\`;`)
  await db.run(sql`DROP TABLE \`projects_tags\`;`)
  await db.run(sql`DROP TABLE \`projects\`;`)
  await db.run(sql`DROP TABLE \`_projects_v_version_gallery\`;`)
  await db.run(sql`DROP TABLE \`_projects_v_version_links\`;`)
  await db.run(sql`DROP TABLE \`_projects_v_version_tags\`;`)
  await db.run(sql`DROP TABLE \`_projects_v\`;`)
  await db.run(sql`PRAGMA foreign_keys=OFF;`)
  await db.run(sql`CREATE TABLE \`__new_payload_locked_documents_rels\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`order\` integer,
  	\`parent_id\` integer NOT NULL,
  	\`path\` text NOT NULL,
  	\`users_id\` integer,
  	\`media_id\` integer,
  	\`pages_id\` integer,
  	\`posts_id\` integer,
  	FOREIGN KEY (\`parent_id\`) REFERENCES \`payload_locked_documents\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`users_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`media_id\`) REFERENCES \`media\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`pages_id\`) REFERENCES \`pages\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`posts_id\`) REFERENCES \`posts\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`INSERT INTO \`__new_payload_locked_documents_rels\`("id", "order", "parent_id", "path", "users_id", "media_id", "pages_id", "posts_id") SELECT "id", "order", "parent_id", "path", "users_id", "media_id", "pages_id", "posts_id" FROM \`payload_locked_documents_rels\`;`)
  await db.run(sql`DROP TABLE \`payload_locked_documents_rels\`;`)
  await db.run(sql`ALTER TABLE \`__new_payload_locked_documents_rels\` RENAME TO \`payload_locked_documents_rels\`;`)
  await db.run(sql`PRAGMA foreign_keys=ON;`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_order_idx\` ON \`payload_locked_documents_rels\` (\`order\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_parent_idx\` ON \`payload_locked_documents_rels\` (\`parent_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_path_idx\` ON \`payload_locked_documents_rels\` (\`path\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_users_id_idx\` ON \`payload_locked_documents_rels\` (\`users_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_media_id_idx\` ON \`payload_locked_documents_rels\` (\`media_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_pages_id_idx\` ON \`payload_locked_documents_rels\` (\`pages_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_posts_id_idx\` ON \`payload_locked_documents_rels\` (\`posts_id\`);`)
  await db.run(sql`ALTER TABLE \`homepage\` DROP COLUMN \`projects_home_hero_title\`;`)
  await db.run(sql`ALTER TABLE \`homepage\` DROP COLUMN \`projects_home_hero_intro\`;`)
  await db.run(sql`ALTER TABLE \`homepage\` DROP COLUMN \`projects_home_hero_cta_label\`;`)
  await db.run(sql`ALTER TABLE \`homepage\` DROP COLUMN \`projects_home_projects_heading\`;`)
  await db.run(sql`ALTER TABLE \`homepage\` DROP COLUMN \`projects_home_projects_intro\`;`)
  await db.run(sql`ALTER TABLE \`homepage\` DROP COLUMN \`projects_home_show_more_projects\`;`)
  await db.run(sql`ALTER TABLE \`homepage\` DROP COLUMN \`projects_home_show_writing\`;`)
  await db.run(sql`ALTER TABLE \`homepage\` DROP COLUMN \`projects_home_writing_heading\`;`)
  await db.run(sql`ALTER TABLE \`homepage\` DROP COLUMN \`projects_home_writing_count\`;`)
  await db.run(sql`ALTER TABLE \`homepage\` DROP COLUMN \`projects_home_show_about\`;`)
  await db.run(sql`ALTER TABLE \`homepage\` DROP COLUMN \`projects_home_about_heading\`;`)
  await db.run(sql`ALTER TABLE \`homepage\` DROP COLUMN \`projects_home_about_text\`;`)
  await db.run(sql`ALTER TABLE \`_homepage_v\` DROP COLUMN \`version_projects_home_hero_title\`;`)
  await db.run(sql`ALTER TABLE \`_homepage_v\` DROP COLUMN \`version_projects_home_hero_intro\`;`)
  await db.run(sql`ALTER TABLE \`_homepage_v\` DROP COLUMN \`version_projects_home_hero_cta_label\`;`)
  await db.run(sql`ALTER TABLE \`_homepage_v\` DROP COLUMN \`version_projects_home_projects_heading\`;`)
  await db.run(sql`ALTER TABLE \`_homepage_v\` DROP COLUMN \`version_projects_home_projects_intro\`;`)
  await db.run(sql`ALTER TABLE \`_homepage_v\` DROP COLUMN \`version_projects_home_show_more_projects\`;`)
  await db.run(sql`ALTER TABLE \`_homepage_v\` DROP COLUMN \`version_projects_home_show_writing\`;`)
  await db.run(sql`ALTER TABLE \`_homepage_v\` DROP COLUMN \`version_projects_home_writing_heading\`;`)
  await db.run(sql`ALTER TABLE \`_homepage_v\` DROP COLUMN \`version_projects_home_writing_count\`;`)
  await db.run(sql`ALTER TABLE \`_homepage_v\` DROP COLUMN \`version_projects_home_show_about\`;`)
  await db.run(sql`ALTER TABLE \`_homepage_v\` DROP COLUMN \`version_projects_home_about_heading\`;`)
  await db.run(sql`ALTER TABLE \`_homepage_v\` DROP COLUMN \`version_projects_home_about_text\`;`)
}
