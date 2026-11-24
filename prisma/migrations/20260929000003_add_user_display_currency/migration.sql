-- Migration: add_user_display_currency
-- Adds displayCurrency to the users table.
-- Defaults to 'USD' so every existing row is untouched.

ALTER TABLE "users"
  ADD COLUMN "displayCurrency" TEXT NOT NULL DEFAULT 'USD';
