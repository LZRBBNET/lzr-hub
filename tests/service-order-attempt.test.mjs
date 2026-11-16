import test from "node:test";
import assert from "node:assert/strict";
import {rememberServiceOrderAttempt,releaseServiceOrderAttempt,OS_ATTEMPT_STORAGE_KEY} from "../lib/platform/service-order-attempt.ts";
const storage=()=>{const values=new Map();return {values,getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)}};
test("reload/lost response reuses only the opaque key; unknown cannot clear it",()=>{
 const disk=storage();
 const first=rememberServiceOrderAttempt(disk,()=>"original");
 assert.equal(rememberServiceOrderAttempt(disk,()=>"after-reload"),first);
 assert.deepEqual([...disk.values.entries()],[[OS_ATTEMPT_STORAGE_KEY,"os-original"]]);
 for(const state of ["unknown","pending","failed"]){assert.equal(releaseServiceOrderAttempt(disk,state,first),false);assert.equal(disk.getItem(OS_ATTEMPT_STORAGE_KEY),first)}
 assert.equal(releaseServiceOrderAttempt(disk,"success",first),true);
 assert.equal(rememberServiceOrderAttempt(disk,()=>"next"),"os-next");
});
test("storage failure prevents preparing a send",()=>{
 assert.throws(()=>rememberServiceOrderAttempt({getItem:()=>null,setItem:()=>{throw Error("denied")}},()=>"key"));
});

test("old tab cannot clear a newer attempt after reload",()=>{
 const disk=storage();const old=rememberServiceOrderAttempt(disk,()=>"old");
 releaseServiceOrderAttempt(disk,"success",old);
 const current=rememberServiceOrderAttempt(disk,()=>"new");
 assert.equal(releaseServiceOrderAttempt(disk,"success",old),false);
 assert.equal(disk.getItem(OS_ATTEMPT_STORAGE_KEY),current);
});
test("replacement between storage read and completion cannot erase new attempt",()=>{
 const disk=storage();const old=rememberServiceOrderAttempt(disk,()=>"old");
 const racing={...disk,getItem:k=>{const value=disk.getItem(k);if(k===OS_ATTEMPT_STORAGE_KEY)disk.setItem(k,"os-new");return value}};
 releaseServiceOrderAttempt(racing,"success",old);
 assert.equal(rememberServiceOrderAttempt(disk,()=>"wrong"),"os-new");
});
