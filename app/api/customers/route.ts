import { NextResponse } from "next/server";
import { getCustomer360Service } from "@/lib/platform/customer360-factory";

export async function GET(request:Request) {
  const service=getCustomer360Service();
  const url=new URL(request.url); const id=url.searchParams.get("id");
  if(id){try{const customer=await service.get(id);return customer?NextResponse.json(customer):NextResponse.json({error:"Cliente não encontrado"},{status:404});}catch(error){const forbidden=error instanceof Error&&error.name==="IxcCustomerNotAllowedError";return NextResponse.json({error:forbidden?"Cadastro não autorizado":"Fonte IXC temporariamente indisponível"},{status:forbidden?403:503});}}
  return NextResponse.json(service.list(url.searchParams.get("q")??"",url.searchParams.get("risk")??"all",Number(url.searchParams.get("page")??1),10));
}

export async function POST(request:Request){const service=getCustomer360Service();const body=await request.json() as {id?:string;action?:string};if(body.action!=="refresh"||!body.id)return NextResponse.json({error:"Solicitação inválida"},{status:400});try{return NextResponse.json(await service.refresh(body.id));}catch(error){const forbidden=error instanceof Error&&error.name==="IxcCustomerNotAllowedError";return NextResponse.json({error:forbidden?"Cadastro não autorizado":"Atualização IXC indisponível"},{status:forbidden?403:503});}}
