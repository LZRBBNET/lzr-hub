const digits = /\d/g;

export function maskDocument(value: unknown) {
  const raw = String(value ?? "").replace(/\D/g, "");
  if (!raw) return "não informado";
  return raw.length <= 11 ? `***.***.***-${raw.slice(-2).padStart(2,"*")}` : `**.***.***/****-${raw.slice(-2).padStart(2,"*")}`;
}

export function maskName(value: unknown) {
  const parts = String(value ?? "Cliente autorizado").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return parts[0] ?? "Cliente autorizado";
  return `${parts[0]} ${parts.slice(1).map((part)=>`${part[0]}.`).join(" ")}`;
}

export function maskText(value: unknown, keepStart = 3) {
  const raw = String(value ?? "").trim();
  if (!raw) return "não informado";
  return `${raw.slice(0, keepStart)}${"*".repeat(Math.min(6, Math.max(3, raw.length - keepStart)))}`;
}

export function sanitizeTelemetry(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeTelemetry);
  if (!value || typeof value !== "object") return typeof value === "string" ? value.replace(digits, "*") : value;
  return Object.fromEntries(Object.entries(value as Record<string,unknown>).map(([key,item]) => {
    const sensitive = /(cpf|cnpj|document|phone|telefone|email|address|endereco|token|authorization|name|nome|razao|bairro|login|pix|barcode)/i.test(key);
    return [key, sensitive ? "[REDACTED]" : sanitizeTelemetry(item)];
  }));
}
