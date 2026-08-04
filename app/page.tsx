import { LzrHubApp } from "@/components/lzr-hub-app";
import { getIxcRuntime } from "@/lib/integrations/ixc/runtime";

/**
 * O modo é resolvido no servidor e desce como prop: a barra superior não pode
 * anunciar "demonstração" enquanto a tela lê cadastro real do IXC. Configuração
 * inválida cai para o modo desligado em vez de derrubar a página.
 */
function resolveIxcMode() {
  try { return getIxcRuntime().config.ixcMode; } catch { return "disabled" as const; }
}

export default function Home() {
  return <LzrHubApp ixcMode={resolveIxcMode()} />;
}
