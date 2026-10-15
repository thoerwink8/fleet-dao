-- 这一次挂起的起点。新行默认 now()（和 created_at 同一时刻）。
-- 已有行先被默认值写成迁移时刻，必须拨回 created_at：不然正在挂着的报警会从发版起重新算 24 小时，真挂了一天的不再被推。
-- 撤过又重开的时刻这次补不回来（库里没记），下一次重开由 upsertAlert 拨到那一次。
ALTER TABLE "notifications" ADD COLUMN "raised_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "notifications" SET "raised_at" = "created_at";