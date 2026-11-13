export class ConversationScope {
 private generation=0;
 private active=new Map<AbortController,ReturnType<typeof setTimeout>>();
 begin(timeout:number){
  const generation=this.generation,controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(new DOMException("Request timed out","TimeoutError")),timeout);
  this.active.set(controller,timer);
  return{signal:controller.signal,current:()=>generation===this.generation,usable:()=>generation===this.generation&&!controller.signal.aborted,
   finish:()=>{clearTimeout(timer);this.active.delete(controller);}};
 }
 cancel(){
  this.generation++;
  for(const[controller,timer]of this.active){clearTimeout(timer);controller.abort();}
  this.active.clear();
 }
}
