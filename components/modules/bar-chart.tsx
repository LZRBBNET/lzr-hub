"use client";
import { useState } from "react";
import { Empty } from "@/components/ui/kit";

/**
 * Barras por dia com leitura acima do gráfico.
 *
 * A primeira versão usava só o atributo `title`: o balão nativo demora quase um
 * segundo para aparecer e some ao mover o mouse, então na prática ninguém
 * conseguia ler o valor de uma barra. Aqui o rótulo é um elemento normal, que
 * troca no hover (ou no foco, pelo teclado) e mostra o total quando nada está
 * selecionado.
 */
export interface BarPoint { day: string; contracts: number }

const dayLabel = (day: string) => {
  const parsed = new Date(`${day}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? day : parsed.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
};

export function BarChart({ data, noun }: { data: BarPoint[]; noun: string }) {
  const [hover, setHover] = useState<number | null>(null);
  if (data.length === 0) return <Empty icon="trending" title="Nada no período" />;

  const peak = data.reduce((max, item) => Math.max(max, item.contracts), 0);
  const total = data.reduce((sum, item) => sum + item.contracts, 0);
  const active = hover === null ? null : data[hover];

  return <>
    <div className="chart-caption" aria-live="polite">
      {active
        ? <><strong>{active.contracts}</strong> {noun} em <strong>{dayLabel(active.day)}</strong></>
        : <><strong>{total}</strong> {noun} em {data.length} dia(s) <span className="muted small">· passe o mouse numa barra para ver o dia</span></>}
    </div>
    <div className="chart" role="list">
      {data.map((item, index) => <div key={item.day} role="listitem" tabIndex={0} aria-label={`${dayLabel(item.day)}: ${item.contracts} ${noun}`}
        onMouseEnter={() => setHover(index)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(index)} onBlur={() => setHover(null)}>
        <span style={{ height: `${peak ? Math.max((item.contracts / peak) * 100, 3) : 0}%`, opacity: hover === null || hover === index ? 1 : 0.35 }} />
      </div>)}
    </div>
  </>;
}
