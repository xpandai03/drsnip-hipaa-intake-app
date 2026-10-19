-- 0024_conversion_cohorts.sql — conversion by entry cohort, with a cumulative fill.
--
-- Apply by hand, after 0023. NOT registered in migrate.ts (owner drsnip_metrics_fn).
--
-- "Of the patients whose first form came in during period P, what share had
--  converted by the end of P, P+1, P+2, P+3 — and by today?"
--
-- Built on drsnip_conversion_classify() (0023), the same per-patient row that
-- Monthly outcomes counts, so a month cohort's "converted as of today" is the
-- Monthly outcomes "converted" figure for that month and form by construction.
--
--   * Cohort: the clinic month, or ISO week (Monday start), of the patient's
--     earliest submission of p_form. Only patients whose appointment history
--     has been read (covered) are in the denominator.
--   * Conversion date: the created date of the earliest converted-set
--     appointment (clinic day). An appointment made BEFORE the form counts in
--     P+0: the patient had converted by the end of their entry period.
--   * A fill cell is reported only once its period has ENDED (at the
--     appointment evidence cutoff). A period still running is NULL with
--     `ended_pN = false`, never zero.
--   * Small cells (1..4) are withheld inside this boundary.
--
-- Idempotent. Safe to re-run.

BEGIN;

