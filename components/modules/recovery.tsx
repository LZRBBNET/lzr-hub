"use client";

import { useEffect, useState } from "react";
import type { Navigate } from "@/components/lzr-hub-app";
import { RecoveryCasesModule } from "./recovery-cases";
import type { RecoveryCustomerDetail, RecoveryCustomerRow, RecoveryPayload, RecoveryPromise } from "@/lib/platform/recovery-shared";
import { Icon } from "@/components/ui/icons";
import { Badge, Card, Empty, ErrorState, Limits, Loading, Modal, Notice, Stat, Stats, Toolbar, count, dateTime, money } from "@/components/ui/kit";

const PAGE_SIZE = 20;
const calendarDate = (value: string | null) => value ? value.slice(0, 10).split("-").reverse().join("/") : "—";
const amount = (value: number | null) => value === null ? "—" : money(value);
const PROMISE_LABEL: Record<RecoveryPromise["status"], string> = { pending: "Pendente", fulfilled: "Cumprida (registro)", broken: "Quebrada (registro)", unknown: "Status não reconhecido" };

/**
 * A leitura financeira faz apenas GET. Casos locais exigem confirmação explícita.
 * A posição financeira é um recorte limitado; não se infere bloqueio, contato
 * ou previsão de cancelamento a partir da simples existência de uma dívida.
 */
export function RecoveryModule({ onNavigate }: { onNavigate?: Navigate } = {}) {
  const [view, setView] = useState<"reading" | "cases">("reading");
  const [prepared, setPrepared] = useState({ customerId: "", revision: 0 });
  function prepare(customerId: string) { setPrepared(previous => ({ customerId, revision: previous.revision + 1 })); setView("cases"); }
  return <>
    <div className="tool-switch" role="tablist" aria-label="Modo de recuperação">
      <button type="button" role="tab" aria-selected={view === "reading"} className={`tool-card ${view === "reading" ? "active" : ""}`} onClick={() => setView("reading")}><span><strong>Leitura financeira</strong><span>Conferir o recorte do IXC, sem gravações</span></span></button>
      <button type="button" role="tab" aria-selected={view === "cases"} className={`tool-card ${view === "cases" ? "active" : ""}`} onClick={() => { if (view !== "cases") { setPrepared(previous => ({ customerId: "", revision: previous.revision + 1 })); setView("cases"); } }}><span><strong>Casos acompanhados</strong><span>Responsável, retorno e histórico no HUB</span></span></button>
    </div>
    {view === "reading" ? <RecoveryReadOnly onPrepareCase={prepare} /> : <RecoveryCasesModule key={prepared.revision} initialCustomerId={prepared.customerId} onNavigate={onNavigate} />}
  </>;
}

