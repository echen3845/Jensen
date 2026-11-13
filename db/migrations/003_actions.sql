ALTER TABLE tasks ADD COLUMN checkpoint jsonb NOT NULL DEFAULT '{"v":1,"step":0,"calls":0,"history":[],"failures":0}';
CREATE TABLE actions(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL,task_id uuid NOT NULL,
 action_key text NOT NULL,tool text NOT NULL,tool_version integer NOT NULL,
 approval_nonce uuid NOT NULL,execution_token uuid,
 arguments jsonb NOT NULL,argument_hash text NOT NULL,action_hash text NOT NULL,preview text NOT NULL,
 effect text NOT NULL,required_permissions jsonb NOT NULL,
 status text NOT NULL CHECK(status IN ('pending','approved','running','succeeded','failed','uncertain','revoked')),
 expires_at timestamptz NOT NULL,result jsonb,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(task_id,action_key),FOREIGN KEY(task_id,user_id) REFERENCES tasks(id,user_id) ON DELETE CASCADE
);
CREATE INDEX actions_owner ON actions(user_id,task_id,created_at);
CREATE TABLE permission_grants(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 tool text NOT NULL,tool_version integer NOT NULL,argument_hash text NOT NULL,
 expires_at timestamptz NOT NULL,revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT now()
);
DO $policy$
DECLARE name text;
BEGIN FOREACH name IN ARRAY ARRAY['actions','permission_grants'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
 EXECUTE format('CREATE POLICY owner_access ON %I USING (user_id::text=current_setting(''jensen.user_id'',true)) WITH CHECK (user_id::text=current_setting(''jensen.user_id'',true))',name);
END LOOP;END $policy$;

CREATE UNIQUE INDEX task_request_identity ON tasks(user_id,(input->>'requestId')) WHERE input ? 'requestId';
