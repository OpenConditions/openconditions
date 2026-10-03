ALTER TABLE "conditions"."source" DROP CONSTRAINT "source_produces_enum";--> statement-breakpoint
ALTER TABLE "conditions"."source" ALTER COLUMN "country" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "conditions"."source" ADD COLUMN "product" text NOT NULL;--> statement-breakpoint
ALTER TABLE "conditions"."source" DROP COLUMN "produces";