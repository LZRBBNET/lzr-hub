import { knowledgeDocuments as seed } from "./demo-data.ts";
import type { KnowledgeDocument } from "./types.ts";
let documents=[...seed];
const normalize=(text:string)=>text.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase();
const stopTerms=new Set(["ainda","algum","alguma","como","com","das","dos","ela","ele","essa","esse","esta","este","isso","mais","mas","nao","não","numa","para","pela","pelo","por","que","real","sem","ser","uma"]);

const contentByDocumentId:Record<string,string>={
  "KB-001":"Quando a ONU estiver online e a sessão PPPoE estiver offline, confirme se existe massiva na região. Sem massiva, oriente um único reinício elétrico do roteador por 20 segundos. Se o cliente já reiniciou e a sessão não voltou, não repita a etapa: encaminhe o diagnóstico para o suporte técnico.",
  "KB-002":"O desbloqueio em confiança exige a identificação do contrato, a confirmação da política vigente e revisão do financeiro. Nunca confirme desbloqueio sem comprovante do sistema e não execute a ação por um canal de demonstração.",
  "KB-003":"Para planos acima de 400 Mega, priorize 5 GHz perto do roteador e teste via cabo antes de atribuir lentidão ao link. Este documento ainda está em revisão e não pode fundamentar respostas operacionais.",
};

export interface KnowledgeSource {
  id:string;
  title:string;
  version:number;
  excerpt:string;
}

function endOfValidity(value:string):Date|undefined {
  const match=/^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if(!match)return undefined;
  const [,day,month,year]=match;
  const parsed=new Date(`${year}-${month}-${day}T23:59:59.999Z`);
  return Number.isNaN(parsed.getTime())?undefined:parsed;
}

function excerptFor(content:string,terms:string[]) {
  const sentences=content.split(/(?<=[.!?])\s+/).filter(Boolean);
  const ranked=sentences.map((sentence,index)=>({
    sentence,
    index,
    hits:terms.filter((term)=>normalize(sentence).includes(term)).length,
  })).sort((a,b)=>b.hits-a.hits||a.index-b.index);
  return (ranked[0]?.sentence??content).slice(0,360);
}

export class KnowledgeService {
  list(){return documents}
  ingest(title:string,category:string){const document:KnowledgeDocument={id:`KB-${Date.now()}`,title,category,status:"draft",version:1,city:"Todas",plan:"Todos",equipment:"—",validUntil:"31/12/2026",chunks:Math.max(1,Math.ceil(title.length/12)),updatedAt:"agora"};documents=[document,...documents];return document}
  publish(id:string){documents=documents.map(d=>d.id===id?{...d,status:"published",version:d.version+1,updatedAt:"agora"}:d);return documents.find(d=>d.id===id)}
  searchPublished(query:string,now=new Date()):KnowledgeSource[]{
    const terms=normalize(query).split(/[^a-z0-9]+/).filter((term)=>term.length>2&&!stopTerms.has(term));
    return documents
      .filter((document)=>document.status==="published")
      .filter((document)=>{
        const validUntil=endOfValidity(document.validUntil);
        return Boolean(validUntil&&validUntil.getTime()>=now.getTime());
      })
      .map((document)=>{
        const content=contentByDocumentId[document.id]??"";
        const searchable=normalize(`${document.title} ${document.category} ${document.equipment} ${content}`);
        const hits=terms.filter((term)=>searchable.includes(term)).length;
        return {document,content,hits,score:hits/Math.max(1,terms.length)};
      })
      .filter((result)=>result.content.length>0&&(result.hits>=3||result.score>=0.12))
      .sort((a,b)=>b.score-a.score||b.hits-a.hits)
      .slice(0,3)
      .map(({document,content})=>({
        id:document.id,
        title:document.title,
        version:document.version,
        excerpt:excerptFor(content,terms),
      }));
  }
  search(query:string){
    const terms=normalize(query).split(/\s+/).filter((term)=>term.length>2);
    return documents
      .filter((document)=>document.status==="published")
      .map((document)=>({
        document,
        score:terms.filter((term)=>normalize(`${document.title} ${document.category} ${document.equipment}`).includes(term)).length/Math.max(1,terms.length),
        evidence:`Fonte interna: ${document.title} • versão ${document.version}`,
      }))
      .filter((result)=>result.score>0)
      .sort((a,b)=>b.score-a.score);
  }
}
