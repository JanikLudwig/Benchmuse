CREATE TABLE "alignment_reads" (
	"id" text PRIMARY KEY NOT NULL,
	"alignment_id" text NOT NULL,
	"name" text NOT NULL,
	"file_id" text,
	"sequence" text NOT NULL,
	"qualities" jsonb,
	"trim_start" integer DEFAULT 0 NOT NULL,
	"trim_end" integer DEFAULT 0 NOT NULL,
	"strand" integer DEFAULT 0 NOT NULL,
	"ref_start" integer,
	"ref_end" integer,
	"identity_percent" integer,
	"cigar" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"variants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"failure_reason" text,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "alignment_reads_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alignments" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'sanger' NOT NULL,
	"reference_entity_id" text NOT NULL,
	"folder_id" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archive_reason" text
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"object_id" text NOT NULL,
	"action" text NOT NULL,
	"actor_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"changes" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dropdown_options" (
	"id" text PRIMARY KEY NOT NULL,
	"dropdown_id" text NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "dropdowns" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archive_reason" text,
	CONSTRAINT "dropdowns_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "entities" (
	"id" text PRIMARY KEY NOT NULL,
	"schema_id" text,
	"entity_type" text NOT NULL,
	"name" text NOT NULL,
	"folder_id" text NOT NULL,
	"registry_id" text,
	"registered_at" timestamp with time zone,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"sequence" text,
	"is_circular" boolean DEFAULT false NOT NULL,
	"features" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"qualities" jsonb,
	"oligo_role" text,
	"source_file_id" text,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archive_reason" text,
	CONSTRAINT "entities_registry_id_unique" UNIQUE("registry_id")
);
--> statement-breakpoint
CREATE TABLE "entries" (
	"id" text PRIMARY KEY NOT NULL,
	"schema_id" text,
	"name" text NOT NULL,
	"folder_id" text NOT NULL,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content" jsonb DEFAULT '{"type":"doc","content":[]}'::jsonb NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archive_reason" text
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"folder_id" text,
	"detected_format" text,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archive_reason" text
);
--> statement-breakpoint
CREATE TABLE "folders" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"parent_folder_id" text,
	"name" text NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archive_reason" text
);
--> statement-breakpoint
CREATE TABLE "lineage" (
	"id" text PRIMARY KEY NOT NULL,
	"child_entity_id" text NOT NULL,
	"parent_entity_id" text,
	"method" text NOT NULL,
	"role" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archive_reason" text
);
--> statement-breakpoint
CREATE TABLE "results" (
	"id" text PRIMARY KEY NOT NULL,
	"schema_id" text NOT NULL,
	"entry_id" text,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "results_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archive_reason" text
);
--> statement-breakpoint
CREATE TABLE "schema_fields" (
	"id" text PRIMARY KEY NOT NULL,
	"schema_id" text NOT NULL,
	"name" text NOT NULL,
	"display_name" text NOT NULL,
	"type" text NOT NULL,
	"is_required" boolean DEFAULT false NOT NULL,
	"is_multi" boolean DEFAULT false NOT NULL,
	"dropdown_id" text,
	"target_schema_id" text,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "schemas" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"entity_type" text,
	"name_template" text,
	"next_number" integer DEFAULT 1 NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archive_reason" text,
	CONSTRAINT "schemas_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_handle_unique" UNIQUE("handle"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "alignment_reads" ADD CONSTRAINT "alignment_reads_alignment_id_alignments_id_fk" FOREIGN KEY ("alignment_id") REFERENCES "public"."alignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alignment_reads" ADD CONSTRAINT "alignment_reads_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alignments" ADD CONSTRAINT "alignments_reference_entity_id_entities_id_fk" FOREIGN KEY ("reference_entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alignments" ADD CONSTRAINT "alignments_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alignments" ADD CONSTRAINT "alignments_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dropdown_options" ADD CONSTRAINT "dropdown_options_dropdown_id_dropdowns_id_fk" FOREIGN KEY ("dropdown_id") REFERENCES "public"."dropdowns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dropdowns" ADD CONSTRAINT "dropdowns_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_schema_id_schemas_id_fk" FOREIGN KEY ("schema_id") REFERENCES "public"."schemas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_source_file_id_files_id_fk" FOREIGN KEY ("source_file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_schema_id_schemas_id_fk" FOREIGN KEY ("schema_id") REFERENCES "public"."schemas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_parent_folder_id_folders_id_fk" FOREIGN KEY ("parent_folder_id") REFERENCES "public"."folders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lineage" ADD CONSTRAINT "lineage_child_entity_id_entities_id_fk" FOREIGN KEY ("child_entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lineage" ADD CONSTRAINT "lineage_parent_entity_id_entities_id_fk" FOREIGN KEY ("parent_entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lineage" ADD CONSTRAINT "lineage_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "results" ADD CONSTRAINT "results_schema_id_schemas_id_fk" FOREIGN KEY ("schema_id") REFERENCES "public"."schemas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "results" ADD CONSTRAINT "results_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "results" ADD CONSTRAINT "results_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schema_fields" ADD CONSTRAINT "schema_fields_schema_id_schemas_id_fk" FOREIGN KEY ("schema_id") REFERENCES "public"."schemas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schema_fields" ADD CONSTRAINT "schema_fields_dropdown_id_dropdowns_id_fk" FOREIGN KEY ("dropdown_id") REFERENCES "public"."dropdowns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schema_fields" ADD CONSTRAINT "schema_fields_target_schema_id_schemas_id_fk" FOREIGN KEY ("target_schema_id") REFERENCES "public"."schemas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schemas" ADD CONSTRAINT "schemas_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alignment_reads_alignment_idx" ON "alignment_reads" USING btree ("alignment_id","seq");--> statement-breakpoint
CREATE INDEX "alignments_reference_idx" ON "alignments" USING btree ("reference_entity_id");--> statement-breakpoint
CREATE INDEX "audit_events_object_idx" ON "audit_events" USING btree ("object_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "dropdown_options_name_uq" ON "dropdown_options" USING btree ("dropdown_id","name");--> statement-breakpoint
CREATE INDEX "entities_folder_idx" ON "entities" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "entities_schema_idx" ON "entities" USING btree ("schema_id");--> statement-breakpoint
CREATE INDEX "entities_fields_gin" ON "entities" USING gin ("fields");--> statement-breakpoint
CREATE INDEX "entries_folder_idx" ON "entries" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "files_sha_idx" ON "files" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "files_folder_idx" ON "files" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "folders_project_idx" ON "folders" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "folders_parent_idx" ON "folders" USING btree ("parent_folder_id");--> statement-breakpoint
CREATE UNIQUE INDEX "folders_one_root_per_project_uq" ON "folders" USING btree ("project_id") WHERE "folders"."parent_folder_id" is null;--> statement-breakpoint
CREATE INDEX "lineage_child_idx" ON "lineage" USING btree ("child_entity_id");--> statement-breakpoint
CREATE INDEX "lineage_parent_idx" ON "lineage" USING btree ("parent_entity_id");--> statement-breakpoint
CREATE INDEX "results_schema_idx" ON "results" USING btree ("schema_id");--> statement-breakpoint
CREATE INDEX "results_entry_idx" ON "results" USING btree ("entry_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "schema_fields_name_uq" ON "schema_fields" USING btree ("schema_id","name");