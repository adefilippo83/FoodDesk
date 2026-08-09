PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`daily_number` integer NOT NULL,
	`service_day` text NOT NULL,
	`customer_name` text,
	`covers` integer DEFAULT 1 NOT NULL,
	`cover_charge_cents` integer DEFAULT 0 NOT NULL,
	`cancelled_at` integer,
	`cancelled_by` integer,
	`completed_at` integer,
	`client_key` text,
	`note` text,
	`total_cents` integer NOT NULL,
	`origin` text DEFAULT 'staff' NOT NULL,
	`public_token` text,
	`paid_at` integer,
	`payment_method` text,
	`created_by` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`printed_at` integer,
	`print_error` text,
	`print_attempts` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`cancelled_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_orders`("id", "daily_number", "service_day", "customer_name", "covers", "cover_charge_cents", "cancelled_at", "cancelled_by", "completed_at", "client_key", "note", "total_cents", "origin", "public_token", "paid_at", "payment_method", "created_by", "created_at", "printed_at", "print_error", "print_attempts") SELECT "id", "daily_number", "service_day", "customer_name", "covers", "cover_charge_cents", "cancelled_at", "cancelled_by", "completed_at", "client_key", "note", "total_cents", 'staff', NULL, NULL, NULL, "created_by", "created_at", "printed_at", "print_error", "print_attempts" FROM `orders`;--> statement-breakpoint
DROP TABLE `orders`;--> statement-breakpoint
ALTER TABLE `__new_orders` RENAME TO `orders`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `orders_day_number_unique` ON `orders` (`service_day`,`daily_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `orders_client_key_unique` ON `orders` (`client_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `orders_public_token_unique` ON `orders` (`public_token`);--> statement-breakpoint
CREATE INDEX `orders_created_by_idx` ON `orders` (`created_by`);