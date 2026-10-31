-- A derived baseline is a site's overall free flow, the (-1, -1) row: that
-- row alone is read, and typical speeds per weekday and hour are the segment
-- profiles'. The derivation wrote 48 more rows a site each night, which
-- nothing read, and no longer does; those it wrote go.
DELETE FROM "conditions"."sensor_baseline"
 WHERE "method" = 'derived' AND ("dow_bucket" <> -1 OR "tod_bucket" <> -1);
