CREATE TABLE "technician_route_state" (
	"city_id" text NOT NULL,
	"vehicle" text NOT NULL,
	"last_technician_id" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "technician_route_state_city_id_vehicle_pk" PRIMARY KEY("city_id","vehicle")
);
--> statement-breakpoint
CREATE TABLE "technician_routes" (
	"id" text PRIMARY KEY NOT NULL,
	"city_id" text NOT NULL,
	"city_name" text NOT NULL,
	"vehicle" text NOT NULL,
	"technician_id" text NOT NULL,
	"technician_name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"updated_by" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "technician_routes_unique_idx" ON "technician_routes" USING btree ("city_id","vehicle","technician_id");