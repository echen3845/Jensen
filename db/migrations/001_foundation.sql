CREATE TABLE users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), issuer text NOT NULL, subject text NOT NULL,
 email text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(issuer,subject)
);
CREATE TABLE sessions (
 token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE login_states (state_hash text PRIMARY KEY, expires_at timestamptz NOT NULL);
CREATE TABLE conversations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 title text NOT NULL DEFAULT 'Conversation', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,user_id)
);
CREATE INDEX conversations_owner ON conversations(user_id,created_at DESC,id);
CREATE TABLE messages (
 id uuid PRIMARY KEY, user_id uuid NOT NULL, conversation_id uuid NOT NULL,
 seq bigserial UNIQUE, role text NOT NULL CHECK(role IN ('user','assistant')),
 content text NOT NULL CHECK(octet_length(content)<=65536), reply_to uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(conversation_id,user_id) REFERENCES conversations(id,user_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX one_reply_per_prompt ON messages(reply_to) WHERE reply_to IS NOT NULL;
CREATE INDEX messages_page ON messages(user_id,conversation_id,seq DESC);
CREATE TABLE preferences (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, key text NOT NULL,
 value text NOT NULL, provenance text NOT NULL DEFAULT 'explicit-user',
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,key)
);
CREATE TABLE connected_accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 provider text NOT NULL, label text NOT NULL, credential bytea,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,user_id)
);
CREATE TABLE tasks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','waiting-for-user','succeeded','failed','cancelled')),
 input jsonb NOT NULL, result jsonb, error_code text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,user_id)
);
CREATE INDEX tasks_owner ON tasks(user_id,created_at DESC,id);
CREATE TABLE action_events (
 seq bigserial PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 task_id uuid, action_id uuid, kind text NOT NULL, data jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_owner ON action_events(user_id,seq DESC);
DO $policy$
DECLARE name text;
BEGIN
 FOREACH name IN ARRAY ARRAY['conversations','messages','preferences','connected_accounts','tasks','action_events'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', name);
  EXECUTE format('CREATE POLICY owner_access ON %I USING (user_id::text = current_setting(''jensen.user_id'',true)) WITH CHECK (user_id::text = current_setting(''jensen.user_id'',true))',name);
 END LOOP;
END $policy$;
