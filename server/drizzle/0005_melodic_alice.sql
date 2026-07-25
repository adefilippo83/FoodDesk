ALTER TABLE `order_items` ADD `cancelled_at` integer;--> statement-breakpoint
ALTER TABLE `order_items` ADD `cancelled_by` integer REFERENCES users(id);