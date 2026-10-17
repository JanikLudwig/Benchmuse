CREATE TABLE "notebook_tables" (
	"id" text PRIMARY KEY NOT NULL,
	"entry_id" text NOT NULL,
	"name" text DEFAULT 'Table' NOT NULL,
	"columns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rows" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archive_reason" text
);
--> statement-breakpoint
ALTER TABLE "notebook_tables" ADD CONSTRAINT "notebook_tables_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notebook_tables" ADD CONSTRAINT "notebook_tables_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notebook_tables_entry_idx" ON "notebook_tables" USING btree ("entry_id");