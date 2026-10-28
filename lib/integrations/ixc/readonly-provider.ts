import { IxcConnectionMapper, IxcContractMapper, IxcCustomerMapper, IxcInvoiceMapper, IxcPaymentMapper, IxcPlanMapper, IxcServiceOrderMapper } from "./mappers.ts";
import { sanitizeTelemetry } from "./masking.ts";
import { ReadonlyIxcGuard } from "./guard.ts";
import { CircuitBreaker, SlidingWindowRateLimiter, TtlCache } from "./resilience.ts";
import type { IxcCityDto, IxcCollectionWalletDto, IxcCustomerDto, IxcCustomerPage, IxcCustomerSnapshot, IxcListResponse, IxcOsSubjectDto, IxcPaymentTermDto, IxcReadOperation, IxcSectorDto, IxcServiceDiagnosisData, IxcSnapshotCoverage, IxcUfDto } from "./types.ts";

// `listOsCatalog` fica de fora porque não tem um endpoint só: a mesma operação
// lê `su_oss_assunto` e `empresa_setor`, e o recurso vai explícito na chamada.
const endpoints:Record<Exclude<IxcReadOperation,"testConnection"|"findCustomer"|"getCustomer"|"listCustomers"|"listOsCatalog"|"listFinanceCatalog">,string>={listContracts:"cliente_contrato",getPlan:"vd_contratos",listInvoices:"fn_areceber",listPayments:"fn_movim_finan",listServiceOrders:"su_oss_chamado",getConnection:"radusuarios",getCity:"cidade",getRecordHistory:"ixc_logs"};
export interface IxcTrace { event:string; correlationId:string; durationMs:number; status:"success"|"failed"|"cache-hit"|"blocked"; attributes:Record<string,unknown> }
export interface IxcReadonlyOptions { baseUrl:string; token:string; allowedCustomerIds:string[]; fullBase?:boolean; timeoutMs?:number; retryLimit?:0|1; cacheTtlMs?:number; cityCacheTtlMs?:number; rateLimitPerMinute?:number; fetcher?:typeof fetch; trace?:(event:IxcTrace)=>void; now?:()=>number }
interface ReadOptions { strictPage?:boolean; strictFinancialPage?:boolean; oper?:string; page?:number; sortname?:string; sortorder?:"asc"|"desc"; gridParam?:GridFilter[] }
/**
 * Filtro composto do IXC. O trio qtype/query/oper só aceita uma condição; para
 * combinar (ex.: em aberto **e** vencida) o webservice usa `grid_param`.
 * O filtro de vencimento deve reduzir o conjunto de faturas abertas;
 * testes verificam a combinação para não apresentar faturas futuras como vencidas.
 */
export interface GridFilter { TB:string; OP:string; P:string }
/**
 * Operações que não são de um cliente específico — não passam pela checagem de
 * allowlist. `getCity` está aqui porque cidade e UF são **tabela de consulta**,
 * não dado de ninguém: a allowlist protege cadastro de cliente, e checá-la
 * contra um código de cidade nunca fez sentido.
 */
const GLOBAL_SCOPE_OPERATIONS = new Set<IxcReadOperation>(["testConnection","listCustomers","listOsCatalog","listFinanceCatalog","getCity"]);

/**
 * Traduz o que a pessoa digitou na busca para o filtro do IXC.
 *
 * Termo vazio lista a base (`id > 0`, que é como o IXC devolve tudo). Só dígitos
 * com 11 ou 14 posições é CPF/CNPJ; dígitos curtos são id; o resto é nome.
 * A busca por nome usa o operador `L` (LIKE) — confirmado por
 * `scripts/ixc-probe-listing.mjs` antes de a base inteira ser liberada.
 */
export function customerQuery(term:string){
  const value=term.trim();
  if(!value)return{qtype:"cliente.id",query:"0",oper:">"};
  const digits=value.replace(/\D/g,"");
  if(digits.length===11||digits.length===14)return{qtype:"cliente.cnpj_cpf",query:digits,oper:"="};
  if(/^\d+$/.test(value))return{qtype:"cliente.id",query:value,oper:"="};
  return{qtype:"cliente.razao",query:value,oper:"L"};
}

/**
 * Formata um número do WhatsApp como o IXC o guarda.
 *
 * Exemplo sintético, com DDD00 inválido: `5500000910001` vira `(00) 00091-0001`. Buscar por
 * dígitos puros devolve **zero em silêncio** — foi o que fez isso parecer
 * impossível por muito tempo (`scripts/ixc-probe-phone-lookup.mjs`).
 *
 * O 55 do país é descartado quando presente. Sem 10 ou 11 dígitos úteis não há
 * formato conhecido, e devolver `undefined` é melhor que tentar um palpite.
 */
export function ixcPhoneFormat(raw:string):string|undefined{
  let digits=raw.replace(/\D/g,"");
  if(digits.length>11&&digits.startsWith("55"))digits=digits.slice(2);
  if(digits.length===11)return `(${digits.slice(0,2)}) ${digits.slice(2,7)}-${digits.slice(7)}`;
  if(digits.length===10)return `(${digits.slice(0,2)}) ${digits.slice(2,6)}-${digits.slice(6)}`;
  return undefined;
}

/**
 * Os formatos em que o mesmo celular pode estar gravado, por causa do **nono
 * dígito**.
 *
 * Exemplo inteiramente sintético com DDD00 inválido: `550080000001` tem
 * DDD mais **oito** dígitos; a variante `5500980000001` inclui o nono dígito.
 * Os dois formatos podem coexistir no canal. Se o cliente escrever
 * pelo formato curto e o IXC tiver o longo, a busca não acha e um cliente antigo
 * vira lead — o erro que a regra de "exatamente um ou nada" existe para evitar,
 * entrando por outra porta.
 *
 * Fixo não ganha nono dígito: só celular, que começa com 6 a 9 depois do DDD.
 */
