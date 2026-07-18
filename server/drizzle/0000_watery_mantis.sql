CREATE TABLE `categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `order_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`product_id` integer NOT NULL,
	`name_snapshot` text NOT NULL,
	`price_cents_snapshot` integer NOT NULL,
	`category_name_snapshot` text NOT NULL,
	`qty` integer NOT NULL,
	`note` text,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `order_items_order_id_idx` ON `order_items` (`order_id`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`daily_number` integer NOT NULL,
	`service_day` text NOT NULL,
	`table_label` text,
	`note` text,
	`total_cents` integer NOT NULL,
	`created_by` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`printed_at` integer,
	`print_error` text,
	`print_attempts` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_day_number_unique` ON `orders` (`service_day`,`daily_number`);--> statement-breakpoint
CREATE INDEX `orders_created_by_idx` ON `orders` (`created_by`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`category_id` integer NOT NULL,
	`name` text NOT NULL,
	`price_cents` integer NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `products_category_id_idx` ON `products` (`category_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sessions_user_id_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`display_name` text NOT NULL,
	`role` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);