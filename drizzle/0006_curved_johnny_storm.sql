ALTER TABLE "subscriptions" ADD COLUMN "reminder_sent_for_renewal" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "push_token" text;