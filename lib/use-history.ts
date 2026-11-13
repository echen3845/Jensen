"use client";
import {useCallback,useEffect,useRef,useState,type SetStateAction} from "react";
export type HistoryMessage={id:string;role:"user"|"assistant";content:string;seq?:string};
type Conversation={id:string;title:string};
export function removeLegacyHistory(){try{window.localStorage.removeItem("jensen.messages");}catch{}}
export function useHistory(userId:string|null,welcome:HistoryMessage[]){
 const [messages,updateMessages]=useState(welcome);
 const setMessages=useCallback((value:SetStateAction<HistoryMessage[]>)=>{
  updateMessages(current=>(typeof value==="function"?value(current):value).slice(-100));
 },[]);
 const [items,setItems]=useState<Conversation[]>([]);
 const [conversationId,setConversationId]=useState<string|null>(null);
 const [ready,setReady]=useState(!userId);
 const [error,setError]=useState("");
 const [cursor,setCursor]=useState<string|null>(null);
 const [hasMore,setHasMore]=useState(false);
 const generation=useRef({value:0});
 const selected=useRef<string|null>(null);
 const clearScope=useCallback(()=>{
  generation.current.value++;selected.current=null;
  setMessages(welcome);setItems([]);setConversationId(null);setReady(false);
  setError("Session changed or expired. Reload and sign in to continue.");
 },[setMessages,welcome]);
 const load=useCallback(async(id:string,before?:string)=>{
  const snapshot=generation.current.value;
  const response=await fetch("/api/conversations/"+id+(before?"?before="+before:""),{cache:"no-store",signal:AbortSignal.timeout(10000)});
  const body=await response.json();
  if(snapshot!==generation.current.value||selected.current!==id)return false;
  if(!response.ok){if(response.status===401||response.status===404)clearScope();throw new Error("Cannot restore history.");}
  setMessages(body.messages.length?body.messages:welcome);
  setCursor(body.cursor);setHasMore(body.hasMore);return true;
 },[clearScope,setMessages,welcome]);
 const select=useCallback(async(id:string)=>{
  const snapshot=++generation.current.value;
  selected.current=id;setConversationId(id);setReady(false);
  try{if(await load(id)&&snapshot===generation.current.value)setReady(true);}
  catch{if(snapshot===generation.current.value){setMessages(welcome);setError("Unable to restore history. Reload to retry.");}}
 },[load,setMessages,welcome]);
 const create=useCallback(async()=>{
  if(!userId){setMessages(welcome);return;}
  const snapshot=generation.current.value;
  const response=await fetch("/api/conversations",{method:"POST",headers:{"content-type":"application/json"},body:"{}",signal:AbortSignal.timeout(10000)});
  const body=await response.json();
  if(snapshot!==generation.current.value)return;
  if(!response.ok){if(response.status===401)clearScope();throw new Error("Cannot create conversation.");}
  setItems(current=>[body.conversation,...current].slice(0,30));
  await select(body.conversation.id);
 },[clearScope,select,setMessages,userId,welcome]);
 useEffect(()=>{
  removeLegacyHistory();
  let active=true;
  const lifetime=generation.current;
  async function initialize(){
   const snapshot=++lifetime.value;
   selected.current=null;
   setMessages(welcome);setItems([]);setConversationId(null);setError("");setReady(!userId);
   if(!userId)return;
   try{
    const session=await fetch("/api/auth/session",{cache:"no-store",signal:AbortSignal.timeout(10000)});
    const identity=await session.json();
    if(!active||snapshot!==lifetime.value)return;
    if(identity.user?.id!==userId){clearScope();return;}
    const response=await fetch("/api/conversations",{cache:"no-store",signal:AbortSignal.timeout(10000)});
    const body=await response.json();
    if(!active||snapshot!==lifetime.value)return;
    if(!response.ok)throw new Error("Sign-in expired.");
    setItems(body.conversations);
    if(body.conversations.length)await select(body.conversations[0].id);else await create();
   }catch{if(active){setMessages(welcome);setError("History unavailable. Reload and sign in to retry.");}}
  }
  const visibility=()=>{
   if(document.hidden){lifetime.value++;setMessages(welcome);setReady(false);}
   else void initialize();
  };
  document.addEventListener("visibilitychange",visibility);
  void initialize();
  return()=>{active=false;lifetime.value++;selected.current=null;document.removeEventListener("visibilitychange",visibility);};
 },[userId,select,create,welcome,setMessages,clearScope]);
 return{messages,setMessages,items,conversationId,ready,error,hasMore,clearScope,
  select,create,older:async()=>{if(conversationId&&cursor)await load(conversationId,cursor);},
  latest:async()=>{if(conversationId)await load(conversationId);}};
}
