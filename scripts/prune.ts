import { database,closeDatabase,transaction } from "../lib/db";
try {process.loadEnvFile(".env.local");} catch {}
async function prune() {
 await database().query("DELETE FROM sessions WHERE expires_at<now()");
 await database().query("DELETE FROM login_states WHERE expires_at<now()");
 const users=(await database().query("SELECT id FROM users")).rows;
 for(const {id} of users) await transaction(async c=>{
  await c.query("DELETE FROM messages WHERE user_id=$1 AND created_at<now()-interval '90 days'",[id]);
  await c.query("DELETE FROM action_events WHERE user_id=$1 AND created_at<now()-interval '90 days'",[id]);
 },id);
}
prune().then(()=>console.log("Expired sessions, states, and 90-day history pruned."))
 .catch(()=>{console.error("Retention job failed.");process.exitCode=1;}).finally(closeDatabase);
