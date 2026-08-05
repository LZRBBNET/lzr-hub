"use client";
import { useState } from "react";

/**
 * Barras por dia com leitura acima do gráfico.
 *
 * A primeira versão usava só o atributo `title`: o balão nativo demora quase um
 * segundo para aparecer e some ao mover o mouse, então na prática ninguém
 * conseguia ler o valor de uma barra. Aqui o rótulo é um elemento normal, que
 * troca no hover e mostra o total quando o mouse está fora.
 */
export interface BarPoint { day: string; contracts: number }

const dayLabel = (day: string) => {
  const parsed = new Date(`${day}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? day : parsed.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
};

export function BarChart({ data, noun }: { data: BarPoint[]; noun: string }) {
  const [hover, setHover] = useState<number | null>(null);
  if (data.length === 0) return <p style={{ fontSize: 12, color: "#64748b", padding: "12px 0" }}>Nada no período.</p>;

  const peak = data.reduce((max, item) => Math.max(max, item.contracts), 0);
  const total = data.reduce((sum, item) => sum + item.contracts, 0);
  const active = hover === null ? null : data[hover];

  return <>
    <div style={{ padding: "10px 25px 0", fontSize: 12, color: "#40566d", minHeight: 34 }}>
      {active
        ? <><strong style={{ fontSize: 15 }}>{active.contracts}</strong> {noun} em <strong>{dayLabel(active.day)}</strong></>
        : <>Total de <strong>{total}</strong> {noun} em {data.length} dia(s). Passe o mouse sobre uma barra para ver o dia.</>}
    </div>
    <div className="billing-chart" style={{ paddingTop: 12 }}>
      {data.map((item, index) => <div
        key={item.day}
        onMouseEnter={() => setHover(index)}
        onMouseLeave={() => setHover(null)}
        title={`${dayLabel(item.day)}: ${item.contracts} ${noun}`}
        style={{ cursor: "default" }}
      >
        <span style={{
          height: `${peak ? Math.max((item.contracts / peak) * 100, 4) : 0}%`,
          opacity: hover === null || hover === index ? 1 : 0.4,
          transition: "opacity .12s",
        }} />
      </div>)}
    </div>
  </>;
}
