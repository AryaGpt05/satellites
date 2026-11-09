-- 0007: the owner's admin sign-in is armaang0405@gmail.com (owner, 2026-11-09), replacing the university address that
-- 0004 seeded. Idempotent; runs after 0004 on a full re-run, so the final list is always this one address.
insert into overflight_private.admins (email) values ('armaang0405@gmail.com') on conflict do nothing;
delete from overflight_private.admins where email = 'a585gupt@uwaterloo.ca';
