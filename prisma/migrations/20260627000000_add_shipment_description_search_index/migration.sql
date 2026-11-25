-- Add tsvector column for full-text search on shipment comment body
ALTER TABLE shipment_comments
ADD COLUMN body_search tsvector
GENERATED ALWAYS AS (to_tsvector('english', coalesce(body, ''))) STORED;

-- Create GIN index on the tsvector column (CONCURRENTLY to avoid locking)
CREATE INDEX CONCURRENTLY shipment_comments_body_search_idx
ON shipment_comments USING GIN (body_search);

-- Enable trigram extension for case-insensitive substring search on contacts
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Create trigram indexes for case-insensitive search on contact name and email (CONCURRENTLY to avoid locking)
CREATE INDEX CONCURRENTLY contacts_name_trgm_idx
ON contacts USING GIN (name gin_trgm_ops);

CREATE INDEX CONCURRENTLY contacts_email_trgm_idx
ON contacts USING GIN (email gin_trgm_ops);