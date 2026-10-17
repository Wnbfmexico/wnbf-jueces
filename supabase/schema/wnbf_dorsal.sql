-- Preserve WNBF dorsal identifiers as strings (e.g. D43) without changing legacy numeric bibs.
alter table public.athletes
  add column if not exists dorsal text;
