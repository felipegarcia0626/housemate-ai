BEGIN;

CREATE TYPE public.expense_status AS ENUM (
  'PENDING',
  'CONFIRMED',
  'CANCELLED'
);

CREATE TYPE public.expense_source AS ENUM (
  'WEB',
  'WHATSAPP',
  'RECEIPT'
);

CREATE TYPE public.receipt_processing_status AS ENUM (
  'PENDING',
  'PROCESSED',
  'FAILED'
);

CREATE TYPE public.pending_operation_type AS ENUM (
  'CREATE_EXPENSE',
  'UPDATE_EXPENSE',
  'DELETE_EXPENSE',
  'CREATE_INCOME',
  'UPDATE_INCOME',
  'DELETE_INCOME'
);

CREATE TYPE public.pending_proposal_status AS ENUM (
  'AWAITING_CONFIRMATION'
);

CREATE TABLE public.tb_users (
  id UUID CONSTRAINT pk_tb_users PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name TEXT NOT NULL,
  external_identifier TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_tb_users_external_identifier UNIQUE (external_identifier)
);

CREATE TABLE public.tb_households (
  id UUID CONSTRAINT pk_tb_households PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.tb_household_members (
  id UUID CONSTRAINT pk_tb_household_members PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL,
  user_id UUID NOT NULL,
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_tb_household_members_household
    FOREIGN KEY (household_id)
    REFERENCES public.tb_households (id)
    ON DELETE RESTRICT
    ON UPDATE NO ACTION,
  CONSTRAINT fk_tb_household_members_user
    FOREIGN KEY (user_id)
    REFERENCES public.tb_users (id)
    ON DELETE RESTRICT
    ON UPDATE NO ACTION,
  CONSTRAINT uq_tb_household_members_household_user
    UNIQUE (household_id, user_id),
  CONSTRAINT uq_tb_household_members_household_id
    UNIQUE (household_id, id)
);

CREATE TABLE public.tb_categories (
  id UUID CONSTRAINT pk_tb_categories PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_tb_categories_name UNIQUE (name)
);

CREATE TABLE public.tb_sharing_rules (
  id UUID CONSTRAINT pk_tb_sharing_rules PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_tb_sharing_rules_household
    FOREIGN KEY (household_id)
    REFERENCES public.tb_households (id)
    ON DELETE RESTRICT
    ON UPDATE NO ACTION,
  CONSTRAINT uq_tb_sharing_rules_household_name
    UNIQUE (household_id, name),
  CONSTRAINT uq_tb_sharing_rules_household_id
    UNIQUE (household_id, id)
);

CREATE TABLE public.tb_sharing_rule_members (
  id UUID CONSTRAINT pk_tb_sharing_rule_members PRIMARY KEY DEFAULT gen_random_uuid(),
  sharing_rule_id UUID NOT NULL,
  household_member_id UUID NOT NULL,
  percentage NUMERIC(5,2) NOT NULL,
  CONSTRAINT fk_tb_sharing_rule_members_rule
    FOREIGN KEY (sharing_rule_id)
    REFERENCES public.tb_sharing_rules (id)
    ON DELETE CASCADE
    ON UPDATE NO ACTION,
  CONSTRAINT fk_tb_sharing_rule_members_member
    FOREIGN KEY (household_member_id)
    REFERENCES public.tb_household_members (id)
    ON DELETE RESTRICT
    ON UPDATE NO ACTION,
  CONSTRAINT ck_tb_sharing_rule_members_percentage
    CHECK (percentage >= 0 AND percentage <= 100),
  CONSTRAINT uq_tb_sharing_rule_members_rule_member
    UNIQUE (sharing_rule_id, household_member_id)
);

CREATE TABLE public.tb_expenses (
  id UUID CONSTRAINT pk_tb_expenses PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL,
  created_by UUID NOT NULL,
  paid_by UUID NOT NULL,
  category_id UUID,
  merchant TEXT NOT NULL,
  total_amount NUMERIC(14,2) NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'COP',
  expense_date DATE NOT NULL,
  description TEXT,
  status public.expense_status NOT NULL DEFAULT 'CONFIRMED',
  source public.expense_source NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_tb_expenses_household
    FOREIGN KEY (household_id)
    REFERENCES public.tb_households (id)
    ON DELETE RESTRICT
    ON UPDATE NO ACTION,
  CONSTRAINT fk_tb_expenses_created_by_household
    FOREIGN KEY (household_id, created_by)
    REFERENCES public.tb_household_members (household_id, id)
    ON DELETE RESTRICT
    ON UPDATE NO ACTION,
  CONSTRAINT fk_tb_expenses_paid_by_household
    FOREIGN KEY (household_id, paid_by)
    REFERENCES public.tb_household_members (household_id, id)
    ON DELETE RESTRICT
    ON UPDATE NO ACTION,
  CONSTRAINT fk_tb_expenses_category
    FOREIGN KEY (category_id)
    REFERENCES public.tb_categories (id)
    ON DELETE SET NULL
    ON UPDATE NO ACTION,
  CONSTRAINT ck_tb_expenses_total_amount CHECK (total_amount > 0),
  CONSTRAINT ck_tb_expenses_currency CHECK (currency = 'COP'),
  CONSTRAINT uq_tb_expenses_household_id UNIQUE (household_id, id)
);

CREATE TABLE public.tb_expense_items (
  id UUID CONSTRAINT pk_tb_expense_items PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id UUID NOT NULL,
  name TEXT NOT NULL,
  quantity NUMERIC(12,3),
  unit_price NUMERIC(14,2),
  total_amount NUMERIC(14,2) NOT NULL,
  category_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_tb_expense_items_expense
    FOREIGN KEY (expense_id)
    REFERENCES public.tb_expenses (id)
    ON DELETE CASCADE
    ON UPDATE NO ACTION,
  CONSTRAINT fk_tb_expense_items_category
    FOREIGN KEY (category_id)
    REFERENCES public.tb_categories (id)
    ON DELETE SET NULL
    ON UPDATE NO ACTION,
  CONSTRAINT ck_tb_expense_items_quantity
    CHECK (quantity IS NULL OR quantity > 0),
  CONSTRAINT ck_tb_expense_items_unit_price
    CHECK (unit_price IS NULL OR unit_price >= 0),
  CONSTRAINT ck_tb_expense_items_total_amount CHECK (total_amount > 0)
);

CREATE TABLE public.tb_expense_distributions (
  id UUID CONSTRAINT pk_tb_expense_distributions PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id UUID NOT NULL,
  household_member_id UUID NOT NULL,
  amount NUMERIC(14,2) NOT NULL,
  percentage NUMERIC(5,2) NOT NULL,
  CONSTRAINT fk_tb_expense_distributions_expense
    FOREIGN KEY (expense_id)
    REFERENCES public.tb_expenses (id)
    ON DELETE CASCADE
    ON UPDATE NO ACTION,
  CONSTRAINT fk_tb_expense_distributions_member
    FOREIGN KEY (household_member_id)
    REFERENCES public.tb_household_members (id)
    ON DELETE RESTRICT
    ON UPDATE NO ACTION,
  CONSTRAINT ck_tb_expense_distributions_amount CHECK (amount >= 0),
  CONSTRAINT ck_tb_expense_distributions_percentage
    CHECK (percentage >= 0 AND percentage <= 100),
  CONSTRAINT uq_tb_expense_distributions_expense_member
    UNIQUE (expense_id, household_member_id)
);

CREATE TABLE public.tb_incomes (
  id UUID CONSTRAINT pk_tb_incomes PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL,
  created_by UUID NOT NULL,
  member_id UUID NOT NULL,
  amount NUMERIC(14,2) NOT NULL,
  income_date DATE NOT NULL,
  description TEXT NOT NULL,
  category_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_tb_incomes_household
    FOREIGN KEY (household_id)
    REFERENCES public.tb_households (id)
    ON DELETE RESTRICT
    ON UPDATE NO ACTION,
  CONSTRAINT fk_tb_incomes_created_by_household
    FOREIGN KEY (household_id, created_by)
    REFERENCES public.tb_household_members (household_id, id)
    ON DELETE RESTRICT
    ON UPDATE NO ACTION,
  CONSTRAINT fk_tb_incomes_member_household
    FOREIGN KEY (household_id, member_id)
    REFERENCES public.tb_household_members (household_id, id)
    ON DELETE RESTRICT
    ON UPDATE NO ACTION,
  CONSTRAINT fk_tb_incomes_category
    FOREIGN KEY (category_id)
    REFERENCES public.tb_categories (id)
    ON DELETE SET NULL
    ON UPDATE NO ACTION,
  CONSTRAINT ck_tb_incomes_amount CHECK (amount > 0)
);

CREATE TABLE public.tb_receipts (
  id UUID CONSTRAINT pk_tb_receipts PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL,
  conversation_key TEXT NOT NULL,
  expense_id UUID,
  storage_path TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processing_status public.receipt_processing_status NOT NULL DEFAULT 'PENDING',
  analysis_payload JSONB,
  CONSTRAINT fk_tb_receipts_household
    FOREIGN KEY (household_id)
    REFERENCES public.tb_households (id)
    ON DELETE RESTRICT
    ON UPDATE NO ACTION,
  CONSTRAINT fk_tb_receipts_expense_household
    FOREIGN KEY (household_id, expense_id)
    REFERENCES public.tb_expenses (household_id, id)
    ON DELETE RESTRICT
    ON UPDATE NO ACTION,
  CONSTRAINT ck_tb_receipts_processed_association
    CHECK (expense_id IS NULL OR processing_status = 'PROCESSED')
);

CREATE TABLE public.tb_pending_proposals (
  id UUID CONSTRAINT pk_tb_pending_proposals PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL,
  conversation_key TEXT NOT NULL,
  operation_type public.pending_operation_type NOT NULL,
  payload JSONB NOT NULL,
  status public.pending_proposal_status NOT NULL DEFAULT 'AWAITING_CONFIRMATION',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_tb_pending_proposals_household
    FOREIGN KEY (household_id)
    REFERENCES public.tb_households (id)
    ON DELETE RESTRICT
    ON UPDATE NO ACTION
);

CREATE TABLE public.tb_processed_whatsapp_events (
  id UUID CONSTRAINT pk_tb_processed_whatsapp_events PRIMARY KEY DEFAULT gen_random_uuid(),
  external_event_id TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_tb_processed_whatsapp_events_external_event_id
    UNIQUE (external_event_id)
);

CREATE UNIQUE INDEX uq_tb_pending_proposals_active_conversation
  ON public.tb_pending_proposals (household_id, conversation_key)
  WHERE status = 'AWAITING_CONFIRMATION';

CREATE UNIQUE INDEX uq_tb_receipts_active_conversation
  ON public.tb_receipts (household_id, conversation_key)
  WHERE expense_id IS NULL
    AND processing_status IN ('PENDING', 'FAILED');

CREATE INDEX idx_tb_household_members_user_id
  ON public.tb_household_members (user_id);
CREATE INDEX idx_tb_sharing_rules_household_id
  ON public.tb_sharing_rules (household_id);
CREATE INDEX idx_tb_sharing_rule_members_member_id
  ON public.tb_sharing_rule_members (household_member_id);
CREATE INDEX idx_tb_expenses_household_date
  ON public.tb_expenses (household_id, expense_date DESC);
CREATE INDEX idx_tb_expenses_household_status_date
  ON public.tb_expenses (household_id, status, expense_date DESC);
CREATE INDEX idx_tb_expenses_paid_by_date
  ON public.tb_expenses (paid_by, expense_date DESC);
CREATE INDEX idx_tb_expenses_category_id
  ON public.tb_expenses (category_id);
CREATE INDEX idx_tb_expense_items_expense_id
  ON public.tb_expense_items (expense_id);
CREATE INDEX idx_tb_expense_items_category_id
  ON public.tb_expense_items (category_id);
CREATE INDEX idx_tb_expense_distributions_member_id
  ON public.tb_expense_distributions (household_member_id);
CREATE INDEX idx_tb_incomes_household_date
  ON public.tb_incomes (household_id, income_date DESC);
CREATE INDEX idx_tb_incomes_household_member_date
  ON public.tb_incomes (household_id, member_id, income_date DESC);
CREATE INDEX idx_tb_incomes_household_category_date
  ON public.tb_incomes (household_id, category_id, income_date DESC);
CREATE INDEX idx_tb_receipts_household_conversation
  ON public.tb_receipts (household_id, conversation_key);
CREATE INDEX idx_tb_receipts_expense_id
  ON public.tb_receipts (expense_id);

CREATE FUNCTION public.fn_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_tb_expenses_set_updated_at
BEFORE UPDATE ON public.tb_expenses
FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();

CREATE TRIGGER trg_tb_incomes_set_updated_at
BEFORE UPDATE ON public.tb_incomes
FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();

CREATE TRIGGER trg_tb_sharing_rules_set_updated_at
BEFORE UPDATE ON public.tb_sharing_rules
FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();

CREATE TRIGGER trg_tb_pending_proposals_set_updated_at
BEFORE UPDATE ON public.tb_pending_proposals
FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();

CREATE FUNCTION public.fn_validate_expense_item_total()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expense_ids UUID[];
  expense_id_to_validate UUID;
  expense_total NUMERIC(14,2);
  items_total NUMERIC(14,2);
BEGIN
  IF TG_TABLE_NAME = 'tb_expenses' THEN
    expense_ids := ARRAY[NEW.id];
  ELSIF TG_OP = 'INSERT' THEN
    expense_ids := ARRAY[NEW.expense_id];
  ELSIF TG_OP = 'DELETE' THEN
    expense_ids := ARRAY[OLD.expense_id];
  ELSE
    expense_ids := ARRAY[OLD.expense_id, NEW.expense_id];
  END IF;

  FOREACH expense_id_to_validate IN ARRAY expense_ids LOOP
    SELECT expense.total_amount
      INTO expense_total
      FROM public.tb_expenses AS expense
     WHERE expense.id = expense_id_to_validate;

    IF FOUND THEN
      SELECT COALESCE(SUM(item.total_amount), 0)::NUMERIC(14,2)
        INTO items_total
        FROM public.tb_expense_items AS item
       WHERE item.expense_id = expense_id_to_validate;

      IF items_total > expense_total THEN
        RAISE EXCEPTION
          'ExpenseItem total (%) exceeds Expense total (%) for Expense %',
          items_total,
          expense_total,
          expense_id_to_validate
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_tb_expense_items_validate_total
AFTER INSERT OR UPDATE OR DELETE ON public.tb_expense_items
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.fn_validate_expense_item_total();

CREATE CONSTRAINT TRIGGER trg_tb_expenses_validate_item_total
AFTER UPDATE OF total_amount ON public.tb_expenses
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.fn_validate_expense_item_total();

CREATE FUNCTION public.fn_validate_expense_distributions()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expense_ids UUID[];
  expense_id_to_validate UUID;
  expense_household_id UUID;
  expense_status_to_validate public.expense_status;
  expense_total NUMERIC(14,2);
  distributions_total NUMERIC(14,2);
BEGIN
  IF TG_TABLE_NAME = 'tb_expenses' THEN
    expense_ids := ARRAY[NEW.id];
  ELSIF TG_OP = 'INSERT' THEN
    expense_ids := ARRAY[NEW.expense_id];
  ELSIF TG_OP = 'DELETE' THEN
    expense_ids := ARRAY[OLD.expense_id];
  ELSE
    expense_ids := ARRAY[OLD.expense_id, NEW.expense_id];
  END IF;

  FOREACH expense_id_to_validate IN ARRAY expense_ids LOOP
    SELECT expense.household_id, expense.status, expense.total_amount
      INTO expense_household_id, expense_status_to_validate, expense_total
      FROM public.tb_expenses AS expense
     WHERE expense.id = expense_id_to_validate;

    IF FOUND THEN
      IF EXISTS (
        SELECT 1
          FROM public.tb_expense_distributions AS distribution
          JOIN public.tb_household_members AS member
            ON member.id = distribution.household_member_id
         WHERE distribution.expense_id = expense_id_to_validate
           AND member.household_id <> expense_household_id
      ) THEN
        RAISE EXCEPTION
          'ExpenseDistribution member does not belong to Expense household for Expense %',
          expense_id_to_validate
          USING ERRCODE = '23514';
      END IF;

      IF expense_status_to_validate = 'CONFIRMED' THEN
        SELECT COALESCE(SUM(distribution.amount), 0)::NUMERIC(14,2)
          INTO distributions_total
          FROM public.tb_expense_distributions AS distribution
         WHERE distribution.expense_id = expense_id_to_validate;

        IF distributions_total <> expense_total THEN
          RAISE EXCEPTION
            'ExpenseDistribution total (%) differs from Expense total (%) for Expense %',
            distributions_total,
            expense_total,
            expense_id_to_validate
            USING ERRCODE = '23514';
        END IF;
      END IF;
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_tb_expense_distributions_validate
AFTER INSERT OR UPDATE OR DELETE ON public.tb_expense_distributions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.fn_validate_expense_distributions();

CREATE CONSTRAINT TRIGGER trg_tb_expenses_validate_distributions
AFTER INSERT OR UPDATE OF total_amount, status, household_id ON public.tb_expenses
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.fn_validate_expense_distributions();

CREATE FUNCTION public.fn_validate_sharing_rule_members()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  rule_ids UUID[];
  rule_id_to_validate UUID;
  rule_household_id UUID;
  percentages_total NUMERIC(5,2);
BEGIN
  IF TG_TABLE_NAME = 'tb_sharing_rules' THEN
    rule_ids := ARRAY[NEW.id];
  ELSIF TG_OP = 'INSERT' THEN
    rule_ids := ARRAY[NEW.sharing_rule_id];
  ELSIF TG_OP = 'DELETE' THEN
    rule_ids := ARRAY[OLD.sharing_rule_id];
  ELSE
    rule_ids := ARRAY[OLD.sharing_rule_id, NEW.sharing_rule_id];
  END IF;

  FOREACH rule_id_to_validate IN ARRAY rule_ids LOOP
    SELECT rule.household_id
      INTO rule_household_id
      FROM public.tb_sharing_rules AS rule
     WHERE rule.id = rule_id_to_validate;

    IF FOUND THEN
      IF EXISTS (
        SELECT 1
          FROM public.tb_sharing_rule_members AS rule_member
          JOIN public.tb_household_members AS member
            ON member.id = rule_member.household_member_id
         WHERE rule_member.sharing_rule_id = rule_id_to_validate
           AND member.household_id <> rule_household_id
      ) THEN
        RAISE EXCEPTION
          'SharingRuleMember does not belong to SharingRule household for SharingRule %',
          rule_id_to_validate
          USING ERRCODE = '23514';
      END IF;

      SELECT COALESCE(SUM(rule_member.percentage), 0)::NUMERIC(5,2)
        INTO percentages_total
        FROM public.tb_sharing_rule_members AS rule_member
       WHERE rule_member.sharing_rule_id = rule_id_to_validate;

      IF percentages_total <> 100.00 THEN
        RAISE EXCEPTION
          'SharingRuleMember percentages (%) do not sum to 100 for SharingRule %',
          percentages_total,
          rule_id_to_validate
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_tb_sharing_rule_members_validate
AFTER INSERT OR UPDATE OR DELETE ON public.tb_sharing_rule_members
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.fn_validate_sharing_rule_members();

CREATE CONSTRAINT TRIGGER trg_tb_sharing_rules_validate_members
AFTER INSERT OR UPDATE OF household_id ON public.tb_sharing_rules
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.fn_validate_sharing_rule_members();

COMMIT;