/**
 * Onde procurar o telefone, em ordem de tentativa.
 * Primeiro celular e WhatsApp; fone e telefone comercial são alternativas
 * consultadas somente se a primeira tentativa não identificar um cadastro.
 * Cada campo adicional custa uma consulta ao ERP por mensagem recebida.
 * A busca usa formato com máscara: dígitos puros podem não corresponder
 * ao formato armazenado. Os exemplos deste arquivo são sintéticos.
 */
const PHONE_FIELD_TIERS = [["telefone_celular","whatsapp"],["fone","telefone_comercial"]] as const;

export function phoneCandidates(raw:string):string[]{
  let digits=raw.replace(/\D/g,"");
  if(digits.length>11&&digits.startsWith("55"))digits=digits.slice(2);
  const variants=new Set<string>([digits]);
  if(digits.length===10&&/^[6-9]/.test(digits.slice(2))){
    variants.add(`${digits.slice(0,2)}9${digits.slice(2)}`);
  }
  if(digits.length===11&&digits[2]==="9"){
    variants.add(`${digits.slice(0,2)}${digits.slice(3)}`);
  }
  return [...variants].map(ixcPhoneFormat).filter((value):value is string=>!!value);
}

export class IxcReadonlyError extends Error {
  readonly code:string;
  constructor(code:string){super(code);this.name="IxcReadonlyError";this.code=code;}
}

function classifyError(error:unknown){
  if(error instanceof IxcReadonlyError)return error;
  if(error instanceof DOMException&&error.name==="AbortError")return new IxcReadonlyError("IXC_TIMEOUT");
  const message=error instanceof Error?error.message:"";
  if(/^IXC_HTTP_\d{3}$/.test(message))return new IxcReadonlyError(message);
  return new IxcReadonlyError("IXC_NETWORK_ERROR");
}

function apiError(body:IxcListResponse){
  const value=body as IxcListResponse&{type?:unknown;message?:unknown};
  if(value.type!=="error")return undefined;
  const message=String(value.message??"").toLocaleLowerCase("pt-BR");
  if(message.includes("ip")&&(message.includes("liberad")||message.includes("permitid")))return new IxcReadonlyError("IXC_IP_NOT_ALLOWED");
  if(message.includes("token")||message.includes("autentica")||message.includes("login"))return new IxcReadonlyError("IXC_AUTHENTICATION_FAILED");
  if(message.includes("permiss"))return new IxcReadonlyError("IXC_PERMISSION_DENIED");
  return new IxcReadonlyError("IXC_API_ERROR");
}

export function basicCredential(token:string){
  const value=token.trim();
  return /^\d+:[A-Fa-f0-9]{32,}$/.test(value)?btoa(value):value;
}

