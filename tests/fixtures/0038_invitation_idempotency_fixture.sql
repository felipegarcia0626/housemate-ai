-- Only used inside the embedded, disposable PostgreSQL test database.
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (id UUID PRIMARY KEY, email TEXT);
INSERT INTO auth.users(id,email) VALUES
 ('d1000000-0000-4000-8000-000000000001','actor-idempotency@example.test'),
 ('d1000000-0000-4000-8000-000000000002','recipient-idempotency@example.test'),
 ('d1000000-0000-4000-8000-000000000003','other-idempotency@example.test');
INSERT INTO public.tb_users(id,auth_user_id,display_name,external_identifier) VALUES
 ('d2000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000001','Fixture Actor','invitation-idempotency-actor'),
 ('d2000000-0000-4000-8000-000000000002','d1000000-0000-4000-8000-000000000002','Fixture Recipient','invitation-idempotency-recipient'),
 ('d2000000-0000-4000-8000-000000000003','d1000000-0000-4000-8000-000000000003','Fixture Other','invitation-idempotency-other');
INSERT INTO public.tb_households(id,name) VALUES
 ('d3000000-0000-4000-8000-000000000001','Idempotency Fixture One'),
 ('d3000000-0000-4000-8000-000000000002','Idempotency Fixture Two');
INSERT INTO public.tb_household_members(id,household_id,user_id,display_name,role,status) VALUES
 ('d4000000-0000-4000-8000-000000000001','d3000000-0000-4000-8000-000000000001','d2000000-0000-4000-8000-000000000001','Fixture Actor','OWNER','ACTIVE'),
 ('d4000000-0000-4000-8000-000000000002','d3000000-0000-4000-8000-000000000002','d2000000-0000-4000-8000-000000000001','Fixture Actor','OWNER','ACTIVE'),
 ('d4000000-0000-4000-8000-000000000003','d3000000-0000-4000-8000-000000000001','d2000000-0000-4000-8000-000000000003','Fixture Other','MEMBER','ACTIVE');
