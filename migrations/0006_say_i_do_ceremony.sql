-- The ceremony as listed on the couple's Say I Do site (Saturday 23 October 2027, 2:00pm, smart
-- casual, Rhino Lodge). Added only when the planner has no events yet, so anything already entered
-- in Wedding Planner is never changed. No guest is invited by this: invitations are guest_events rows.
INSERT INTO events (id, name, starts_at, ends_at, venue_name, address, description, dress_code, is_public, rsvp_enabled, sort_order, created_at, updated_at)
SELECT 'evt_ceremony2027', 'Ceremony', '2027-10-23T14:00', NULL, 'Rhino Lodge', '14L Camp Rd, Dubbo NSW 2830', NULL, 'Smart casual', 1, 1, 10,
       '2026-10-12T00:00:00.000Z', '2026-10-12T00:00:00.000Z'
WHERE NOT EXISTS (SELECT 1 FROM events);
