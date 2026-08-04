import { NextResponse } from "next/server";
import { getCustomer360Service } from "@/lib/platform/customer360-factory";
import { logUnauthenticatedAction } from "@/lib/platform/audit-log";
import { authorize } from "@/lib/platform/session-guard";

export async function GET(request:Request) {
  const guard=await authorize(request,"customer.read");
  if(!guard.allowed)return NextResponse.json({error:guard.error},{status:guard.status});
  const service=getCustomer360Service();
  const url=new URL(request.url); const id=url.searchParams.get("id");
  if(id){try{const customer=await service.get(id);await logUnauthenticatedAction({action:"customer360.view",entity:`customer:${id}`,result:customer?"success":"not_found",reason:"Consulta de Customer 360",actor:guard.user});return customer?NextResponse.json(customer):NextResponse.json({error:"Cliente não encontrado"},{status:404});}catch(error){const forbidden=error instanceof Error&&error.name==="IxcCustomerNotAllowedError";await logUnauthenticatedAction({action:"customer360.view",entity:`customer:${id}`,result:forbidden?"blocked":"failed",reason:"Consulta de Customer 360",actor:guard.user});return NextResponse.json({error:forbidden?"Cadastro não autorizado":"Fonte IXC temporariamente indisponível"},{status:forbidden?403:503});}}
  try{return NextResponse.json(await service.list(url.searchParams.get("q")??"",url.searchParams.get("risk")??"all",Number(url.searchParams.get("page")??1),10));}
  catch{return NextResponse.json({error:"Fonte de clientes indisponível"},{status:503});}
}

export async function POST(request:Request){const guard=await authorize(request,"support.write");if(!guard.allowed)return NextResponse.json({error:guard.error},{status:guard.status});const service=getCustomer360Service();const body=await request.json() as {id?:string;action?:string};if(body.action!=="refresh"||!body.id)return NextResponse.json({error:"Solicitação inválida"},{status:400});try{const result=await service.refresh(body.id);await logUnauthenticatedAction({action:"customer360.refresh",entity:`customer:${body.id}`,result:"success",reason:"Atualização forçada do Customer 360",actor:guard.user});return NextResponse.json(result);}catch(error){const forbidden=error instanceof Error&&error.name==="IxcCustomerNotAllowedError";await logUnauthenticatedAction({action:"customer360.refresh",entity:`customer:${body.id}`,result:forbidden?"blocked":"failed",reason:"Atualização forçada do Customer 360",actor:guard.user});return NextResponse.json({error:forbidden?"Cadastro não autorizado":"Atualização IXC indisponível"},{status:forbidden?403:503});}}
