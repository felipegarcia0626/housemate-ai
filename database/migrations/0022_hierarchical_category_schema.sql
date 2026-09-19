BEGIN;

ALTER TABLE public.tb_categories
  ADD COLUMN movement_type TEXT,
  ADD COLUMN level TEXT,
  ADD COLUMN parent_id UUID,
  ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE public.tb_categories
  DROP CONSTRAINT uq_tb_categories_name;

ALTER TABLE public.tb_categories
  ADD CONSTRAINT ck_tb_categories_movement_type
  CHECK (movement_type IS NULL OR movement_type IN ('EXPENSE', 'INCOME')),
  ADD CONSTRAINT ck_tb_categories_level
  CHECK (level IS NULL OR level IN ('MACRO', 'MICRO')),
  ADD CONSTRAINT ck_tb_categories_legacy_or_typed
  CHECK (
    (
      movement_type IS NULL
      AND level IS NULL
      AND parent_id IS NULL
    )
    OR
    (
      movement_type IS NOT NULL
      AND level = 'MACRO'
      AND parent_id IS NULL
    )
    OR
    (
      movement_type IS NOT NULL
      AND level = 'MICRO'
      AND parent_id IS NOT NULL
    )
  ),
  ADD CONSTRAINT uq_tb_categories_id_movement_type
  UNIQUE (id, movement_type),
  ADD CONSTRAINT fk_tb_categories_parent_same_movement_type
  FOREIGN KEY (parent_id, movement_type)
  REFERENCES public.tb_categories (id, movement_type)
  ON DELETE RESTRICT
  ON UPDATE NO ACTION;

CREATE UNIQUE INDEX uq_tb_categories_legacy_name
  ON public.tb_categories (name)
  WHERE movement_type IS NULL;

CREATE UNIQUE INDEX uq_tb_categories_macro_name
  ON public.tb_categories (movement_type, name)
  WHERE movement_type IS NOT NULL
    AND level = 'MACRO';

CREATE UNIQUE INDEX uq_tb_categories_micro_name
  ON public.tb_categories (movement_type, parent_id, name)
  WHERE movement_type IS NOT NULL
    AND level = 'MICRO';

CREATE INDEX idx_tb_categories_parent_id
  ON public.tb_categories (parent_id);

CREATE FUNCTION public.fn_validate_category_hierarchy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_level TEXT;
  parent_movement_type TEXT;
BEGIN
  IF NEW.level = 'MICRO' THEN
    SELECT category.level, category.movement_type
      INTO parent_level, parent_movement_type
      FROM public.tb_categories AS category
     WHERE category.id = NEW.parent_id;

    IF parent_level IS DISTINCT FROM 'MACRO'
       OR parent_movement_type IS DISTINCT FROM NEW.movement_type THEN
      RAISE EXCEPTION
        'Category parent must be a MACRO of the same movement type'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.tb_categories AS child
     WHERE child.parent_id = NEW.id
       AND (
         NEW.level IS DISTINCT FROM 'MACRO'
         OR child.movement_type IS DISTINCT FROM NEW.movement_type
       )
  ) THEN
    RAISE EXCEPTION
      'Category with children must remain a MACRO of the same movement type'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_tb_categories_validate_hierarchy
BEFORE INSERT OR UPDATE OF movement_type, level, parent_id
ON public.tb_categories
FOR EACH ROW EXECUTE FUNCTION public.fn_validate_category_hierarchy();

CREATE TRIGGER trg_tb_categories_set_updated_at
BEFORE UPDATE ON public.tb_categories
FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();

COMMENT ON COLUMN public.tb_categories.movement_type IS
  'Optional during legacy transition; typed rows use EXPENSE or INCOME.';

COMMENT ON COLUMN public.tb_categories.level IS
  'Optional during legacy transition; typed rows use MACRO or MICRO.';

COMMENT ON COLUMN public.tb_categories.parent_id IS
  'NULL for MACRO and legacy rows; MICRO rows reference a same-type MACRO.';

COMMENT ON COLUMN public.tb_categories.is_active IS
  'Whether the category is available for future operations; historical references remain valid when false.';

COMMIT;
