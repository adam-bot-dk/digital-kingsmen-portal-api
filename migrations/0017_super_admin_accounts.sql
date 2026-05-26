UPDATE "users"
SET "is_super_admin" = CASE
  WHEN lower("email") IN ('admin@digitalkingsmen.com', 'jonah@digitalkingsmen.com') THEN 1
  ELSE 0
END
WHERE "is_super_admin" = 1
   OR lower("email") IN ('admin@digitalkingsmen.com', 'jonah@digitalkingsmen.com');
