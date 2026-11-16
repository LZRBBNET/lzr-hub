import test from "node:test";
import assert from "node:assert/strict";
import {rememberServiceOrderAttempt,releaseServiceOrderAttempt,OS_ATTEMPT_STORAGE_KEY} from "../lib/platform/service-order-attempt.ts";
const storage=()=>{const values=new Map();return {values,getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)}};
test("reload/lost response reuses only the opaque key; unknown cannot clear it",()=>{
 const disk=storage();
 const first=rememberServiceOrderAttempt(disk,()=>"original");
 assert.equal(rememberServiceOrderAttempt(disk,()=>"after-reload"),first);
 assert.deepEqual([...disk.values.entries()],[[OS_ATTEMPT_STORAGE_KEY,"os-original"]]);
 for(const state of ["unknown","pending","failed"]){assert.equal(releaseServiceOrderAttempt(disk,state),false);assert.equal(disk.getItem(OS_ATTEMPT_STORAGE_KEY),first)}
 assert.equal(releaseServiceOrderAttempt(disk,"success"),true);
 assert.equal(rememberServiceOrderAttempt(disk,()=>"next"),"os-next");
});
test("storage failure prevents preparing a send",()=>{
 assert.throws(()=>rememberServiceOrderAttempt({getItem:()=>null,setItem:()=>{throw Error("denied")}},()=>"key"));
});
