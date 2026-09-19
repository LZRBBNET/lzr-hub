/**
 * Qual versão do código produziu uma resposta.
 *
 * Existe para que mudar o prompt, as regras de intenção ou os textos não torne o
 * passado inexplicável. Sem isso, "por que a IA disse aquilo em agosto?" fica sem
 * resposta depois do primeiro deploy — o código que respondeu já não existe.
 *
 * O Railway injeta `RAILWAY_GIT_COMMIT_SHA` no build. Fora dele a variável não
 * existe, e a resposta é **`null`**, não uma string inventada: dizer "desconhecida"
 * é honesto; dizer "local" ou "v1" seria carimbar um número falso na auditoria.
 */
export function appVersion(env: Record<string, string | undefined> = process.env): string | null {
  const sha = env.RAILWAY_GIT_COMMIT_SHA?.trim() || env.APP_VERSION?.trim();
  if (!sha) return null;
  // Sete caracteres é o que se lê e se cola num `git show` sem atrapalhar.
  return sha.slice(0, 7);
}
