import {database,closeDatabase} from "../lib/db";
import {rotateCredentials} from "../lib/secrets";
import {uuid} from "../lib/store";
try{process.loadEnvFile(".env.local");}catch{}
async function run(){
 const selection=process.argv[2];
 if(!selection)throw new Error("Provide an owner UUID or --all");
 const users=selection==="--all"?(await database().query("SELECT id FROM users")).rows:[{id:uuid(selection)}];
 for(const user of users)await rotateCredentials(user.id);
 console.log("Credential rotation completed.");
}
run().catch(()=>{console.error("Credential rotation failed. Retain old keys and check configuration.");process.exitCode=1;}).finally(closeDatabase);