function RecoveryReadOnly({ onPrepareCase }: { onPrepareCase: (customerId: string) => void }) {
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState<{ page: number; revision: number; data?: RecoveryPayload; error?: string } | null>(null);
  const [selected, setSelected] = useState<RecoveryCustomerRow | null>(null);
  const loading = loaded?.page !== page || loaded?.revision !== revision;
  const data = loading ? undefined : loaded?.data;

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    fetch(`/api/billing/recovery?page=${page}&pageSize=${PAGE_SIZE}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as RecoveryPayload & { error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Não foi possível consultar a recuperação.");
        if (active && payload.available && page > Math.max(1, Math.ceil((payload.totalCustomers ?? 0) / PAGE_SIZE))) {
          setPage(Math.max(1, Math.ceil((payload.totalCustomers ?? 0) / PAGE_SIZE)));
          return;
        }
        if (active) setLoaded({ page, revision, data: payload });
      })
      .catch((error: unknown) => {
        if (active) setLoaded({ page, revision, error: error instanceof Error ? error.message : "Consulta indisponível." });
      });
    return () => { active = false; controller.abort(); };
  }, [page, revision]);

  function refresh() { setSelected(null); setPage(1); setRevision((value) => value + 1); }
  function changePage(next: number) { setSelected(null); setPage(next); }

  return <>
    <Toolbar actions={<button type="button" className="button secondary" disabled={loading} onClick={refresh}><Icon name="refresh" size={16} />Atualizar leitura</button>}>
      <Badge>Somente leitura</Badge><span className="muted small">Nenhum contato ou alteração no IXC é feito nesta tela.</span>
    </Toolbar>
    {loading && <Loading stats={3} rows={5} label="Consultando faturas vencidas" />}
    {!loading && loaded?.error && <ErrorState onRetry={refresh}>{loaded.error}</ErrorState>}
    {data && !data.available && <Notice tone="warn">{data.detail ?? "Fonte financeira indisponível."} Nenhum valor foi estimado.</Notice>}
    {data?.available && data.summary && <>
      <Stats columns={3}>
        <Stat label="Clientes no recorte" value={count(data.summary.customers)} icon="users" hint="Com faturas vencidas entre as lidas" />
        <Stat label="Faturas no recorte" value={count(data.summary.overdueInvoices)} icon="ticket" hint={`${count(data.coverage.scannedInvoices ?? 0)} registro(s) consultado(s)`} />
        <Stat label="Valor disponível no recorte" value={amount(data.summary.knownOverdueValue)} icon="wallet" tone="warn"
          hint={data.summary.amountIncomplete ? "Soma parcial: existem valores não informados" : data.summary.faceValueFallbackInvoices ? "Inclui valor nominal: confira o saldo no IXC" : "Saldo aberto das faturas lidas"} />
      </Stats>
      {data.coverage.truncated && <Notice tone="warn">Recorte parcial: {count(data.coverage.scannedInvoices ?? 0)} faturas vencidas consultadas{data.coverage.totalOverdueInvoices !== null ? ` de ${count(data.coverage.totalOverdueInvoices)}` : "; total não informado pelo IXC"}. Clientes e saldos podem estar incompletos; esta não é a carteira inteira.</Notice>}
      {!data.coverage.truncated && data.coverage.totalOverdueInvoices === null && <Notice tone="warn">O IXC não informou o total de faturas vencidas. Não é possível confirmar a cobertura desta leitura.</Notice>}
      {data.summary.faceValueFallbackInvoices > 0 && <Notice tone="warn">{count(data.summary.faceValueFallbackInvoices)} fatura(s) sem saldo aberto informado usam o valor nominal, que pode incluir quantias já pagas. Confira antes de qualquer cobrança.</Notice>}
      {data.coverage.excludedInvoices > 0 && <Notice tone="warn">{count(data.coverage.excludedInvoices)} registro(s) sem dados válidos ou elegíveis ficaram fora da lista.</Notice>}
      {data.sources.promises === "unavailable" && <Notice tone="warn">Histórico de promessas indisponível. Isso não significa que não existam promessas.</Notice>}
      <Card title="Conferência humana" badge={<Badge>Maior atraso primeiro</Badge>} flush>
        {data.rows.length === 0 ? <Empty icon="check" title="Nenhum cliente nesta página">Somente faturas abertas e vencidas com dados válidos entram no recorte.</Empty> : <div className="table" style={{ ["--cols" as string]: "minmax(0,1fr) 100px minmax(0,1fr) minmax(0,1.1fr) minmax(0,1.4fr) 104px" }}>
          <div className="tr head hide-sm"><span>Cliente IXC</span><span>Dias em atraso</span><span>Valor lido</span><span>Promessas</span><span>Próxima conferência</span><span>Consulta</span></div>
          {data.rows.map((row) => <div className="tr stack-sm" key={row.customerId}>
            <span className="cell"><strong>Cliente {row.customerId}</strong><small>{row.overdueInvoices} fatura(s) vencida(s)</small></span>
            <span className="cell"><strong>{row.daysOverdue} dia(s)</strong><small>Desde {calendarDate(row.oldestDueAt)}</small></span>
            <span className="cell"><strong>{amount(row.knownOverdueValue)}</strong><small>{row.amountIncomplete ? "Valor incompleto" : row.faceValueFallbackInvoices ? "Inclui valor nominal" : "Saldo aberto lido"}</small></span>
            <span className="cell"><PromiseSummary row={row} /><small>Histórico, não nova verificação</small></span>
            <span className="cell"><span>{row.humanReview.reason}</span><small>Bloqueio e contato da IA não consultados</small></span>
            <button type="button" className="button secondary small" onClick={() => setSelected(row)} aria-label={`Conferir cliente ${row.customerId}`}>Conferir</button>
          </div>)}
        </div>}
      </Card>
      <Toolbar actions={<>
        <button type="button" className="button secondary small" disabled={page <= 1 || loading} onClick={() => changePage(page - 1)}>Anterior</button>
        <span className="small" aria-live="polite">Página {page} de {Math.max(1, Math.ceil((data.totalCustomers ?? 0) / PAGE_SIZE))}</span>
        <button type="button" className="button secondary small" disabled={page * PAGE_SIZE >= (data.totalCustomers ?? 0) || loading} onClick={() => changePage(page + 1)}>Próxima</button>
      </>}><span className="muted small">Lido em {data.fetchedAt ? dateTime(data.fetchedAt) : "—"}. Referência: {calendarDate(data.referenceDate)} (Brasília).</span></Toolbar>
      <Limits items={[
        ["Cobertura", `Até ${data.coverage.maxInvoices} faturas por leitura, sem consultas periódicas automáticas. A lista pode mudar entre páginas; use Atualizar leitura para consultar novamente.`],
        ["Dias bloqueado", "Não há data confiável de início do bloqueio nesta integração. Dias em atraso vêm do vencimento da fatura e não são dias bloqueado."],
        ["Contato da IA e recuperação", "Não há evidência de contato vinculada a esta carteira. Job enfileirado não comprova envio, e pagamento não comprova recuperação atribuída à IA."],
        ["Risco de cancelamento", "Esta tela não calcula previsão de cancelamento. A ordem pelo atraso serve à conferência humana, sem score preditivo."],
        ["Promessas", "O histórico inclui pendentes, cumpridas e quebradas já registradas. Uma quebra antiga não prova dívida atual; nenhuma promessa é alterada por esta consulta."],
      ]} />
    </>}
    {selected && <RecoveryCustomerModal key={selected.customerId} row={selected} onClose={() => setSelected(null)} onPrepareCase={onPrepareCase} />}
  </>;
}

function PromiseSummary({ row }: { row: RecoveryCustomerRow }) {
  if (!row.promises.available) return <Badge tone="warn">Indisponível</Badge>;
  const broken = row.promises.rows.filter((promise) => promise.status === "broken").length;
  if (broken) return <Badge tone="warn">{broken} quebra(s) registrada(s)</Badge>;
  if (!row.promises.rows.length) return <span>Nenhuma registrada</span>;
  return <Badge>{row.promises.rows.length}{row.promises.truncated ? "+" : ""} registro(s)</Badge>;
}

function RecoveryCustomerModal({ row, onClose, onPrepareCase }: { row: RecoveryCustomerRow; onClose: () => void; onPrepareCase: (customerId: string) => void }) {
  const [data, setData] = useState<RecoveryCustomerDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    fetch(`/api/billing/recovery/customer?customerId=${encodeURIComponent(row.customerId)}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as RecoveryCustomerDetail & { error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Consulta do cliente indisponível.");
        if (active) setData(payload);
      })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "Consulta indisponível."); });
    return () => { active = false; controller.abort(); };
  }, [row.customerId]);
  return <Modal open title={data?.customerName ? `${data.customerName} · ${row.customerId}` : `Cliente ${row.customerId}`} onClose={onClose} wide
    footer={<><button type="button" className="button secondary" onClick={onClose}>Fechar conferência</button><button type="button" className="button secondary" onClick={() => onPrepareCase(row.customerId)}>Preparar acompanhamento</button></>}>
    <Notice>Nenhuma ação de cobrança, envio ou desbloqueio será executada.</Notice>
    {!data && !error && <Loading rows={2} label="Consultando contratos do cliente" />}
    {error && <Notice tone="bad">{error} Feche e abra novamente para repetir a consulta.</Notice>}
    {data && <>
      {!data.available && <Notice tone="warn">{data.detail ?? "Dados do IXC indisponíveis."}</Notice>}
      {data.available && data.sources.contracts === "unavailable" && <Notice tone="warn">A consulta de contratos falhou. O cadastro disponível não confirma a situação do bloqueio.</Notice>}
      {data.available && data.sources.customer === "unavailable" && <Notice tone="warn">Cadastro indisponível; o nome do cliente não foi confirmado.</Notice>}
      {data.available && <Card title="Bloqueio nos contratos consultados" badge={<Badge tone={data.blockStatus === "blocked-observed" ? "warn" : "neutral"}>{data.blockStatus === "blocked-observed" ? "Bloqueio encontrado" : "Inconclusivo"}</Badge>}>
        {data.contracts.length ? <div className="list">{data.contracts.map((contract) => <div className="row" key={contract.id}>
          <div className="row-main"><strong>Contrato {contract.id}</strong><span>Situação cadastral: {contract.contractStatus === "A" ? "ativo" : contract.contractStatus ? `código ${contract.contractStatus}` : "não informada"}{contract.trustUnlockActive === null ? " · desbloqueio de confiança não informado" : contract.trustUnlockActive ? " · desbloqueio de confiança ativo" : " · desbloqueio de confiança inativo"}</span></div>
          <Badge tone={contract.blocked ? "warn" : "neutral"}>{contract.label}</Badge>
        </div>)}</div> : <p>Nenhum contrato disponível nesta consulta.</p>}
        <p className="hint">Até {data.contractsLimit} contratos retornados pelo IXC. A ausência de bloqueio neste recorte não confirma todos os contratos. Consulta: {data.observedAt ? dateTime(data.observedAt) : "—"}.</p>
      </Card>}
    </>}
    <Stats columns={3}>
      <Stat label="Dias em atraso" value={row.daysOverdue} hint="Pelo vencimento mais antigo lido" />
      <Stat label="Dias bloqueado" value="—" hint="Data de bloqueio não disponível" />
      <Stat label="Contato da IA" value="—" hint="Sem evidência vinculada à carteira" />
    </Stats>
    <Card title="Histórico de promessas" badge={<Badge>Somente leitura</Badge>}>
      {!row.promises.available ? <Notice tone="warn">Histórico indisponível; não é ausência de promessas.</Notice> : row.promises.rows.length === 0 ? <Empty icon="clock" title="Nenhuma promessa registrada para este cliente" /> : <div className="list">{row.promises.rows.map((promise) => <div className="row" key={promise.id}>
        <div className="row-main"><strong>Fatura {promise.invoiceId}</strong><span>Prometida para {calendarDate(promise.promisedFor)}</span><small>Código da promessa no HUB: <code className="break">{promise.id}</code></small></div>
        <Badge tone={promise.status === "broken" ? "warn" : "neutral"}>{PROMISE_LABEL[promise.status]}</Badge>
      </div>)}</div>}
      {row.promises.truncated && <Notice tone="warn">Mostrando apenas as 20 promessas mais recentes deste cliente.</Notice>}
      <p className="hint">Status já registrado no HUB, não reconfirmado nesta tela. Uma promessa antiga marcada como cumprida ou quebrada não prova o saldo atual.</p>
    </Card>
  </Modal>;
}
