CREATE TABLE "couple_members" (
	"couple_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "couple_members_couple_id_user_id_pk" PRIMARY KEY("couple_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "couples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"couple_id" uuid,
	"name" text NOT NULL,
	"props" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"couple_id" uuid NOT NULL,
	"sender_id" text NOT NULL,
	"original_text" text NOT NULL,
	"delivered_text" text NOT NULL,
	"mode" text NOT NULL,
	"change_summary" text,
	"heated" boolean DEFAULT false NOT NULL,
	"original_shared" boolean DEFAULT false NOT NULL,
	"charged_free_slot" boolean DEFAULT false NOT NULL,
	"preview_nonce" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"visible_at" timestamp with time zone NOT NULL,
	CONSTRAINT "messages_preview_nonce_unique" UNIQUE("preview_nonce")
);
--> statement-breakpoint
CREATE TABLE "pair_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "questionnaire" (
	"user_id" text PRIMARY KEY NOT NULL,
	"answers" jsonb NOT NULL,
	"traits" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text,
	"display_name" text,
	"birthdate" date,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"free_translations_used" integer DEFAULT 0 NOT NULL,
	"free_previews_used" integer DEFAULT 0 NOT NULL,
	"free_shares_used" integer DEFAULT 0 NOT NULL,
	"pair_code" text,
	"pair_code_expires_at" timestamp with time zone,
	"share_traits" boolean DEFAULT true NOT NULL,
	"age_blocked" boolean DEFAULT false NOT NULL,
	"ai_window_start" timestamp with time zone,
	"ai_calls_in_window" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "free_translations_range" CHECK ("users"."free_translations_used" between 0 and 10),
	CONSTRAINT "free_previews_range" CHECK ("users"."free_previews_used" between 0 and 30),
	CONSTRAINT "free_shares_range" CHECK ("users"."free_shares_used" between 0 and 5)
);
--> statement-breakpoint
ALTER TABLE "couple_members" ADD CONSTRAINT "couple_members_couple_id_couples_id_fk" FOREIGN KEY ("couple_id") REFERENCES "public"."couples"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "couple_members" ADD CONSTRAINT "couple_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_couple_id_couples_id_fk" FOREIGN KEY ("couple_id") REFERENCES "public"."couples"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_attempts" ADD CONSTRAINT "pair_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questionnaire" ADD CONSTRAINT "questionnaire_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "one_active_couple_per_user" ON "couple_members" USING btree ("user_id") WHERE "couple_members"."active";--> statement-breakpoint
CREATE INDEX "events_user_name_at" ON "events" USING btree ("user_id","name","created_at");--> statement-breakpoint
CREATE INDEX "messages_couple_visible" ON "messages" USING btree ("couple_id","visible_at","id");--> statement-breakpoint
CREATE INDEX "pair_attempts_user_at" ON "pair_attempts" USING btree ("user_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_pair_code_uq" ON "users" USING btree ("pair_code");