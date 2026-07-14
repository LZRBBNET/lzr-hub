import { NextResponse } from "next/server";
import { loadRuntimeConfig } from "@/lib/runtime/environment";
import { D1PilotRepository } from "@/lib/platform/d1-pilot-repository";
import { PilotService,type PilotInput } from "@/lib/platform/pilot-service";

function service(request:Request){const config=loadRuntimeConfig();if(config.pilotMode!=="internal")throw new Error("PILOT_DISABLED");if(!config.stagingJobSecret||request.headers.get("x-staging-job-secret")!==config.stagingJobSecret)throw new Error("PILOT_UNAUTHORIZED");const userId=request.headers.get("x-pilot-user-id")??"";return{instance:new PilotService(new D1PilotRepository(),config.pilotAllowedUserIds),userId};}
export async function GET(request:Request){try{const {instance,userId}=service(request);instance.alias(userId);return NextResponse.json({status:"internal",participants:"2-3",summary:await instance.summary()});}catch(error){return failure(error);}}
export async function POST(request:Request){try{const {instance,userId}=service(request);const event=await instance.record(userId,await request.json() as PilotInput);return NextResponse.json({id:event.id,status:event.status??"open",participant:event.participantAlias,correlationId:event.correlationId},{status:201});}catch(error){return failure(error);}}
function failure(error:unknown){const message=error instanceof Error?error.message:"PILOT_ERROR";const status=message==="PILOT_DISABLED"?409:message==="PILOT_UNAUTHORIZED"||message==="PILOT_USER_NOT_ALLOWED"?401:400;return NextResponse.json({error:message},{status});}
