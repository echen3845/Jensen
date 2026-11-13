// @vitest-environment jsdom
import {StrictMode} from "react";
import {act,cleanup,fireEvent,render,renderHook,screen,waitFor} from "@testing-library/react";
import {afterEach,describe,expect,it,vi} from "vitest";
import {useVoice,type RecognitionEvent,type NativeRecognition} from "../lib/use-voice";
import {getClientLimits} from "../lib/resource-limits";
import Assistant from "../app/assistant";
vi.mock("next/navigation",()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock("../lib/use-history",async()=>{
 const {useState}=await import("react");
 return{useHistory:(_id:unknown,welcome:unknown[])=>{
  const[messages,setMessages]=useState(welcome);
  return{messages,setMessages,items:[],conversationId:null,ready:true,error:"",hasMore:false,
   clearScope:vi.fn(),create:vi.fn(async()=>{}),select:vi.fn(),older:vi.fn(),latest:vi.fn()};
 }};
});
class Recognition implements NativeRecognition{
 static instances:Recognition[]=[];
 continuous=false;interimResults=false;lang="";
 onstart:(()=>void)|null=null;onend:(()=>void)|null=null;
 onresult:((event:RecognitionEvent)=>void)|null=null;onerror:((event:{error?:string})=>void)|null=null;
 start=vi.fn(()=>this.onstart?.());stop=vi.fn(()=>this.onend?.());abort=vi.fn(()=>this.onend?.());
 constructor(){Recognition.instances.push(this);}
 emit(text:string){this.onresult?.({resultIndex:0,results:[{0:{transcript:text},isFinal:true,length:1}]} as unknown as RecognitionEvent);}
}
function environment(){
 Recognition.instances=[];
 vi.stubGlobal("SpeechRecognition",Recognition);
 Object.defineProperty(window,"SpeechRecognition",{configurable:true,value:Recognition});
 vi.stubGlobal("SpeechSynthesisUtterance",class{constructor(public text:string){}});
 Object.defineProperty(window,"speechSynthesis",{configurable:true,value:{cancel:vi.fn(),speak:vi.fn()}});
 Object.defineProperty(document,"hidden",{configurable:true,value:false});
 Element.prototype.scrollIntoView=vi.fn();
}
afterEach(()=>{cleanup();vi.useRealTimers();});
describe("voice lifecycle",()=>{
 it("uses current callbacks/settings after several rerenders without duplicating recognizers",async()=>{
  environment();
  const first=vi.fn(async()=>{}),second=vi.fn(async()=>{});
  const capture=vi.fn(),dismiss=vi.fn(),status=vi.fn();
  const {result,rerender}=renderHook(({spoken,onCommand})=>useVoice({spoken,onCommand,onCapture:capture,onDismiss:dismiss,onStatus:status}),{initialProps:{spoken:true,onCommand:first}});
  act(()=>result.current.startManual());
  rerender({spoken:false,onCommand:second});
  await act(async()=>Recognition.instances.at(-1)!.emit("New request"));
  expect(first).not.toHaveBeenCalled();expect(second).toHaveBeenCalledWith("New request");
  act(()=>result.current.speak("Do not speak"));expect(window.speechSynthesis.speak).not.toHaveBeenCalled();
  rerender({spoken:true,onCommand:second});
  act(()=>result.current.speak("Now speak"));expect(window.speechSynthesis.speak).toHaveBeenCalledOnce();
  expect(Recognition.instances).toHaveLength(1);
 });
 it("does not restart after disabling hands-free and cleans Strict Mode handlers",async()=>{
  environment();vi.useFakeTimers();
  const callback=vi.fn(async()=>{});
  const {result,unmount}=renderHook(()=>useVoice({spoken:false,onCommand:callback,onCapture:vi.fn(),onDismiss:vi.fn(),onStatus:vi.fn()}),{wrapper:StrictMode});
  const recognition=Recognition.instances.at(-1)!;
  act(()=>result.current.toggleHandsFree());
  act(()=>recognition.onend?.());
  act(()=>result.current.stopListening());
  await act(async()=>vi.advanceTimersByTimeAsync(1000));
  expect(recognition.start).toHaveBeenCalledOnce();
  unmount();
  for(const instance of Recognition.instances){expect(instance.onresult).toBe(null);expect(instance.onend).toBe(null);}
  expect(vi.getTimerCount()).toBe(0);
 });
 it("stops capture on visibility loss and never treats the wake word as approval",async()=>{
  environment();const dismiss=vi.fn(),command=vi.fn(async()=>{});
  const {result}=renderHook(()=>useVoice({spoken:false,onCommand:command,onCapture:vi.fn(),onDismiss:dismiss,onStatus:vi.fn()}));
  act(()=>result.current.toggleHandsFree());
  await act(async()=>Recognition.instances.at(-1)!.emit("Jensen"));
  expect(command).not.toHaveBeenCalled();
  Object.defineProperty(document,"hidden",{configurable:true,value:true});
  act(()=>document.dispatchEvent(new Event("visibilitychange")));
  expect(result.current.handsFreeEnabled).toBe(false);
  expect(dismiss).toHaveBeenCalledWith("hidden");
 });
 it("uses the currently selected chat mode for native voice commands",async()=>{
  environment();
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({reply:"Answered"}),{headers:{"content-type":"application/json"}}));
  render(<Assistant limits={getClientLimits()} identity={null}/>);
  fireEvent.click(screen.getByRole("button",{name:"Flirty"}));
  fireEvent.click(screen.getByRole("checkbox",{name:"Spoken replies"}));
  fireEvent.click(screen.getByRole("button",{name:"Start listening"}));
  await act(async()=>Recognition.instances.at(-1)!.emit("Hello"));
  await waitFor(()=>expect(fetch).toHaveBeenCalled());
  const init=vi.mocked(fetch).mock.calls[0][1]!;
  expect(JSON.parse(init.body as string).mode).toBe("flirty");
  expect(window.speechSynthesis.speak).not.toHaveBeenCalled();
 });
 it("aborts and discards a delayed response after starting a new conversation",async()=>{
  environment();let resolve:(response:Response)=>void=()=>{};
  vi.mocked(fetch).mockImplementation(()=>new Promise(r=>{resolve=r;}));
  render(<Assistant limits={getClientLimits()} identity={null}/>);
  fireEvent.change(screen.getByRole("textbox",{name:"Message Jensen"}),{target:{value:"Question"}});
  fireEvent.click(screen.getByRole("button",{name:"Send"}));
  await waitFor(()=>expect(fetch).toHaveBeenCalledOnce());
  const signal=vi.mocked(fetch).mock.calls[0][1]!.signal!;
  fireEvent.click(screen.getByRole("button",{name:"New conversation"}));
  expect(signal.aborted).toBe(true);
  await act(async()=>resolve(new Response(JSON.stringify({reply:"Late private response"}))));
  expect(screen.queryByText("Late private response")).toBe(null);
  expect(window.speechSynthesis.speak).not.toHaveBeenCalled();
 });
 it("discards a delayed transcription after changing conversation",async()=>{
  environment();
  Object.defineProperty(window,"SpeechRecognition",{configurable:true,value:undefined});
  const trackStop=vi.fn();
  Object.defineProperty(navigator,"mediaDevices",{configurable:true,value:{getUserMedia:vi.fn(async()=>({getTracks:()=>[{stop:trackStop}]}))}});
  class Recorder{
   static latest:Recorder;
   static isTypeSupported=()=>true;
   state="inactive";mimeType="audio/webm";
   ondataavailable:((event:{data:Blob})=>void)|null=null;onstop:(()=>void)|null=null;onerror=null;
   constructor(){Recorder.latest=this;}
   start(){this.state="recording";}
   stop(){this.state="inactive";this.ondataavailable?.({data:new Blob(["audio"])});this.onstop?.();}
  }
  vi.stubGlobal("MediaRecorder",Recorder);
  let resolve:(response:Response)=>void=()=>{};
  vi.mocked(fetch).mockImplementation(()=>new Promise(r=>{resolve=r;}));
  render(<Assistant limits={getClientLimits()} identity={null}/>);
  fireEvent.click(screen.getByRole("button",{name:"Start listening"}));
  await waitFor(()=>expect(screen.getByRole("button",{name:"Finish recording"})).toBeTruthy());
  expect(Recorder.latest).toBeDefined();
  fireEvent.click(screen.getByRole("button",{name:"Finish recording"}));
  await waitFor(()=>expect(fetch).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button",{name:"New conversation"}));
  await act(async()=>resolve(new Response(JSON.stringify({text:"Late private transcript"}))));
  expect(fetch).toHaveBeenCalledOnce();
  expect((screen.getByRole("textbox",{name:"Message Jensen"}) as HTMLInputElement).value).not.toBe("Late private transcript");
  expect(trackStop).toHaveBeenCalled();
 });
});
