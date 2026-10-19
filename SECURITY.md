# Segurança

## Como reportar uma vulnerabilidade

Não abra uma issue pública. Use o reporte privado do GitHub:
**Security → Report a vulnerability** neste repositório
(<https://github.com/acacio90/MultTerm/security/advisories/new>).

Descreva o problema, a versão do MultTerm e, se puder, os passos para reproduzir. A resposta
vem pelo próprio aviso; a correção sai numa versão nova, e o aviso é publicado depois dela.

## Versões com correções

Só a versão mais recente recebe correções de segurança. O MultTerm avisa quando há uma versão
nova (Ajuda → Verificar atualizações).

## Checagens automáticas

- **Dependabot**: alertas de dependências vulneráveis e atualizações semanais (npm e GitHub
  Actions).
- **CodeQL**: análise do código (JavaScript/TypeScript e workflows) em todo PR.
- **zizmor**: análise de segurança dos workflows do GitHub Actions.
- **Secret scanning** com bloqueio de push de credenciais.
