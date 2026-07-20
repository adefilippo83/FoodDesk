CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `orders` ADD `customer_name` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `covers` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `cover_charge_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `cancelled_at` integer;--> statement-breakpoint
ALTER TABLE `orders` ADD `cancelled_by` integer REFERENCES users(id);--> statement-breakpoint
UPDATE `orders` SET `customer_name` = `table_label` WHERE `table_label` IS NOT NULL;