export class IxcReadonlyProvider {
  readonly mode="staging-readonly" as const;
  private readonly guard:ReadonlyIxcGuard; private readonly fetcher:typeof fetch; private readonly timeoutMs:number; private readonly cache:TtlCache<IxcCustomerSnapshot>; private readonly cityCache:TtlCache<string>; private readonly planCache:TtlCache<{name:string;value?:number}>; private readonly breaker:CircuitBreaker; private readonly limiter:SlidingWindowRateLimiter; private readonly now:()=>number; private readonly options:IxcReadonlyOptions;private readonly durations=new Map<string,Record<string,number>>();
  constructor(options:IxcReadonlyOptions){this.options=options;this.guard=new ReadonlyIxcGuard(options.allowedCustomerIds,options.fullBase??false);this.fetcher=options.fetcher??fetch;this.timeoutMs=options.timeoutMs??3500;this.now=options.now??(()=>Date.now());this.cache=new TtlCache<IxcCustomerSnapshot>(options.cacheTtlMs??300000,this.now);this.cityCache=new TtlCache<string>(options.cityCacheTtlMs??86400000,this.now);this.planCache=new TtlCache<{name:string;value?:number}>(options.cityCacheTtlMs??86400000,this.now);this.breaker=new CircuitBreaker(3,30000,this.now);this.limiter=new SlidingWindowRateLimiter(options.rateLimitPerMinute??30,60000,this.now);}
  async testConnection(correlationId:string){await this.read("testConnection","cliente","id","0",correlationId,1);return true;}
  /**
   * Página da base de clientes. Existe para a lista de Clientes não precisar do
   * snapshot completo (7 consultas por cadastro) só para montar uma linha da
   * tabela — o snapshot continua sendo buscado quando alguém abre o cliente.
   *
   * Só funciona com a base liberada (`FEATURE_IXC_FULL_BASE`); com allowlist a
   * lista continua sendo os cadastros autorizados.
   */
  async listCustomers(term:string,page:number,pageSize:number,correlationId:string):Promise<IxcCustomerPage>{
    const filter=customerQuery(term);
    const size=Math.min(Math.max(pageSize,1),100);
    const {records,total}=await this.readPage("listCustomers","cliente",filter.qtype,filter.query,correlationId,size,"",{oper:filter.oper,page:Math.max(page,1),sortname:"cliente.id"});
    const items=records.map(IxcCustomerMapper.map);
    // A cidade vem como código numérico; resolve os códigos distintos da página
    // (cache de 24h) em vez de uma consulta por linha.
    const codes=[...new Set(records.map((raw)=>String(raw.cidade??"").trim()).filter(Boolean))];
    const names=new Map<string,string>();
    await Promise.all(codes.map(async(code)=>{const name=await this.resolveCityName(code,correlationId,"");if(name)names.set(code,name);}));
    return{items:items.map((item,index)=>{const code=String(records[index].cidade??"").trim();const name=names.get(code);return name?{...item,city:name}:item;}),total,page:Math.max(page,1),pageSize:size};
  }
  /**
   * Faturas em aberto e já vencidas de toda a base, para a Cobrança.
   * O IXC informa contagem, não soma: o valor depende da leitura dos registros.
   * Varre somente as vencidas, em páginas limitadas, para não percorrer também
   * faturas futuras. `truncated` sinaliza o teto: recorte incompleto não pode
   * ser apresentado como saldo total da carteira.
   */
  async listOverdueInvoices(todayIso:string,correlationId:string,maxPages=12,pageSize=500){
    const filters:GridFilter[]=[{TB:"fn_areceber.status",OP:"=",P:"A"},{TB:"fn_areceber.data_vencimento",OP:"<",P:todayIso.slice(0,10)}];
    const rows:Record<string,unknown>[]=[];const seen=new Set<string>();let total=0;let page=1;
    for(;page<=maxPages;page+=1){
      const result=await this.readPage("listInvoices",endpoints.listInvoices,"fn_areceber.status","A",correlationId,pageSize,"",{oper:"=",page,sortname:"fn_areceber.data_vencimento",gridParam:filters,strictFinancialPage:true});
      // A changing count or repeated page cannot prove a complete financial scan.
      if(page>1&&result.total!==total)throw new IxcReadonlyError("IXC_INCOMPLETE_FINANCIAL_RESPONSE");
      for(const row of result.records){const id=String(row.id).trim();if(seen.has(id))throw new IxcReadonlyError("IXC_INCOMPLETE_FINANCIAL_RESPONSE");seen.add(id);}
      total=result.total;rows.push(...result.records);
      if(result.records.length<pageSize||rows.length>=total)break;
    }
    return{rows,total,truncated:rows.length<total};
  }
  /**
   * Fila paginada de ordens de serviço ainda não fechadas.
   * Cada página é uma consulta; `total` informa a contagem do filtro.
   * A OS traz `id_cliente` e endereço, mas não o nome: buscá-lo linha a linha
   * acrescentaria uma consulta por item, então a tela usa o código informado.
   */
  async listOpenServiceOrders(page:number,pageSize:number,correlationId:string){
    const size=Math.min(Math.max(pageSize,1),100);
    const {records,total}=await this.readPage("listServiceOrders",endpoints.listServiceOrders,"su_oss_chamado.status","F",correlationId,size,"",{oper:"!=",page:Math.max(page,1),sortname:"su_oss_chamado.data_abertura",sortorder:"desc"});
    return{items:records.map(IxcServiceOrderMapper.map),total,page:Math.max(page,1),pageSize:size};
  }
  /**
   * Assuntos e setores de OS são configuração do provedor, não constantes.
   * Consulte `id_assunto` e `setor` do catálogo para não abrir chamado na fila
   * errada. O catálogo tem cache longo e é lido ao abrir a tela.
   */
  async listOsSubjects(correlationId:string):Promise<IxcOsSubjectDto[]>{
    const {records}=await this.readPage("listOsCatalog","su_oss_assunto","su_oss_assunto.id","0",correlationId,200,"",{oper:">",sortname:"su_oss_assunto.id"});
    return records.map((raw)=>({id:String(raw.id??"").trim(),name:String(raw.assunto??"").trim()})).filter((item)=>item.id&&item.name);
  }
  async listSectors(correlationId:string):Promise<IxcSectorDto[]>{
    const {records}=await this.readPage("listOsCatalog","empresa_setor","empresa_setor.id","0",correlationId,100,"",{oper:">",sortname:"empresa_setor.id"});
    return records.map((raw)=>({id:String(raw.id??"").trim(),name:String(raw.setor??"").trim()})).filter((item)=>item.id&&item.name);
  }
  /**
   * Descobre se um número de telefone pertence a algum cadastro.
   *
   * É o que separa "cliente escrevendo" de "gente nova querendo comprar" — sem
   * isso, todo contato do WhatsApp viraria lead, inclusive o de quem já é
   * cliente há cinco anos.
   *
   * ⚠️ **Exatamente um resultado, ou nada.** Buscar pelo final do número
   * pode retornar vários cadastros, mesmo em uma base sintética. Com zero ou vários, a
   * resposta é "não identificado" — identificar o cliente errado é pior que não
   * identificar, porque a partir daí tudo que o sistema fizer será sobre outra
   * pessoa.
   *
   * A busca é pelo formato **mascarado**, e por dois campos: o celular e o
   * WhatsApp do cadastro.
   */
  async findCustomerByPhone(phone:string,correlationId:string):Promise<IxcCustomerDto|undefined>{
    const candidates=phoneCandidates(phone);
    if(candidates.length===0)return undefined;
    for(const fields of PHONE_FIELD_TIERS){
      // Junta o que cada formato achou antes de decidir. Devolver o primeiro
      // acerto faria a resposta depender da ordem da busca — e se dois formatos
      // do mesmo número apontarem para cadastros diferentes, alguém digitou
      // errado num deles, e escolher um seria escolher no escuro.
      const found=new Map<string,IxcCustomerDto>();
      for(const masked of candidates){
        for(const field of fields){
          // Operação `listCustomers` porque é o que isto é: uma listagem da base
          // filtrada por telefone. Buscar por número não tem cadastro conhecido de
          // antemão para checar contra a allowlist — depende da base liberada.
          // rp=2 de propósito: só precisamos saber se é um ou mais de um.
          const {records}=await this.readPage("listCustomers","cliente",`cliente.${field}`,masked,correlationId,2,"",{oper:"=",sortname:"cliente.id"});
          if(records.length>1)return undefined;
          if(records.length===1){
            const customer=IxcCustomerMapper.map(records[0]);
            found.set(customer.id,customer);
          }
        }
      }
      if(found.size===1)return [...found.values()][0];
      // Achou mais de um cadastro distinto: é ambíguo, e o próximo campo não
      // desempata — só acrescentaria mais um palpite.
      if(found.size>1)return undefined;
    }
    return undefined;
  }
  /**
   * UFs e cidades do IXC, para cadastrar cliente.
   *
   * ⚠️ O cadastro guarda o **código interno do IXC** em `cidade` e `uf`, não o
   * nome nem o código do IBGE — exemplo inteiramente sintético: cliente910001,
   * `cidade: "990001"` e `uf: "990002"`. Digitar "Cidade Sintética" cria cliente sem cidade
   * válida, e ninguém percebe até a primeira cobrança.
   */
  async listUfs(correlationId:string):Promise<IxcUfDto[]>{
    const {records}=await this.readPage("getCity","uf","uf.id","0",correlationId,40,"",{oper:">",sortname:"uf.nome"});
    return records.map((raw)=>({id:String(raw.id??"").trim(),name:String(raw.nome??"").trim(),initials:String(raw.sigla??"").trim()})).filter((item)=>item.id&&item.name);
  }
  async listCities(ufId:string,correlationId:string):Promise<IxcCityDto[]>{
    const {records}=await this.readPage("getCity","cidade","cidade.uf",ufId,correlationId,600,"",{oper:"=",sortname:"cidade.nome"});
    return records.map((raw)=>({id:String(raw.id??"").trim(),name:String(raw.nome??"").trim()})).filter((item)=>item.id&&item.name);
  }
  /**
   * Existe cadastro com este CPF/CNPJ? É a checagem que impede duplicata.
   *
   * Duplicar cliente no ERP não é um registro a mais: é dois fluxos de fatura,
   * duas cobranças e um contrato órfão que ninguém sabe qual é o bom.
   */
  async findCustomerByDocument(document:string,correlationId:string):Promise<IxcCustomerDto|undefined>{
    const digits=document.replace(/\D/g,"");
    if(digits.length!==11&&digits.length!==14)return undefined;
    // O IXC guarda o documento **com máscara**, como o telefone. Consultar os
    // dois formatos evita o falso "não existe" que autorizaria a duplicata.
    const masked=digits.length===11
      ? `${digits.slice(0,3)}.${digits.slice(3,6)}.${digits.slice(6,9)}-${digits.slice(9)}`
      : `${digits.slice(0,2)}.${digits.slice(2,5)}.${digits.slice(5,8)}/${digits.slice(8,12)}-${digits.slice(12)}`;
    for(const value of [masked,digits]){
      const {records}=await this.readPage("listCustomers","cliente","cliente.cnpj_cpf",value,correlationId,1,"",{oper:"=",sortname:"cliente.id"});
      if(records[0])return IxcCustomerMapper.map(records[0]);
    }
    return undefined;
  }
  /**
   * Carteiras e condições de pagamento vêm do catálogo do provedor.
   * A carteira define juros/multa e a condição define o parcelamento.
   * Fixar essas opções no código poderia alterar indevidamente o valor devido.
   */
  async listCollectionWallets(correlationId:string):Promise<IxcCollectionWalletDto[]>{
    const {records}=await this.readPage("listFinanceCatalog","fn_carteira_cobranca","fn_carteira_cobranca.id","0",correlationId,100,"",{oper:">",sortname:"fn_carteira_cobranca.id"});
    return records.map((raw)=>({id:String(raw.id??"").trim(),name:String(raw.descricao??raw.titulo??"").trim()})).filter((item)=>item.id&&item.name);
  }
  async listPaymentTerms(correlationId:string):Promise<IxcPaymentTermDto[]>{
    const {records}=await this.readPage("listFinanceCatalog","condicoes_pagamento","condicoes_pagamento.id","0",correlationId,200,"",{oper:">",sortname:"condicoes_pagamento.id"});
    return records
      // Condição desativada no IXC não deve aparecer para escolha: ela foi
      // desligada por alguém, e oferecer de volta desfaz essa decisão.
      .filter((raw)=>String(raw.ativo??"S").trim().toUpperCase()!=="N")
      .map((raw)=>{const installments=Number(String(raw.n_parcelas??"").trim());return{id:String(raw.id??"").trim(),name:String(raw.nome??"").trim(),installments:Number.isFinite(installments)&&installments>0?installments:undefined}})
      .filter((item)=>item.id&&item.name);
  }
  /**
   * Contratos ativados no período, independentemente da situação atual.
   * Filtrar somente `status = A` esconderia vendas canceladas posteriormente.
   * Venda e cancelamento são eventos distintos; o churn mede o segundo.
   * A leitura paginada permite calcular ticket e mix usando o plano real,
   * sem tratar contagem de contratos como soma de receita.
   */
  async listActivations(sinceIso:string,correlationId:string,maxPages=4,pageSize=500,untilIso?:string){
    const filters:GridFilter[]=[{TB:"cliente_contrato.data_ativacao",OP:">=",P:sinceIso.slice(0,10)}];
    if(untilIso)filters.push({TB:"cliente_contrato.data_ativacao",OP:"<=",P:untilIso.slice(0,10)});
    const rows:Record<string,unknown>[]=[];let total=0;
    for(let page=1;page<=maxPages;page+=1){
      const result=await this.readPage("listContracts",endpoints.listContracts,"cliente_contrato.data_ativacao",sinceIso.slice(0,10),correlationId,pageSize,"",{oper:">=",page,sortname:"cliente_contrato.data_ativacao",sortorder:"desc",gridParam:filters});
      total=result.total;rows.push(...result.records);
      if(result.records.length<pageSize||rows.length>=total)break;
    }
    return{rows,total,truncated:rows.length<total};
  }
  /**
   * Resolve nome e mensalidade dos planos: o contrato não carrega o valor.
   * Deduplica os planos e mantém cache para reduzir consultas repetidas.
   */
  async resolvePlanValues(planIds:string[],correlationId:string):Promise<Map<string,{name:string;value?:number}>>{
    const resolved=new Map<string,{name:string;value?:number}>();
    const missing:string[]=[];
    for(const id of [...new Set(planIds.filter(Boolean))]){
      const cached=this.planCache.get(id);
      if(cached)resolved.set(id,cached);else missing.push(id);
    }
    await Promise.all(missing.map(async(id)=>{
      try{
        const rows=await this.read("getPlan",endpoints.getPlan,"id",id,correlationId,1,"");
        if(!rows[0])return;
        const plan=IxcPlanMapper.map(rows[0]);
        const entry={name:plan.name,value:plan.value};
        this.planCache.set(id,entry);resolved.set(id,entry);
      }catch{/* plano indisponível: quem chama trata como valor ausente, não como zero */}
    }));
    return resolved;
  }
  /** Quantos contratos ativos existem hoje. Uma consulta, sem varrer registro. */
  async countActiveContracts(correlationId:string){
    return this.countContractsByStatus("A",correlationId);
  }
  /**
   * Contagem por situação do contrato. Confirmado em homologação: o IXC usa
   * **"I"** para contrato encerrado, não "C" — que simplesmente não existe e
   * devolveria zero em silêncio, parecendo "nenhum cancelamento".
   */
  async countContractsByStatus(status:string,correlationId:string){
    return (await this.readPage("listContracts",endpoints.listContracts,"cliente_contrato.status",status,correlationId,1,"",{oper:"=",sortname:"cliente_contrato.id"})).total;
  }
  /**
   * Contratos cancelados a partir de uma data. Filtra por `data_cancelamento`,
   * sem prender o status: combinar `status = A` com data de cancelamento é
   * contraditório e devolve zero — erro que já foi cometido aqui uma vez.
   */
  async listCancellations(sinceIso:string,correlationId:string,maxPages=4,pageSize=500){
    const filters:GridFilter[]=[{TB:"cliente_contrato.data_cancelamento",OP:">=",P:sinceIso.slice(0,10)}];
    const rows:Record<string,unknown>[]=[];let total=0;
    for(let page=1;page<=maxPages;page+=1){
      const result=await this.readPage("listContracts",endpoints.listContracts,"cliente_contrato.data_cancelamento",sinceIso.slice(0,10),correlationId,pageSize,"",{oper:">=",page,sortname:"cliente_contrato.data_cancelamento",sortorder:"desc",gridParam:filters});
      total=result.total;rows.push(...result.records);
      if(result.records.length<pageSize||rows.length>=total)break;
    }
    return{rows,total,truncated:rows.length<total};
  }
  /**
   * Contratos criados depois do `id` informado, do mais antigo para o mais novo.
   * O identificador crescente é o cursor da auditoria; uma data de criação
   * com resolução de dia não permite distinguir todas as criações do período.
   */
  async listContractsAfter(afterId:number,limit:number,correlationId:string){
    return (await this.readPage("listContracts",endpoints.listContracts,"cliente_contrato.id",String(afterId),correlationId,limit,"",{oper:">",sortname:"cliente_contrato.id",sortorder:"asc"})).records;
  }
  /** Os contratos mais recentes, do mais novo para o mais antigo: a linha de partida da primeira auditoria. */
  async listLatestContracts(limit:number,correlationId:string){
    return (await this.readPage("listContracts",endpoints.listContracts,"cliente_contrato.id","0",correlationId,limit,"",{oper:">",sortname:"cliente_contrato.id",sortorder:"desc"})).records;
  }
  /**
   * O cadastro **cru** de um cliente. Cru porque a auditoria precisa de cada campo
   * separado — o mapper junta os quatro telefones num só, e aí "tem celular" e
   * "só tem fixo" ficariam iguais.
   */
  async getCustomerRecord(customerId:string,correlationId:string):Promise<Record<string,unknown>|undefined>{
    return (await this.read("getCustomer","cliente","id",customerId,correlationId,1))[0];
  }
  /**
   * Quantas consultas ao IXC ainda cabem no minuto, para **todo** o app. O limite
   * é um só por processo: painel, atendimento e auditoria disputam a mesma janela,
   * e quem roda em segundo plano precisa saber quando parar para não tirar a vez
   * de quem está atendendo.
   */
  rateLimitRemaining(){return this.limiter.remaining();}
  /**
   * Quem criou um registro, pelo log de alterações do IXC (`ixc_logs`).
   * `id_vendedor` credita a venda, não identifica quem digitou o cadastro.
   * A operação `inseriu` registra o operador e a data.
   * Só lê `tipo`, `operador` e `data`: `campos` e `executou` podem conter
   * dados de cliente e não são necessários para esta auditoria.
   */
  async getRecordCreator(table:string,recordId:string,authorizedCustomerId:string,correlationId:string):Promise<{operator:string;at:string|null}|undefined>{
    const {records}=await this.readPage("getRecordHistory",endpoints.getRecordHistory,"ixc_logs.id_tabela",recordId,correlationId,1,authorizedCustomerId,{oper:"=",sortname:"ixc_logs.id",sortorder:"asc",gridParam:[{TB:"ixc_logs.tabela",OP:"=",P:table},{TB:"ixc_logs.tipo",OP:"=",P:"inseriu"}]});
    const log=records[0];
    const operator=String(log?.operador??"").trim();
    if(!log||!operator)return undefined;
    const at=String(log.data??"").trim();
    return{operator,at:at&&!at.startsWith("0000")?at:null};
  }
  /**
   * O que o diagnóstico de "sem internet" precisa: o login (online? desde quando
   * caiu?), o contrato (bloqueado?) e as OS ainda abertas. Três consultas em
   * paralelo, contra as ~15 do `getSnapshot` — que traz pagamentos e plano que o
   * diagnóstico não usa, e o limite por minuto do IXC é de todo o processo.
   */
  async getServiceDiagnosis(customerId:string,correlationId:string):Promise<IxcServiceDiagnosisData>{
    this.guard.assertCustomer(customerId);
    const [logins,contracts,orders]=await Promise.all([
      this.read("getConnection",endpoints.getConnection,"id_cliente",customerId,correlationId,5),
      this.read("listContracts",endpoints.listContracts,"id_cliente",customerId,correlationId,5),
      this.read("listServiceOrders",endpoints.listServiceOrders,"id_cliente",customerId,correlationId,20,customerId,{sortname:"su_oss_chamado.data_abertura",sortorder:"desc"}),
    ]);
    const text=(raw:Record<string,unknown>,key:string)=>{const value=String(raw[key]??"").trim();return value&&!value.startsWith("0000-00-00")?value:undefined;};
    return {
      logins:logins.map((raw)=>({id:String(raw.id??""),contractId:text(raw,"id_contrato"),online:raw.online==="S"?true:raw.online==="N"?false:null,lastConnectedAt:text(raw,"ultima_conexao_inicial"),lastDisconnectedAt:text(raw,"ultima_conexao_final"),disconnectReason:text(raw,"motivo_desconexao"),neighborhood:text(raw,"bairro")})),
      contracts:contracts.map((raw)=>({id:String(raw.id??""),status:String(raw.status??""),internetStatus:String(raw.status_internet??""),trustUnlockActive:raw.desbloqueio_confianca_ativo==="S",trustUnlockKnown:raw.desbloqueio_confianca_ativo==="S"||raw.desbloqueio_confianca_ativo==="N"})),
      // "F" é finalizada; o resto ainda está na fila de alguém.
      openServiceOrders:orders.filter((raw)=>String(raw.status??"")!=="F").map((raw)=>({id:String(raw.id??""),status:String(raw.status??""),subjectId:text(raw,"id_assunto"),openedAt:text(raw,"data_abertura")})),
    };
  }
  /**
   * Leitura pontual para reconciliação: o ID da fatura não substitui o escopo
   * do cliente. Consulta `fn_areceber` com os dois filtros e revalida o retorno.
   * Não usa o cache/snapshot nem filtra por status: recebidas também importam.
   */
  async getInvoiceForCustomer(customerId:string,invoiceId:string,correlationId:string):Promise<{id:string;customerId:string;status:string}|undefined>{
    if(!/^[1-9]\d{0,31}$/.test(customerId)||!/^[1-9]\d{0,31}$/.test(invoiceId))throw new IxcReadonlyError("IXC_INVALID_INVOICE_REFERENCE");
    const {records,total}=await this.readPage("listInvoices",endpoints.listInvoices,"fn_areceber.id",invoiceId,correlationId,2,customerId,{
      oper:"=",page:1,sortname:"fn_areceber.id",strictPage:true,
      gridParam:[{TB:"fn_areceber.id_cliente",OP:"=",P:customerId}],
    });
    if(total===0&&records.length===0)return undefined;
    if(total!==1||records.length!==1)throw new IxcReadonlyError("IXC_AMBIGUOUS_INVOICE");
    const row=records[0];
    const id=(value:unknown)=>typeof value==="string"?value:typeof value==="number"&&Number.isSafeInteger(value)?String(value):"";
    if(id(row.id)!==invoiceId||id(row.id_cliente)!==customerId)throw new IxcReadonlyError("IXC_INVOICE_SCOPE_MISMATCH");
    return{id:invoiceId,customerId,status:typeof row.status==="string"?row.status:""};
  }
  /** Contagem de faturas em aberto na base inteira: uma consulta, sem varrer registro. */
  async countOpenInvoices(correlationId:string){
    return (await this.readPage("listInvoices",endpoints.listInvoices,"fn_areceber.status","A",correlationId,1,"",{oper:"=",sortname:"fn_areceber.id",strictFinancialPage:true})).total;
  }
  async getSnapshot(customerId:string,correlationId:string,force=false):Promise<IxcCustomerSnapshot>{
    this.guard.assertCustomer(customerId); const cached=!force?this.cache.get(customerId):undefined;if(cached){this.emit("ixc.snapshot",correlationId,0,"cache-hit",{customerId:"[MASKED]"});return{...cached,cache:"hit",metrics:{...cached.metrics,totalLatencyMs:0}};}this.durations.set(correlationId,{});
    const started=this.now();
    try{
      const customerRows=await this.read("getCustomer","cliente","id",customerId,correlationId,1);if(!customerRows[0])throw new Error("IXC_CUSTOMER_NOT_FOUND");
      if(customerRows.length!==1||String(customerRows[0].id??"")!==customerId)throw new Error("IXC_CUSTOMER_SCOPE_MISMATCH");
      const settled=await Promise.allSettled([
        this.readPage("listContracts",endpoints.listContracts,"id_cliente",customerId,correlationId),
        this.readPage("listInvoices",endpoints.listInvoices,"id_cliente",customerId,correlationId),
        this.readPage("listServiceOrders",endpoints.listServiceOrders,"id_cliente",customerId,correlationId),
        this.readPage("getConnection",endpoints.getConnection,"id_cliente",customerId,correlationId),
      ]);
      const rows=(index:number)=>settled[index].status==="fulfilled"?settled[index].value.records.slice(0,20):[];
      const sourceNames=["contracts","invoices","serviceOrders","connection"] as const;
      const coverage:IxcCustomerSnapshot["coverage"]={};
      for(const [index,name] of sourceNames.entries()){
        const result=settled[index];
        coverage[name]=result.status==="fulfilled"?{...result.value.coverage,read:rows(index).length,
          complete:result.value.coverage.complete&&rows(index).every(row=>String(row.id_cliente??"")===customerId)}:{read:0,total:null,complete:false,limit:20};
      }
      const contracts=rows(0).map(IxcContractMapper.map);let plan=null;let planFailed=false;
      if(contracts[0]?.planId&&contracts[0].customerId===customerId){try{const planRows=await this.read("getPlan",endpoints.getPlan,"id",contracts[0].planId,correlationId,1,customerId);if(planRows.length!==1||String(planRows[0].id??"")!==contracts[0].planId)throw new Error("IXC_PLAN_SCOPE_MISMATCH");plan=IxcPlanMapper.map(planRows[0]);contracts[0]={...contracts[0],planName:plan.name,monthlyValue:plan.value};}catch{planFailed=true;}}
      // `fn_movim_finan` (pagamentos) não tem coluna id_cliente -- filtrar por ela sempre
      // devolvia página de erro do próprio IXC, nunca um problema de rede. O vínculo real é
      // por fatura (id_receber), então busca-se por fatura já sabidamente do cliente
      // (confirmada pela consulta de faturas acima). Limitado às primeiras 10 faturas lidas
      // para não disparar uma fatura de chamadas por atendimento.
      const invoiceRows=rows(1);let payments:ReturnType<typeof IxcPaymentMapper.map>[]=[];let paymentsFailed=false;
      const paymentInvoices=invoiceRows.filter(invoice=>String(invoice.id_cliente??"")===customerId&&String(invoice.id??"").trim()&&invoiceRows.filter(other=>String(other.id)===String(invoice.id)).length===1).slice(0,10);
      coverage.payments={read:0,total:coverage.invoices?.complete&&invoiceRows.length===0?0:null,complete:coverage.invoices?.complete===true&&invoiceRows.length===0,limit:100};
      if(paymentInvoices.length>0){
        const paymentSettled=await Promise.allSettled(paymentInvoices.map((invoice)=>{
          const invoiceId=String((invoice as Record<string,unknown>).id??"");
          return this.readPage("listPayments",endpoints.listPayments,"id_receber",invoiceId,correlationId,10,customerId);
        }));
        payments=paymentSettled.flatMap((item,index)=>item.status==="fulfilled"?item.value.records.slice(0,10).filter(row=>String(row.id_receber??row.id_fatura??"")===String(paymentInvoices[index].id)).map((row)=>IxcPaymentMapper.map(row,customerId)):[]);
        paymentsFailed=paymentSettled.some((item)=>item.status==="rejected");
        const complete=coverage.invoices?.complete===true&&invoiceRows.length<=10&&paymentInvoices.length===invoiceRows.length&&paymentSettled.every((item,index)=>item.status==="fulfilled"&&item.value.coverage.complete&&item.value.records.every(row=>String(row.id_receber??row.id_fatura??"")===String(paymentInvoices[index].id)));
        coverage.payments={read:payments.length,total:complete?payments.length:null,complete,limit:100};
      }
      let customer=IxcCustomerMapper.map(customerRows[0]);
      const cityCode=String(customerRows[0].cidade??"").trim();
      if(cityCode){const cityName=await this.resolveCityName(cityCode,correlationId,customerId);if(cityName)customer={...customer,city:cityName};}
      const snapshot:IxcCustomerSnapshot={customer,contracts,plan,invoices:invoiceRows.map(IxcInvoiceMapper.map),payments,serviceOrders:rows(2).map(IxcServiceOrderMapper.map),connection:rows(3)[0]?IxcConnectionMapper.map(rows(3)[0]):null,coverage,partialSources:[...settled.flatMap((item,index)=>item.status==="rejected"?[sourceNames[index]]:[]),...(planFailed?["plan"]:[]),...(paymentsFailed?["payments"]:[])],metrics:{totalLatencyMs:this.now()-started,blockLatencies:{...(this.durations.get(correlationId)??{})}},fetchedAt:new Date(this.now()).toISOString(),mode:"staging-readonly",cache:"miss"};
      this.cache.set(customerId,snapshot);this.emit("ixc.snapshot",correlationId,this.now()-started,"success",{partial:settled.some((item)=>item.status==="rejected")});return snapshot;
    }catch(error){this.emit("ixc.snapshot",correlationId,this.now()-started,"failed",{error:error instanceof Error?error.name:"unknown"});throw error;}
  }
  invalidate(customerId:string){this.guard.assertCustomer(customerId);this.cache.delete(customerId);}
  private async resolveCityName(cityCode:string,correlationId:string,customerId:string):Promise<string|undefined>{
    const cached=this.cityCache.get(cityCode);if(cached)return cached;
    try{
      const rows=await this.read("getCity",endpoints.getCity,"id",cityCode,correlationId,1,customerId);
      const raw=rows[0] as Record<string,unknown>|undefined;if(!raw)return undefined;
      const name=["nome","cidade","descricao"].map((key)=>raw[key]).find((value)=>value!==undefined&&value!==null&&String(value).trim());
      if(!name)return undefined;
      const value=String(name).trim();this.cityCache.set(cityCode,value);return value;
    }catch{return undefined;}
  }
  health(){return{service:"IXC",mode:this.mode,state:this.breaker.state()==="open"?"degraded":"healthy",detail:this.guard.scope()==="full-base"?"Somente leitura; base inteira liberada":"Somente leitura; allowlist ativa",scope:this.guard.scope(),allowlist:this.guard.listMasked()};}
  private async read(operation:IxcReadOperation,resource:string,qtype:string,query:string,correlationId:string,rp=20,authorizedCustomerId=query,options?:ReadOptions):Promise<Record<string,unknown>[]>{
    return (await this.readPage(operation,resource,qtype,query,correlationId,rp,authorizedCustomerId,options)).records;
  }
  private async readPage(operation:IxcReadOperation,resource:string,qtype:string,query:string,correlationId:string,rp=20,authorizedCustomerId=query,options?:ReadOptions):Promise<{records:Record<string,unknown>[];total:number;coverage:IxcSnapshotCoverage}>{
    this.guard.assertOperation(operation);if(!GLOBAL_SCOPE_OPERATIONS.has(operation))this.guard.assertCustomer(authorizedCustomerId);if(!this.breaker.canRequest())throw new Error("IXC_CIRCUIT_OPEN");this.limiter.assert();
    const url=`${this.options.baseUrl.replace(/\/$/,"")}/webservice/v1/${resource}`;let last:unknown;
    const payload:Record<string,string>={qtype,query,oper:options?.oper??"=",page:String(options?.page??1),rp:String(rp),sortname:options?.sortname??"id",sortorder:options?.sortorder??"asc"};
    if(options?.gridParam?.length)payload.grid_param=JSON.stringify(options.gridParam);
    const maxAttempts=1+(this.options.retryLimit??1);for(let attempt=0;attempt<maxAttempts;attempt+=1){const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),this.timeoutMs);const started=this.now();try{const response=await this.fetcher(url,{method:"POST",headers:{Authorization:`Basic ${basicCredential(this.options.token)}`,"Content-Type":"application/json","ixcsoft":"listar","x-correlation-id":correlationId},body:JSON.stringify(payload),signal:controller.signal});clearTimeout(timer);if(!response.ok){const retry=response.status===429||response.status>=500;if(retry&&attempt+1<maxAttempts){last=new IxcReadonlyError(`IXC_HTTP_${response.status}`);continue}throw new IxcReadonlyError(`IXC_HTTP_${response.status}`)}const body=await response.json() as IxcListResponse;const contractError=apiError(body);if(contractError)throw contractError;if(options?.strictPage){
      const rawTotal=body.total;
      const validTotal=typeof rawTotal==="number"||(typeof rawTotal==="string"&&/^\d+$/.test(rawTotal));
      const complete=validTotal&&Number.isSafeInteger(Number(rawTotal))&&Number(rawTotal)>=0&&Array.isArray(body.registros)
        &&body.registros.every((row)=>!!row&&typeof row==="object"&&!Array.isArray(row))
        &&body.registros.length===Number(rawTotal)&&body.registros.length<=rp;
      if(!complete)throw new IxcReadonlyError("IXC_INCOMPLETE_INVOICE_RESPONSE");
    }
    const records=Array.isArray(body.registros)?body.registros.filter((item):item is Record<string,unknown>=>!!item&&typeof item==="object"&&!Array.isArray(item)):[];
    const rawTotal=body.total;
    const knownTotal=(typeof rawTotal==="number"||(typeof rawTotal==="string"&&/^\d+$/.test(rawTotal)))&&Number.isSafeInteger(Number(rawTotal))&&Number(rawTotal)>=records.length?Number(rawTotal):null;
    const validRows=Array.isArray(body.registros)&&body.registros.length===records.length&&records.every(row=>(typeof row.id==="string"&&!!row.id.trim())||(typeof row.id==="number"&&Number.isSafeInteger(row.id)&&row.id>0));
    const uniqueIds=new Set(records.map(row=>String(row.id))).size===records.length;
    const firstPage=(options?.page??1)===1&&(body.page===undefined||String(body.page)==="1");
    if(options?.strictFinancialPage){
      const page=options.page??1;
      const pageMatches=body.page===undefined||String(body.page)===String(page);
      const financialIds=records.map(row=>String(row.id).trim());
      const validIds=financialIds.every(id=>/^[1-9]\d*$/.test(id))&&new Set(financialIds).size===records.length;
      const expected=knownTotal===null?-1:Math.min(rp,Math.max(knownTotal-(page-1)*rp,0));
      if(knownTotal===null||!validRows||!validIds||!pageMatches||records.length!==expected)
        throw new IxcReadonlyError("IXC_INCOMPLETE_FINANCIAL_RESPONSE");
    }
    const coverage={read:records.length,total:knownTotal,complete:validRows&&uniqueIds&&firstPage&&knownTotal===records.length&&records.length<=rp,limit:rp};
    const total=Number(rawTotal??records.length);this.breaker.success();this.emit(`ixc.${operation}`,correlationId,this.now()-started,"success",{count:records.length});return{records,total:Number.isFinite(total)?total:records.length,coverage};}catch(error){clearTimeout(timer);last=classifyError(error);if(attempt+1<maxAttempts&&(last as IxcReadonlyError).code==="IXC_TIMEOUT")continue;break;}}
    const failure=classifyError(last);this.breaker.failure();this.emit(`ixc.${operation}`,correlationId,0,"failed",sanitizeTelemetry({error:failure.code}) as Record<string,unknown>);throw failure;
  }
  private emit(event:string,correlationId:string,durationMs:number,status:IxcTrace["status"],attributes:Record<string,unknown>){if(event.startsWith("ixc.")&&event!=="ixc.snapshot"){const key=event.slice(4);this.durations.set(correlationId,{...(this.durations.get(correlationId)??{}),[key]:durationMs});}this.options.trace?.({event,correlationId,durationMs,status,attributes:sanitizeTelemetry(attributes) as Record<string,unknown>});}
}
