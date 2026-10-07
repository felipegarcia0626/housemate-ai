INSERT INTO public.tb_households (id, name)
VALUES
  ('00000000-0000-4000-8000-000000000001', 'Legacy Household 1'),
  ('0054e516-6236-4856-88f1-b8c11ee5329f', 'Legacy Household 2'),
  ('158e678a-e3fb-42cf-9b81-404c137e3b49', 'Legacy Household 3'),
  ('560e94bb-5869-4b5c-ba1f-0b1dffbe4756', 'Legacy Household 4'),
  ('013951d0-a5cb-4ad6-8780-4367338fa117', 'Legacy Household 5'),
  ('ecc7d433-6dde-4bd7-ad07-f23309fc95c8', 'Legacy Household 6')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.tb_users (id, display_name, external_identifier)
VALUES
  ('00000000-0000-4000-8000-000000000011', 'Legacy User 1', 'lifecycle-user-1'),
  ('00000000-0000-4000-8000-000000000012', 'Legacy User 2', 'lifecycle-user-2'),
  ('00000000-0000-4000-8000-000000000013', 'Legacy User 3', 'lifecycle-user-3'),
  ('00000000-0000-4000-8000-000000000014', 'Legacy User 4', 'lifecycle-user-4'),
  ('00000000-0000-4000-8000-000000000015', 'Legacy User 5', 'lifecycle-user-5'),
  ('00000000-0000-4000-8000-000000000016', 'Legacy User 6', 'lifecycle-user-6'),
  ('00000000-0000-4000-8000-000000000017', 'Legacy User 7', 'lifecycle-user-7'),
  ('00000000-0000-4000-8000-000000000018', 'Legacy User 8', 'lifecycle-user-8'),
  ('00000000-0000-4000-8000-000000000019', 'Legacy User 9', 'lifecycle-user-9'),
  ('00000000-0000-4000-8000-00000000001a', 'Legacy User 10', 'lifecycle-user-10'),
  ('00000000-0000-4000-8000-00000000001b', 'Legacy User 11', 'lifecycle-user-11'),
  ('00000000-0000-4000-8000-00000000001c', 'Legacy User 12', 'lifecycle-user-12')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.tb_household_members (id, household_id, user_id, display_name)
VALUES
  ('00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000011','Legacy User 1'),
  ('00000000-0000-4000-8000-000000000022','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000012','Legacy User 2'),
  ('180d3596-f601-4844-9683-e46b0c21da28','0054e516-6236-4856-88f1-b8c11ee5329f','00000000-0000-4000-8000-000000000013','Legacy User 3'),
  ('180d3596-f601-4844-9683-e46b0c21da29','0054e516-6236-4856-88f1-b8c11ee5329f','00000000-0000-4000-8000-000000000014','Legacy User 4'),
  ('9f70aaf7-2140-49d4-8bb9-acb3ddde4422','158e678a-e3fb-42cf-9b81-404c137e3b49','00000000-0000-4000-8000-000000000015','Legacy User 5'),
  ('9f70aaf7-2140-49d4-8bb9-acb3ddde4423','158e678a-e3fb-42cf-9b81-404c137e3b49','00000000-0000-4000-8000-000000000016','Legacy User 6'),
  ('11c9d7e3-b9ef-4b29-b484-7fbb664b8634','560e94bb-5869-4b5c-ba1f-0b1dffbe4756','00000000-0000-4000-8000-000000000017','Legacy User 7'),
  ('11c9d7e3-b9ef-4b29-b484-7fbb664b8635','560e94bb-5869-4b5c-ba1f-0b1dffbe4756','00000000-0000-4000-8000-000000000018','Legacy User 8'),
  ('56fe1eba-505f-4ca4-8f43-a7c74ff5eb21','013951d0-a5cb-4ad6-8780-4367338fa117','00000000-0000-4000-8000-000000000019','Legacy User 9'),
  ('56fe1eba-505f-4ca4-8f43-a7c74ff5eb22','013951d0-a5cb-4ad6-8780-4367338fa117','00000000-0000-4000-8000-00000000001a','Legacy User 10'),
  ('b95b73cc-7112-495e-a09a-6ceb8cf9f661','ecc7d433-6dde-4bd7-ad07-f23309fc95c8','00000000-0000-4000-8000-00000000001b','Legacy User 11'),
  ('b95b73cc-7112-495e-a09a-6ceb8cf9f662','ecc7d433-6dde-4bd7-ad07-f23309fc95c8','00000000-0000-4000-8000-00000000001c','Legacy User 12')
ON CONFLICT (id) DO NOTHING;
