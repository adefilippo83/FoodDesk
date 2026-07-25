ALTER TABLE `orders` ADD `client_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `orders_client_key_unique` ON `orders` (`client_key`);