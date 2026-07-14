import { NextResponse } from "next/server";
import { getIxcRuntime } from "@/lib/integrations/ixc/runtime";
import { D1SmokeRepository } from "@/lib/platform/d1-smoke-repository";
import { IxcReadonlySmokeRunner } from "@/lib/platform/ixc-smoke";

export async function POST(request:Request){const {config,provider}=getIxcRuntime();if(!provider)return NextResponse.json({error:"IXC staging-readonly não está pronto"},{status:409});if(!config.stagingJobSecret||request.headers.get("x-staging-job-secret")!==config.stagingJobSecret)return NextResponse.json({error:"Não autorizado"},{status:401});const body=await request.json() as {customerId?:string};if(!body.customerId)return NextResponse.json({error:"Cadastro autorizado obrigatório"},{status:400});try{return NextResponse.json(await new IxcReadonlySmokeRunner(provider,new D1SmokeRepository()).run(body.customerId));}catch(error){const forbidden=error instanceof Error&&error.name==="IxcCustomerNotAllowedError";return NextResponse.json({error:forbidden?"Cadastro fora da allowlist":"Smoke test falhou de forma segura"},{status:forbidden?403:503});}}
