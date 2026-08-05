import type { IxcConnectionDto, IxcContractDto, IxcCustomerDto, IxcInvoiceDto, IxcPaymentDto, IxcPlanDto, IxcServiceOrderDto } from "./types.ts";

type Raw = Record<string,unknown>;
const str=(raw:Raw,...keys:string[])=>{for(const key of keys){const value=raw[key];if(value!==undefined&&value!==null&&String(value).trim())return String(value).trim()}return ""};
/**
 * Campo ausente vira `undefined`, nunca 0.
 *
 * `Number("")` é 0, então a versão anterior transformava "o IXC não mandou este
 * campo" em "o valor é zero" — que atravessa a aplicação inteira parecendo dado
 * bom. Mensalidade zerada e fatura de R$ 0,00 saíam daqui.
 */
const num=(raw:Raw,...keys:string[])=>{const text=str(raw,...keys);if(!text)return undefined;const value=Number(text.replace(",","."));return Number.isFinite(value)?value:undefined};

/**
 * Compõe um endereço legível a partir dos campos separados do IXC.
 * A cidade fica de fora de propósito: já é resolvida à parte (código -> nome)
 * pelo IxcReadonlyProvider, não aqui.
 */
function composeAddress(raw:Raw):string {
  const street=str(raw,"endereco");
  if(!street)return "";
  const number=str(raw,"numero");
  const complement=str(raw,"complemento");
  const neighborhood=str(raw,"bairro");
  const cep=str(raw,"cep");
  const parts=[
    number?`${street}, ${number}`:street,
    complement,
    neighborhood?`Bairro ${neighborhood}`:"",
    cep?`CEP ${cep}`:"",
  ].filter(Boolean);
  return parts.join(" - ");
}

export class IxcCustomerMapper {
  static map(raw:Raw):IxcCustomerDto {
    const id=str(raw,"id"); if(!id)throw new Error("IXC customer sem id");
    return {
      id,
      name:str(raw,"razao","nome")||"não informado",
      document:str(raw,"cnpj_cpf","cpf_cnpj")||"não informado",
      phone:str(raw,"telefone_celular","whatsapp","telefone_comercial","fone")||"não informado",
      email:str(raw,"email")||"não informado",
      city:str(raw,"cidade","cidade_nome")||"não informada",
      neighborhood:str(raw,"bairro")||"não informado",
      address:composeAddress(raw)||"não informado",
      status:str(raw,"ativo","status")||"desconhecido",
      customerSince:str(raw,"data_cadastro")||undefined,
      updatedAt:str(raw,"ultima_atualizacao","data")||undefined,
    };
  }
}

/**
 * `cliente_contrato` **não tem campo de valor** -- verificado listando os 150+
 * campos que o IXC devolve. A mensalidade mora no plano (`vd_contratos`), então
 * `monthlyValue` só é preenchido depois, quando o plano é resolvido. O nome do
 * contrato traz o preço embutido ("FIBRA COMBO 300MB - 69,90 - BBNET"), mas
 * extrair dinheiro de string de nome quebra no primeiro plano fora do padrão.
 */
export class IxcContractMapper { static map(raw:Raw):IxcContractDto { const id=str(raw,"id"); const customerId=str(raw,"id_cliente"); if(!id||!customerId)throw new Error("IXC contract incompleto"); return {id,customerId,planId:str(raw,"id_vd_contrato","id_produto")||undefined,planName:str(raw,"contrato","plano","descricao")||"Plano não informado",status:str(raw,"status","status_internet")||"desconhecido",dueDay:num(raw,"dia_vencimento"),monthlyValue:undefined,activatedAt:str(raw,"data_ativacao","data_inicio")||undefined}; } }
// O valor do plano é `valor_contrato` (vem com 9 casas: "59.900000000").
export class IxcPlanMapper { static map(raw:Raw):IxcPlanDto { const id=str(raw,"id");if(!id)throw new Error("IXC plan sem id");return{id,name:str(raw,"nome","descricao","contrato")||"Plano não informado",speed:str(raw,"velocidade","download")||undefined,value:num(raw,"valor_contrato","valor","valor_plano")}; } }
// `valor_aberto` desconta o que já foi pago na fatura; é o número certo para
// "em aberto" e "vencido". `valor` é o valor cheio e serve de reserva.
export class IxcInvoiceMapper { static map(raw:Raw):IxcInvoiceDto { const id=str(raw,"id"); const customerId=str(raw,"id_cliente"); if(!id||!customerId)throw new Error("IXC invoice incompleta"); return {id,customerId,contractId:str(raw,"id_contrato","id_vd_contrato")||undefined,status:str(raw,"status")||"desconhecido",dueAt:str(raw,"data_vencimento","vencimento")||undefined,value:num(raw,"valor_aberto","valor"),paymentCode:str(raw,"linha_digitavel")||undefined}; } }
/**
 * fn_movim_finan (pagamentos) não tem coluna id_cliente no IXC real -- por isso o
 * customerId vem de fora (já sabido: é o cliente cuja fatura acabou de ser
 * consultada), em vez de ser extraído da própria linha crua.
 */
export class IxcPaymentMapper { static map(raw:Raw,customerId:string):IxcPaymentDto { const id=str(raw,"id"); if(!id)throw new Error("IXC payment incompleto"); return {id,customerId,invoiceId:str(raw,"id_receber","id_fatura")||undefined,paidAt:str(raw,"data","data_pagamento")||undefined,value:num(raw,"valor"),method:str(raw,"tipo_recebimento","forma_pagamento")||"não informado"}; } }
// O `endereco` da OS já vem montado numa string só pelo IXC (diferente do
// cadastro, que traz os campos separados) -- por isso não passa por composeAddress.
export class IxcServiceOrderMapper { static map(raw:Raw):IxcServiceOrderDto { const id=str(raw,"id"); const customerId=str(raw,"id_cliente"); if(!id||!customerId)throw new Error("IXC service order incompleta"); return {id,customerId,status:str(raw,"status")||"desconhecido",subject:str(raw,"assunto","mensagem")||"Assunto não informado",openedAt:str(raw,"data_abertura","data")||undefined,closedAt:str(raw,"data_fechamento")||undefined,address:str(raw,"endereco")||undefined}; } }

export class IxcConnectionMapper {
  static map(raw:Raw):IxcConnectionDto {
    const id=str(raw,"id"); const customerId=str(raw,"id_cliente"); if(!id||!customerId)throw new Error("IXC connection incompleta");
    return {
      id,customerId,
      login:str(raw,"login")||"não informado",
      status:str(raw,"online","status")||"desconhecido",
      lastAccessAt:str(raw,"ultima_conexao_inicial","ultima_conexao")||undefined,
      address:composeAddress(raw)||undefined,
      // Descreve por qual OLT/PON o cliente entra -- é o dado de rede que o IXC realmente
      // disponibiliza aqui. Modelo de ONU e potência óptica em dBm não vêm desse endpoint;
      // não inventamos um valor no lugar (ver readonly-provider.ts).
      equipmentDescriptor:str(raw,"conexao")||undefined,
      connectionType:str(raw,"tipo_conexao")||undefined,
    };
  }
}
