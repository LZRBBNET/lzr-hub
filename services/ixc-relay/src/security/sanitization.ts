const sensitiveKey = /(token|secret|authorization|access|signature|cpf|cnpj|document|phone|telefone|email|address|endereco|name|nome|razao|bairro|login|pix|barcode|body|payload|response)/i;
const validatedSafeStringKey = /^(timestamp|correlationId|operation|status|errorCode|environment|relayVersion|cache)$/;

export function sanitizeLogValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeLogValue);
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? value.replace(/\d/g, "*").slice(0, 160) : value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      if (sensitiveKey.test(key)) return [key, "[REDACTED]"];
      if (validatedSafeStringKey.test(key) && typeof item === "string") return [key, item.slice(0, 160)];
      return [key, sanitizeLogValue(item)];
    }),
  );
}
