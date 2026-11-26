import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Política de Privacidade — BBNET",
  description: "Como a BBNET trata os dados de quem fala com a empresa pelo WhatsApp.",
};

// Página pública (sem login): a Meta exige uma URL de política de privacidade
// para aprovar o app. O texto descreve o que o sistema de fato faz — se o
// tratamento de dados mudar (novo provedor, novo prazo), esta página muda junto.
const CONTATO = "marketing@bbnetup.com.br";

const secao = { marginTop: 28 } as const;
const lista = { margin: "8px 0 0", paddingLeft: 20, color: "var(--text-2)" } as const;

export default function PrivacidadePage() {
  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "40px 20px 64px" }}>
      <h1 style={{ fontSize: 26 }}>Política de Privacidade</h1>
      <p className="muted" style={{ marginTop: 6 }}>BBNET — atualizada em 26/11/2026</p>

      <p style={{ marginTop: 20, color: "var(--text-2)" }}>
        A BBNET é um provedor de internet. Esta página explica quais dados pessoais tratamos quando você fala com a
        gente pelo WhatsApp e como cuidamos deles, conforme a Lei Geral de Proteção de Dados (LGPD, Lei 13.709/2018).
      </p>

      <section style={secao}>
        <h2 style={{ fontSize: 18 }}>Quais dados tratamos</h2>
        <ul style={lista}>
          <li>Seu número de telefone e o nome do perfil do WhatsApp.</li>
          <li>O conteúdo das mensagens que você envia e das respostas que recebe (texto e a transcrição de áudios).</li>
          <li>Dados do seu cadastro de cliente da BBNET, quando o seu número identifica o cadastro: situação do contrato, faturas e chamados.</li>
          <li>O CPF ou CNPJ que você digita para confirmar que é o titular. Ele é conferido e não fica gravado no atendimento.</li>
        </ul>
      </section>

      <section style={secao}>
        <h2 style={{ fontSize: 18 }}>Para que usamos</h2>
        <ul style={lista}>
          <li>Atender o seu pedido: fatura e segunda via, falta de conexão, lentidão, planos e contratação.</li>
          <li>Registrar o atendimento com um número de protocolo.</li>
          <li>Enviar avisos sobre a sua conta: cobrança e avisos de rede ou manutenção no seu bairro. Para parar de receber, responda SAIR.</li>
          <li>Garantir segurança e auditar o que o atendimento automático e a equipe fizeram.</li>
        </ul>
      </section>

      <section style={secao}>
        <h2 style={{ fontSize: 18 }}>Atendimento automático</h2>
        <p style={{ marginTop: 8, color: "var(--text-2)" }}>
          Parte do atendimento é feita por um assistente virtual. Para entender o seu pedido, o texto da conversa pode ser
          enviado a um provedor de inteligência artificial, sem e-mail, CPF ou telefone. Quando a mensagem é um áudio, o
          áudio é enviado para ser transcrito e não é guardado. Pedimos que o assistente não afirme nada que não tenha
          sido feito, e você pode pedir para falar com uma pessoa da equipe.
        </p>
      </section>

      <section style={secao}>
        <h2 style={{ fontSize: 18 }}>Com quem compartilhamos</h2>
        <ul style={lista}>
          <li>Meta (WhatsApp), que transporta as mensagens.</li>
          <li>Provedores de hospedagem e de inteligência artificial que operam o sistema a nosso serviço.</li>
          <li>Não vendemos dados pessoais.</li>
        </ul>
      </section>

      <section style={secao}>
        <h2 style={{ fontSize: 18 }}>Por quanto tempo guardamos</h2>
        <p style={{ marginTop: 8, color: "var(--text-2)" }}>
          Guardamos o histórico do atendimento enquanto você for cliente e pelo prazo que a lei e a regulação do setor de
          telecomunicações exigem. Depois disso, apagamos ou anonimizamos.
        </p>
      </section>

      <section style={secao}>
        <h2 style={{ fontSize: 18 }}>Seus direitos</h2>
        <p style={{ marginTop: 8, color: "var(--text-2)" }}>
          Você pode pedir acesso, correção, anonimização ou exclusão dos seus dados, e saber com quem os compartilhamos.
          Escreva para <a href={`mailto:${CONTATO}`}>{CONTATO}</a> informando o número de telefone usado no WhatsApp.
          Respondemos pelo mesmo canal. Algumas informações precisam ser mantidas por obrigação legal, e nesse caso
          explicamos o motivo.
        </p>
      </section>

      <section style={secao}>
        <h2 style={{ fontSize: 18 }}>Contato</h2>
        <p style={{ marginTop: 8, color: "var(--text-2)" }}>
          Dúvidas sobre esta política: <a href={`mailto:${CONTATO}`}>{CONTATO}</a>.
        </p>
      </section>
    </main>
  );
}
