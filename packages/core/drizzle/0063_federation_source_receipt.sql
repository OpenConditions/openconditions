CREATE TABLE "conditions"."federation_source_receipt" (
	"peer_instance_id" text NOT NULL,
	"source_id" text NOT NULL,
	"last_received_at" timestamp with time zone NOT NULL,
	CONSTRAINT "federation_source_receipt_peer_instance_id_source_id_pk" PRIMARY KEY("peer_instance_id","source_id")
);
