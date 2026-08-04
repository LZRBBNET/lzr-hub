const digits = /\d/g;

export function sanitizeTelemetry(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeTelemetry);
  if (!value || typeof value !== "object") return typeof value === "string" ? value.replace(digits, "*") : value;
  return Object.fromEntries(Object.entries(value as Record<string,unknown>).map(([key,item]) => {
    const sensitive = /(cpf|cnpj|document|phone|telefone|email|address|endereco|token|authorization|name|nome|razao|bairro|login|pix|barcode)/i.test(key);
    return [key, sensitive ? "[REDACTED]" : sanitizeTelemetry(item)];
  }));
}
