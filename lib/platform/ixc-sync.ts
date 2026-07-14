import type { IxcReadonlyProvider } from "../integrations/ixc/readonly-provider.ts";

export interface SyncRecord { id:string;subjectId:string;status:"processing"|"completed"|"failed"|"dlq";attempts:number;correlationId:string;errorCode?:string;at:string }
export interface SyncRepository { create(record:SyncRecord):Promise<boolean>; update(record:SyncRecord):Promise<void>; checkpoint(subjectId:string,status:string,correlationId:string):Promise<void>; audit(subjectId:string,result:string,correlationId:string):Promise<void> }

export class IxcSyncCoordinator {
  private readonly provider:IxcReadonlyProvider;private readonly repository:SyncRepository;
  constructor(provider:IxcReadonlyProvider,repository:SyncRepository){this.provider=provider;this.repository=repository;}
  async run(subjectId:string,correlationId=crypto.randomUUID()){
    const record:SyncRecord={id:crypto.randomUUID(),subjectId,status:"processing",attempts:1,correlationId,at:new Date().toISOString()};
    if(!await this.repository.create(record))return{status:"deduplicated" as const,correlationId};
    try{const snapshot=await this.provider.getSnapshot(subjectId,correlationId,true);record.status="completed";await this.repository.update(record);await this.repository.checkpoint(subjectId,"completed",correlationId);await this.repository.audit(subjectId,"success",correlationId);return{status:"completed" as const,correlationId,partial:snapshot.partialSources};}
    catch(error){record.attempts=2;record.status="dlq";record.errorCode=error instanceof Error?error.name:"unknown";await this.repository.update(record);await this.repository.checkpoint(subjectId,"failed",correlationId);await this.repository.audit(subjectId,"failed",correlationId);return{status:"dlq" as const,correlationId,errorCode:record.errorCode};}
  }
}

export class MemorySyncRepository implements SyncRepository {
  readonly jobs:SyncRecord[]=[];readonly checkpoints=new Map<string,string>();readonly audits:string[]=[];
  async create(record:SyncRecord){if(this.jobs.some((item)=>item.subjectId===record.subjectId&&item.status==="processing"))return false;this.jobs.push({...record});return true;}
  async update(record:SyncRecord){const index=this.jobs.findIndex((item)=>item.id===record.id);if(index>=0)this.jobs[index]={...record};}
  async checkpoint(subjectId:string,status:string){this.checkpoints.set(subjectId,status);}
  async audit(subjectId:string,result:string,correlationId:string){this.audits.push(`${subjectId}:${result}:${correlationId}`);}
}