CREATE OR REPLACE FUNCTION public.drsnip_conversion_cohorts(p_form text, p_grain text)
RETURNS TABLE (
  period_start           date,
  period_end             date,
  row_status             text,
  period_complete        boolean,
  forms                  integer,
  not_covered            integer,
  unlinked_submissions   integer,
  converted_now          integer,
  fill_p0                integer,
  fill_p1                integer,
  fill_p2                integer,
  fill_p3                integer,
  fill_later             integer,
  ended_p0               boolean,
  ended_p1               boolean,
  ended_p2               boolean,
  ended_p3               boolean,
  converted_before_entry integer,
  withheld               text[],
  status_rules_version   text,
  evidence_cutoff        timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET statement_timeout = '20s'
-- Never JIT a report (see 0023 and the 2026-10-19 outage).
SET jit = off
AS $fn$
DECLARE
  k     constant integer := 5;
  cut   timestamptz;
  rv    text;
  step  interval;
  c     record;
  e     boolean[];
  v     integer[];
  i     integer;
BEGIN
  IF p_form IS NULL OR p_form NOT IN ('registration', 'insurance') THEN
    RAISE EXCEPTION 'unsupported form' USING ERRCODE = '22023';
  END IF;
  IF p_grain IS NULL OR p_grain NOT IN ('month', 'week') THEN
    RAISE EXCEPTION 'unsupported grain' USING ERRCODE = '22023';
  END IF;
  step := CASE WHEN p_grain = 'month' THEN interval '1 month' ELSE interval '1 week' END;

  SELECT ec.cutoff INTO cut FROM public.drsnip_evidence_cutoff() ec;
  SELECT r.version INTO rv FROM public.drsnip_conversion_rules() r;
  IF rv IS NULL THEN
    RAISE EXCEPTION 'no approved status rules' USING ERRCODE = '22023';
  END IF;

  FOR c IN
    WITH cl AS (
      SELECT x.*,
             CASE WHEN p_grain = 'month' THEN x.entry_month ELSE x.entry_week END AS p0,
             CASE WHEN x.conversion_day IS NULL THEN NULL
                  WHEN p_grain = 'month' THEN date_trunc('month', x.conversion_day)::date
                  ELSE date_trunc('week', x.conversion_day)::date END AS pc
        FROM public.drsnip_conversion_classify(p_form) x
    ),
    cx AS (
      SELECT cl.*,
             CASE WHEN NOT cl.converted OR cl.pc IS NULL THEN NULL
                  WHEN p_grain = 'month'
                    THEN greatest(0, (extract(year FROM cl.pc) * 12 + extract(month FROM cl.pc))
                                   - (extract(year FROM cl.p0) * 12 + extract(month FROM cl.p0)))::int
                  ELSE greatest(0, (cl.pc - cl.p0) / 7) END AS n
        FROM cl
    ),
    agg AS (
      SELECT cx.p0,
        count(*) FILTER (WHERE cx.is_covered)::int                                   AS n_cov,
        count(*) FILTER (WHERE NOT cx.is_covered)::int                               AS n_notcov,
        count(*) FILTER (WHERE cx.is_covered AND cx.converted)::int                  AS n_conv,
        count(*) FILTER (WHERE cx.is_covered AND cx.converted AND cx.n <= 0)::int    AS f0,
        count(*) FILTER (WHERE cx.is_covered AND cx.converted AND cx.n <= 1)::int    AS f1,
        count(*) FILTER (WHERE cx.is_covered AND cx.converted AND cx.n <= 2)::int    AS f2,
        count(*) FILTER (WHERE cx.is_covered AND cx.converted AND cx.n <= 3)::int    AS f3,
        count(*) FILTER (WHERE cx.is_covered AND cx.converted
                           AND cx.conversion_at < cx.entry_at)::int                  AS n_before
        FROM cx GROUP BY cx.p0
    ),
    unl AS (
      SELECT CASE WHEN p_grain = 'month'
                  THEN date_trunc('month', s.created_at AT TIME ZONE 'America/Los_Angeles')::date
                  ELSE date_trunc('week',  s.created_at AT TIME ZONE 'America/Los_Angeles')::date END AS p0,
             count(*)::int AS n
        FROM public.submissions s
       WHERE s.n8n_patient_id IS NULL AND s.form_type = p_form
       GROUP BY 1
    ),
    bounds AS (
      SELECT CASE WHEN p_grain = 'month'
                  THEN date_trunc('month', min(s.created_at) AT TIME ZONE 'America/Los_Angeles')::date
                  ELSE date_trunc('week',  min(s.created_at) AT TIME ZONE 'America/Los_Angeles')::date END AS lo,
             CASE WHEN p_grain = 'month'
                  THEN date_trunc('month', now() AT TIME ZONE 'America/Los_Angeles')::date
                  ELSE date_trunc('week',  now() AT TIME ZONE 'America/Los_Angeles')::date END AS hi
        FROM public.submissions s WHERE s.form_type = p_form
    ),
    periods AS (
      SELECT g::date AS p0 FROM bounds, generate_series(bounds.lo, bounds.hi, step) g
       WHERE bounds.lo IS NOT NULL
    )
    SELECT periods.p0, agg.n_cov, agg.n_notcov, agg.n_conv, agg.f0, agg.f1, agg.f2, agg.f3,
           agg.n_before, coalesce(unl.n, 0) AS n_unl
      FROM periods LEFT JOIN agg ON agg.p0 = periods.p0 LEFT JOIN unl ON unl.p0 = periods.p0
     ORDER BY periods.p0 DESC
  LOOP
    period_start := c.p0;
    period_end   := (c.p0 + step)::date;
    status_rules_version := rv;
    evidence_cutoff := cut;
    withheld := ARRAY[]::text[];

    -- Has the end of P+n passed, on the clinic calendar, at the evidence cutoff?
    e := ARRAY[]::boolean[];
    FOR i IN 0..3 LOOP
      e := e || (cut IS NOT NULL AND
                 ((c.p0 + step * (i + 1))::timestamp AT TIME ZONE 'America/Los_Angeles') <= cut);
    END LOOP;
    ended_p0 := e[1]; ended_p1 := e[2]; ended_p2 := e[3]; ended_p3 := e[4];
    period_complete := e[1];

    forms := coalesce(c.n_cov, 0); not_covered := coalesce(c.n_notcov, 0);
    converted_now := coalesce(c.n_conv, 0);
    v := ARRAY[coalesce(c.f0, 0), coalesce(c.f1, 0), coalesce(c.f2, 0), coalesce(c.f3, 0)];
    fill_p0 := CASE WHEN e[1] THEN v[1] END;
    fill_p1 := CASE WHEN e[2] THEN v[2] END;
    fill_p2 := CASE WHEN e[3] THEN v[3] END;
    fill_p3 := CASE WHEN e[4] THEN v[4] END;
    -- "Later" = converted by today, shown once P+3 has ended.
    fill_later := CASE WHEN e[4] THEN converted_now END;
    converted_before_entry := coalesce(c.n_before, 0);
    unlinked_submissions := CASE WHEN c.n_unl BETWEEN 1 AND k - 1 THEN NULL ELSE c.n_unl END;
    IF unlinked_submissions IS NULL THEN withheld := array_append(withheld, 'unlinked_submissions_small'); END IF;

    IF cut IS NULL THEN
      row_status := 'unavailable';
      withheld := array_append(withheld, 'evidence_cutoff_unavailable');
      forms := NULL; not_covered := NULL; converted_now := NULL; fill_p0 := NULL; fill_p1 := NULL;
      fill_p2 := NULL; fill_p3 := NULL; fill_later := NULL; converted_before_entry := NULL;
    ELSIF forms + not_covered = 0 THEN
      row_status := 'empty';
    ELSIF forms BETWEEN 1 AND k - 1 THEN
      row_status := 'suppressed';
      withheld := array_append(withheld, 'cohort_small');
      forms := NULL; not_covered := NULL; converted_now := NULL; fill_p0 := NULL; fill_p1 := NULL;
      fill_p2 := NULL; fill_p3 := NULL; fill_later := NULL; converted_before_entry := NULL;
    ELSE
      row_status := 'ok';
      IF not_covered BETWEEN 1 AND k - 1 THEN
        not_covered := NULL; withheld := array_append(withheld, 'not_covered_small');
      END IF;
      -- Converted vs not converted partitions the cohort: a small side hides both.
      IF converted_now BETWEEN 1 AND k - 1 OR (forms - converted_now) BETWEEN 1 AND k - 1 THEN
        converted_now := NULL; fill_later := NULL;
        withheld := array_append(withheld, 'converted_small');
      END IF;
      IF fill_p0 BETWEEN 1 AND k - 1 THEN fill_p0 := NULL; withheld := array_append(withheld, 'fill_small'); END IF;
      IF fill_p1 BETWEEN 1 AND k - 1 THEN fill_p1 := NULL; withheld := array_append(withheld, 'fill_small'); END IF;
      IF fill_p2 BETWEEN 1 AND k - 1 THEN fill_p2 := NULL; withheld := array_append(withheld, 'fill_small'); END IF;
      IF fill_p3 BETWEEN 1 AND k - 1 THEN fill_p3 := NULL; withheld := array_append(withheld, 'fill_small'); END IF;
      IF converted_before_entry BETWEEN 1 AND k - 1 THEN converted_before_entry := NULL; END IF;
    END IF;
    RETURN NEXT;
  END LOOP;
END;
$fn$;

ALTER FUNCTION public.drsnip_conversion_cohorts(text, text) OWNER TO drsnip_metrics_fn;
REVOKE ALL ON FUNCTION public.drsnip_conversion_cohorts(text, text) FROM PUBLIC;
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['drsnip_intake_demo', 'drsnip_reporting_ro'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.drsnip_conversion_cohorts(text,text) TO %I', r);
    END IF;
  END LOOP;
END $$;

-- Self-check: a month cohort's converted-as-of-today is Monthly outcomes'
-- converted, for every unsuppressed month of both forms.
DO $$
DECLARE f text; bad integer;
BEGIN
  FOREACH f IN ARRAY ARRAY['registration', 'insurance'] LOOP
    SELECT count(*) INTO bad
      FROM public.drsnip_conversion_cohorts(f, 'month') c
      JOIN public.drsnip_conversion_monthly(f, greatest(DATE '2026-01-01', (date_trunc('month', now())::date - interval '12 months')::date),
                                            (date_trunc('month', now())::date + interval '1 month')::date) m
        ON m.entry_month = c.period_start
     WHERE c.row_status = 'ok' AND m.row_status = 'ok'
       AND (c.converted_now IS DISTINCT FROM m.converted OR c.forms IS DISTINCT FROM m.covered)
       AND c.converted_now IS NOT NULL AND m.converted IS NOT NULL;
    IF bad > 0 THEN RAISE EXCEPTION 'cohort and monthly disagree for % (% months)', f, bad; END IF;
  END LOOP;
  RAISE NOTICE 'conversion cohorts installed';
END $$;

COMMIT;
