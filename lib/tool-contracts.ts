import {createHash} from "node:crypto";
import {z} from "zod";
import {ApiError} from "./api-errors";
export type Effect="read"|"reversible"|"external-message"|"paid-cancellation"|"purchase"|"commitment";
export type ToolContext={userId:string;taskId:string;signal:AbortSignal;idempotencyKey:string;leaseToken?:string;assertActive:()=>Promise<void>};
export type Tool={
 name:string;version:number;description:string;permissions:string[];effect:Effect;
 approval:"required"|"read-own";idempotent:boolean;schema:Record<string,unknown>;
 validate:(input:unknown)=>unknown;preview:(input:unknown)=>string;
 execute:(input:unknown,context:ToolContext)=>Promise<unknown>;
};
export function defineTool<S extends z.ZodType>(definition:{
 name:string;version:number;description:string;permissions:string[];effect:Effect;
 approval:"required"|"read-own";idempotent:boolean;input:S;
 preview:(input:z.output<S>)=>string;execute:(input:z.output<S>,context:ToolContext)=>Promise<unknown>;
}):Tool{
 const validate=(input:unknown)=>{
  const result=definition.input.safeParse(input);
  if(!result.success)throw new ApiError(400,"invalid_tool_arguments","Tool arguments do not match the registered schema.");
  return result.data;
 };
 return{...definition,schema:z.toJSONSchema(definition.input,{target:"draft-7"}),
  validate,preview:input=>definition.preview(validate(input)),
  execute:(input,context)=>definition.execute(validate(input),context)};
}
export function canonical(value:unknown):string{
 if(value===null||typeof value!=="object")return JSON.stringify(value);
 if(Array.isArray(value))return"["+value.map(canonical).join(",")+"]";
 return"{"+Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>JSON.stringify(k)+":"+canonical(v)).join(",")+"}";
}
export function digest(value:unknown){return createHash("sha256").update(canonical(value)).digest("hex");}
export function argumentFingerprint(tool:Tool,args:unknown){
 return digest({tool:tool.name,version:tool.version,arguments:args,effect:tool.effect,
  permissions:tool.permissions,schema:tool.schema,approval:tool.approval,idempotent:tool.idempotent});
}
export function toolFrom(registry:Tool[],name:string){
 const tool=registry.find(tool=>tool.name===name);
 if(!tool)throw new ApiError(400,"unsupported_tool","This tool is not registered.");
 return tool;
}
