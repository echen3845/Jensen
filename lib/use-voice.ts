"use client";
import {useCallback,useEffect,useRef,useState,useSyncExternalStore} from "react";
export type RecognitionEvent=Event&{results:SpeechRecognitionResultList;resultIndex:number};
export type NativeRecognition={
 continuous:boolean;interimResults:boolean;lang:string;start:()=>void;stop:()=>void;abort?:()=>void;
 onstart:(()=>void)|null;onend:(()=>void)|null;
 onresult:((event:RecognitionEvent)=>void)|null;onerror:((event:{error?:string})=>void)|null;
};
declare global{interface Window{
 SpeechRecognition?:new()=>NativeRecognition;
 webkitSpeechRecognition?:new()=>NativeRecognition;
}}
type Options={
 spoken:boolean;onCommand:(text:string)=>Promise<void>;
 onDismiss:(reason:"dismiss"|"hidden"|"unmount")=>void;
 onStatus:(text:string)=>void;onCapture:(active:boolean)=>void;
};
const subscribe=()=>()=>{};
function support(){
 if(typeof window==="undefined")return"none";
 if(window.SpeechRecognition||window.webkitSpeechRecognition)return"native";
 if(typeof navigator.mediaDevices?.getUserMedia==="function"&&typeof window.MediaRecorder!=="undefined")return"recording";
 return"none";
}
export function useVoice(options:Options){
 const latest=useRef(options);
 useEffect(()=>{latest.current=options;});
 const mode=useSyncExternalStore(subscribe,support,()=>"none");
 const [handsFree,setHandsFree]=useState(false),[awake,setAwake]=useState(false);
 const control=useRef({enabled:false,awake:false,active:false,disposed:false,speaking:false,
  recognition:null as NativeRecognition|null,timer:undefined as ReturnType<typeof setTimeout>|undefined,
  utterance:null as SpeechSynthesisUtterance|null});
 const stopListening=useCallback(()=>{
  const state=control.current;state.enabled=false;state.awake=false;state.active=false;
  clearTimeout(state.timer);state.timer=undefined;
  state.recognition?.abort?.();
  if(!state.recognition?.abort)state.recognition?.stop();
  latest.current.onCapture(false);setHandsFree(false);setAwake(false);
 },[]);
 const start=useCallback((continuous:boolean)=>{
  const state=control.current;
  if(state.disposed||state.active||state.speaking||document.hidden||!state.recognition)return;
  try{
   state.active=true;state.recognition.continuous=continuous;
   latest.current.onStatus("Starting microphone");state.recognition.start();
  }catch{state.active=false;state.enabled=false;setHandsFree(false);latest.current.onCapture(false);latest.current.onStatus("Microphone unavailable. Try again.");}
 },[]);
 const stopSpeaking=useCallback(()=>{
  const state=control.current;state.speaking=false;state.utterance=null;
  window.speechSynthesis?.cancel();
  if(state.enabled&&!state.disposed)start(true);
 },[start]);
 const speak=useCallback((text:string)=>{
  const state=control.current;
  if(!latest.current.spoken||state.disposed||document.hidden||!window.speechSynthesis)return;
  state.speaking=true;state.active=false;
  clearTimeout(state.timer);
  state.recognition?.abort?.();if(!state.recognition?.abort)state.recognition?.stop();latest.current.onCapture(false);
  window.speechSynthesis.cancel();
  const utterance=new SpeechSynthesisUtterance(text);
  state.utterance=utterance;utterance.rate=1;utterance.pitch=.95;utterance.volume=.9;
  const done=()=>{
   if(state.disposed||state.utterance!==utterance)return;
   state.utterance=null;state.speaking=false;
   if(state.enabled)start(true);
  };
  utterance.onend=done;utterance.onerror=done;
  window.speechSynthesis.speak(utterance);
 },[start]);
 useEffect(()=>{if(!options.spoken)stopSpeaking();},[options.spoken,stopSpeaking]);
 useEffect(()=>{
  const state=control.current;state.disposed=false;
  const Constructor=window.SpeechRecognition||window.webkitSpeechRecognition;
  const recognition=Constructor?new Constructor():null;
  state.recognition=recognition;
  if(recognition){
   recognition.continuous=false;recognition.interimResults=false;recognition.lang="en-US";
   recognition.onstart=()=>{
    if(state.disposed||!state.active)return;
    latest.current.onCapture(true);
    latest.current.onStatus(state.enabled?(state.awake?"Jensen awake":"Listening for wake word"):"Listening");
   };
   recognition.onresult=event=>{
    if(state.disposed||!state.active||state.speaking)return;
    let text="";
    for(let i=event.resultIndex;i<event.results.length;i++)if(event.results[i].isFinal)text+=" "+event.results[i][0].transcript;
    text=text.trim();if(!text)return;
    if(state.enabled){
     if(/\b(dismiss|stand down|go to sleep|stop listening|thank you jensen|that's all|that will be all)\b/i.test(text)){
      state.awake=false;setAwake(false);stopSpeaking();
      latest.current.onDismiss("dismiss");latest.current.onStatus("Listening for wake word");return;
     }
     if(!state.awake){
      if(!/\bjensen\b/i.test(text))return;
      state.awake=true;setAwake(true);
      text=text.replace(/^.*?\bjensen\b[,.!?\s-]*/i,"").trim();
      if(!text){latest.current.onStatus("Jensen awake");return;}
     }
    }
    void latest.current.onCommand(text).catch(()=>{if(!state.disposed)latest.current.onStatus("Voice request failed. Try again.");});
   };
   recognition.onend=()=>{
    if(state.disposed)return;
    state.active=false;latest.current.onCapture(false);
    if(state.enabled&&!state.speaking&&!document.hidden){
     clearTimeout(state.timer);
     state.timer=setTimeout(()=>{state.timer=undefined;if(state.enabled&&!state.disposed)start(true);},350);
    }
   };
   recognition.onerror=()=>{
    if(state.disposed)return;
    stopListening();latest.current.onStatus("Voice input stopped. Check microphone permission and try again.");
   };
  }
  const hide=()=>{
   if(!document.hidden)return;
   stopListening();stopSpeaking();latest.current.onDismiss("hidden");
   latest.current.onStatus("Microphone stopped while page is hidden.");
  };
  const pagehide=()=>{stopListening();stopSpeaking();latest.current.onDismiss("hidden");};
  document.addEventListener("visibilitychange",hide);window.addEventListener("pagehide",pagehide);
  return()=>{
   state.disposed=true;state.enabled=false;state.active=false;clearTimeout(state.timer);
   if(recognition){recognition.onstart=null;recognition.onresult=null;recognition.onend=null;recognition.onerror=null;recognition.abort?.();if(!recognition.abort)recognition.stop();}
   state.recognition=null;state.utterance=null;state.speaking=false;window.speechSynthesis?.cancel();
   document.removeEventListener("visibilitychange",hide);window.removeEventListener("pagehide",pagehide);
   latest.current.onDismiss("unmount");
  };
 },[start,stopListening,stopSpeaking]);
 return{mode,handsFreeEnabled:handsFree,assistantAwake:awake,speak,stopSpeaking,stopListening,
  isHandsFree:()=>control.current.enabled,
  startManual:()=>start(false),
  toggleHandsFree:()=>{
   if(control.current.enabled){stopListening();latest.current.onStatus("Microphone off");return;}
   if(mode!=="native"){latest.current.onStatus("Hands-free needs browser speech recognition.");return;}
   control.current.enabled=true;control.current.awake=false;setHandsFree(true);setAwake(false);start(true);
  }};
}
