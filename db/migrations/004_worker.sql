CREATE TABLE task_queue(
 task_id uuid PRIMARY KEY,user_id uuid NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','waiting','succeeded','failed','cancelled')),
 lease_token uuid,lease_until timestamptz,available_at timestamptz NOT NULL DEFAULT now(),
 attempts integer NOT NULL DEFAULT 0,max_attempts integer NOT NULL DEFAULT 3 CHECK(max_attempts BETWEEN 1 AND 5),
 runs integer NOT NULL DEFAULT 0,
 FOREIGN KEY(task_id,user_id) REFERENCES tasks(id,user_id) ON DELETE CASCADE
);
CREATE INDEX eligible_tasks ON task_queue(state,available_at,lease_until);
INSERT INTO task_queue(task_id,user_id,state)
 SELECT id,user_id,CASE WHEN status='waiting-for-user' THEN 'waiting' ELSE 'pending' END FROM tasks WHERE status IN ('pending','running','waiting-for-user');
CREATE TABLE global_usage_windows(bucket date PRIMARY KEY,spent bigint NOT NULL DEFAULT 0 CHECK(spent>=0),reserved bigint NOT NULL DEFAULT 0 CHECK(reserved>=0));
INSERT INTO global_usage_windows(bucket,spent,reserved) SELECT bucket,sum(spent),sum(reserved) FROM usage_windows GROUP BY bucket;
ALTER TABLE provider_leases DROP CONSTRAINT provider_leases_user_id_fkey;
ALTER TABLE provider_leases ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE provider_leases ADD FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL;
