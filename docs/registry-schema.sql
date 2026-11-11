-- Schema of the `registry` database (ЄДР), taken from production on 2026-11-11 (PostgreSQL 17.11).
-- Read-only for Sonar. Used by docker/compose.dev.yml to create an empty local copy.
-- Left out on purpose: leftover trigger functions of the old app and internal tables of the old
-- importer (edr_control, edr_queue_jobs, edr_failed_jobs, edr_proxy_state, edr_quarantine).
-- Production row counts: edr_legal_entities ~2.02M, edr_fops ~7.07M, edr_founders ~6.55M,
-- edr_public_organizations ~213k, edr_branches ~1.7k.

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

-- Sources and versions of the open dataset (data.gov.ua)
CREATE TABLE public.edr_sources (
    id bigserial PRIMARY KEY,
    source_key text NOT NULL UNIQUE,
    name text NOT NULL,
    catalog_url text NOT NULL,
    license text,
    attribution text NOT NULL,
    last_checked_at timestamptz,
    metadata_hash character(64),
    status text DEFAULT 'new' NOT NULL,
    error_code text,
    metadata jsonb DEFAULT '{}' NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE public.edr_dataset_versions (
    id bigserial PRIMARY KEY,
    source_id bigint NOT NULL REFERENCES public.edr_sources(id),
    version_key character(64) NOT NULL UNIQUE,
    published_at date,
    manifest jsonb NOT NULL,
    status text DEFAULT 'discovered' NOT NULL,
    stage text DEFAULT 'download' NOT NULL,
    type_outcomes jsonb DEFAULT '{}' NOT NULL,
    download_checkpoint jsonb DEFAULT '{}' NOT NULL,
    archive_sha256 character(64),
    schema_sha256 character(64),
    local_archive_path text,
    local_schema_path text,
    prepared_entries jsonb DEFAULT '{}' NOT NULL,
    error_code text,
    integrity_verified boolean DEFAULT false NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    completed_at timestamptz
);
CREATE INDEX edr_versions_status ON public.edr_dataset_versions USING btree (status, id DESC);

CREATE TABLE public.edr_import_runs (
    id bigserial PRIMARY KEY,
    dataset_version_id bigint REFERENCES public.edr_dataset_versions(id),
    entity_type text CHECK (entity_type = ANY (ARRAY['UO','FOP','FSU'])),
    file_sha256 character(64),
    owner_token uuid,
    run_type text DEFAULT 'import' NOT NULL CHECK (run_type = ANY (ARRAY['import','discover','download','enrich','check'])),
    source_key text,
    checkpoint jsonb DEFAULT '{}' NOT NULL,
    peak_memory_bytes bigint DEFAULT 0 NOT NULL,
    elapsed_seconds numeric DEFAULT 0 NOT NULL,
    rows_per_second numeric DEFAULT 0 NOT NULL,
    mode text DEFAULT 'bounded' NOT NULL CHECK (mode = ANY (ARRAY['full','bounded'])),
    limit_rows bigint,
    status text DEFAULT 'running' NOT NULL,
    checkpoint_offset bigint DEFAULT 0 NOT NULL,
    processed_count bigint DEFAULT 0 NOT NULL,
    inserted_count bigint DEFAULT 0 NOT NULL,
    updated_count bigint DEFAULT 0 NOT NULL,
    unchanged_count bigint DEFAULT 0 NOT NULL,
    quarantined_count bigint DEFAULT 0 NOT NULL,
    expected_count bigint,
    complete_validated boolean DEFAULT false NOT NULL,
    missing_cursor bigint DEFAULT 0 NOT NULL,
    error_code text,
    heartbeat_at timestamptz DEFAULT now() NOT NULL,
    started_at timestamptz DEFAULT now() NOT NULL,
    completed_at timestamptz,
    CHECK ((run_type <> 'import') OR ((entity_type IS NOT NULL) AND (file_sha256 IS NOT NULL)))
);

-- Entities. Four tables share one id sequence and one column layout.
-- entity_type: UO = legal entity, FOP = sole proprietor, FSU = branch.
-- edrpou: 8-digit code (for FOP usually NULL — personal tax number is not published).
-- normalized_name: lower-cased name for search (trigram index). status: registry status text.
-- raw_payload: the full source record from the XML (address parts, activities/КВЕД, etc.).
CREATE SEQUENCE public.edr_legal_entities_id_seq;

CREATE TABLE public.edr_legal_entities (
    id bigint DEFAULT nextval('public.edr_legal_entities_id_seq') PRIMARY KEY,
    source_record_id text NOT NULL UNIQUE CHECK (length(source_record_id) BETWEEN 4 AND 260),
    entity_type text DEFAULT 'UO' NOT NULL CHECK (entity_type = ANY (ARRAY['UO','FOP','FSU'])),
    edrpou character varying(8) CHECK (edrpou IS NULL OR edrpou ~ '^[0-9]{8}$'),
    name text,
    short_name text,
    normalized_name text,
    status text,
    registration_date date,
    termination_date date,
    director text,
    address text,
    raw_payload jsonb DEFAULT '{}' NOT NULL,
    row_hash character(64) NOT NULL,
    source_version_id bigint REFERENCES public.edr_dataset_versions(id),
    last_seen_run_id bigint REFERENCES public.edr_import_runs(id),
    first_seen_at timestamptz DEFAULT now() NOT NULL,
    last_seen_at timestamptz DEFAULT now() NOT NULL,
    missing_since timestamptz
);
CREATE INDEX edr_uo_edrpou ON public.edr_legal_entities USING btree (edrpou) WHERE edrpou IS NOT NULL;
CREATE INDEX edr_uo_name_exact ON public.edr_legal_entities USING btree (md5(normalized_name));
CREATE INDEX edr_legal_entities_name_trgm ON public.edr_legal_entities USING gin (normalized_name public.gin_trgm_ops);
CREATE INDEX edr_legal_entities_registration ON public.edr_legal_entities USING btree (registration_date);
CREATE INDEX edr_legal_entities_status_date ON public.edr_legal_entities USING btree (status, registration_date);

CREATE TABLE public.edr_fops (LIKE public.edr_legal_entities INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
ALTER TABLE public.edr_fops ALTER COLUMN entity_type SET DEFAULT 'FOP';
ALTER TABLE public.edr_fops ADD PRIMARY KEY (id), ADD UNIQUE (source_record_id),
    ADD FOREIGN KEY (source_version_id) REFERENCES public.edr_dataset_versions(id),
    ADD FOREIGN KEY (last_seen_run_id) REFERENCES public.edr_import_runs(id);
CREATE INDEX edr_fop_edrpou ON public.edr_fops USING btree (edrpou) WHERE edrpou IS NOT NULL;
CREATE INDEX edr_fop_name_exact ON public.edr_fops USING btree (md5(normalized_name));
CREATE INDEX edr_fops_name_trgm ON public.edr_fops USING gin (normalized_name public.gin_trgm_ops);
CREATE INDEX edr_fops_registration ON public.edr_fops USING btree (registration_date);
CREATE INDEX edr_fops_status_date ON public.edr_fops USING btree (status, registration_date);

CREATE TABLE public.edr_branches (LIKE public.edr_legal_entities INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
ALTER TABLE public.edr_branches ALTER COLUMN entity_type SET DEFAULT 'FSU';
ALTER TABLE public.edr_branches ADD PRIMARY KEY (id), ADD UNIQUE (source_record_id),
    ADD FOREIGN KEY (source_version_id) REFERENCES public.edr_dataset_versions(id),
    ADD FOREIGN KEY (last_seen_run_id) REFERENCES public.edr_import_runs(id);
CREATE INDEX edr_fsu_edrpou ON public.edr_branches USING btree (edrpou) WHERE edrpou IS NOT NULL;
CREATE INDEX edr_fsu_name_exact ON public.edr_branches USING btree (md5(normalized_name));
CREATE INDEX edr_branches_name_trgm ON public.edr_branches USING gin (normalized_name public.gin_trgm_ops);
CREATE INDEX edr_branches_registration ON public.edr_branches USING btree (registration_date);
CREATE INDEX edr_branches_status_date ON public.edr_branches USING btree (status, registration_date);

-- Public organizations: legal entities classified as public bodies (subset of edr_legal_entities).
CREATE TABLE public.edr_public_organizations (LIKE public.edr_legal_entities INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
ALTER TABLE public.edr_public_organizations
    ADD COLUMN legal_entity_id bigint NOT NULL UNIQUE REFERENCES public.edr_legal_entities(id),
    ADD COLUMN classification text NOT NULL,
    ADD COLUMN evidence jsonb NOT NULL,
    ADD COLUMN observed_at timestamptz DEFAULT now() NOT NULL;
ALTER TABLE public.edr_public_organizations ADD PRIMARY KEY (id), ADD UNIQUE (source_record_id),
    ADD FOREIGN KEY (source_version_id) REFERENCES public.edr_dataset_versions(id),
    ADD FOREIGN KEY (last_seen_run_id) REFERENCES public.edr_import_runs(id);

-- Founders, beneficiaries, signers. entity_type + entity_id point to one of the entity tables.
CREATE TABLE public.edr_founders (
    id bigserial PRIMARY KEY,
    entity_type text NOT NULL,
    entity_id bigint NOT NULL,
    role text NOT NULL,
    name text,
    statement text NOT NULL,
    statement_hash character(64) NOT NULL,
    country text,
    share numeric,
    is_person boolean,
    source_version_id bigint REFERENCES public.edr_dataset_versions(id),
    UNIQUE (entity_type, entity_id, role, statement_hash)
);

-- Contacts found for registry entities by the old enrichment (phones, emails, sites) with sources.
CREATE TABLE public.edr_contacts (
    id bigserial PRIMARY KEY,
    entity_type text NOT NULL,
    entity_id bigint NOT NULL,
    kind text NOT NULL,
    value text NOT NULL,
    normalized_value text NOT NULL,
    is_organization_contact boolean,
    found_at timestamptz DEFAULT now() NOT NULL,
    last_verified_at timestamptz,
    confidence numeric(5,4) DEFAULT 0 NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    first_seen_at timestamptz DEFAULT now() NOT NULL,
    last_seen_at timestamptz DEFAULT now() NOT NULL,
    UNIQUE (entity_type, entity_id, kind, normalized_value)
);

CREATE TABLE public.edr_contact_sources (
    id bigserial PRIMARY KEY,
    contact_id bigint NOT NULL REFERENCES public.edr_contacts(id) ON DELETE CASCADE,
    source_key text NOT NULL,
    source_url text NOT NULL,
    evidence_hash character(64) NOT NULL,
    source_version_id bigint REFERENCES public.edr_dataset_versions(id),
    observed_at timestamptz DEFAULT now() NOT NULL,
    UNIQUE (contact_id, source_key, evidence_hash)
);

CREATE TABLE public.edr_enrichment_facts (
    id bigserial PRIMARY KEY,
    entity_type text NOT NULL,
    entity_id bigint NOT NULL,
    source_key text NOT NULL,
    field text NOT NULL,
    value jsonb NOT NULL,
    evidence_hash character(64) NOT NULL,
    source_url text NOT NULL,
    observed_at timestamptz DEFAULT now() NOT NULL,
    UNIQUE (entity_type, entity_id, source_key, field, evidence_hash)
);
CREATE INDEX edr_facts_entity ON public.edr_enrichment_facts USING btree (entity_type, entity_id, field);

CREATE TABLE public.edr_entity_links (
    id bigserial PRIMARY KEY,
    entity_type text NOT NULL,
    entity_id bigint NOT NULL,
    related_type text NOT NULL,
    related_source_record_id text,
    related_edrpou character varying(8),
    relation text NOT NULL,
    evidence_hash character(64) NOT NULL,
    source_version_id bigint REFERENCES public.edr_dataset_versions(id),
    UNIQUE (entity_type, entity_id, relation, evidence_hash)
);

CREATE TABLE public.edr_status_history (
    id bigserial PRIMARY KEY,
    entity_type text NOT NULL,
    entity_id bigint NOT NULL,
    previous_status text,
    status text,
    source_version_id bigint REFERENCES public.edr_dataset_versions(id),
    observed_at timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX edr_history_entity ON public.edr_status_history USING btree (entity_type, entity_id, id);

CREATE TABLE public.edr_stats (
    entity_type text PRIMARY KEY CHECK (entity_type = ANY (ARRAY['UO','FOP','FSU'])),
    total_count bigint DEFAULT 0 NOT NULL,
    missing_count bigint DEFAULT 0 NOT NULL,
    status_counts jsonb DEFAULT '{}' NOT NULL,
    metrics jsonb DEFAULT '{}' NOT NULL,
    last_complete_version_id bigint REFERENCES public.edr_dataset_versions(id),
    indexes_ready boolean DEFAULT false NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL
);
