-- Runs once, the first time the Postgres volume is created: a separate database for `npm test`.
CREATE DATABASE commerce_test OWNER commerce;
