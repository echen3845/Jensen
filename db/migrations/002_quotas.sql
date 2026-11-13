CREATE TABLE rate_limits(scope text NOT NULL,bucket bigint NOT NULL,used integer NOT NULL,PRIMARY KEY(scope,bucket));
CREATE TABLE usage_windows(
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,bucket date NOT NULL,
 spent bigint NOT NULL DEFAULT 0 CHECK(spent>=0),reserved bigint NOT NULL DEFAULT 0 CHECK(reserved>=0),
 requests integer NOT NULL DEFAULT 0,PRIMARY KEY(user_id,bucket)
);
CREATE TABLE provider_leases(
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,bucket date NOT NULL,
 operation text NOT NULL,reservation bigint NOT NULL CHECK(reservation>=0),
 expires_at timestamptz NOT NULL,state text NOT NULL CHECK(state IN ('pending','settled','charged')),
 final_cost bigint,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX active_provider_leases ON provider_leases(state,expires_at,user_id);
