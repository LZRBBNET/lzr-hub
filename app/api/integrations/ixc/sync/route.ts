import { NextResponse } from "next/server";
import { getIxcRuntime } from "@/lib/integrations/ixc/runtime";
import { D1SyncRepository } from "@/lib/platform/d1-sync-repository";
import { IxcSyncCoordinator } from "@/lib/platform/ixc-sync";

export async function POST(request:Request){const {config,provider}=getIxcRuntime();if(!provider)return NextResponse.json({error:"IXC readonly desativado"},{status:409});if(!config.stagingJobSecret||request.headers.get("x-staging-job-secret")!==config.stagingJobSecret)return NextResponse.json({error:"Não autorizado"},{status:401});const body=await request.json() as {customerId?:string;scheduled?:boolean};if(body.scheduled&&!config.scheduledSyncEnabled)return NextResponse.json({error:"Agendamento desativado"},{status:409});const ids=body.customerId?[body.customerId]:body.scheduled?config.ixcAllowlist:[];if(ids.length===0)return NextResponse.json({error:"Informe cadastro autorizado"},{status:400});const coordinator=new IxcSyncCoordinator(provider,new D1SyncRepository());const results=[];for(const id of ids)results.push(await coordinator.run(id));return NextResponse.json({mode:"staging-readonly",count:results.length,results});}
