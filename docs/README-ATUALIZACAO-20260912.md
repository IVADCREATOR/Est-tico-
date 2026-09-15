# Sorasaki — revisão de segurança, login e visual (12–13/09/2026)

Guia atual. Os outros READMEs desta pasta são históricos.

## Ordem para publicar

1. **Banco** — Supabase → SQL Editor → execute `docs/sql-seguranca-20260912.sql`
   (idempotente, não apaga dados; pode rodar de novo). Se ainda não rodou os
   anteriores, rode antes `sql-atualizacao-20260911.sql` e `sql-analytics-captcha.sql`.
2. **Supabase → Authentication** (detalhes abaixo): CAPTCHA com Turnstile,
   MFA (TOTP), URLs de redirecionamento e, se quiser, os modelos de e-mail.
3. **Google Cloud** — no cliente OAuth do Google, a "URI de redirecionamento
   autorizada" deve ser `https://xwrsjfxsmpuqneriptfw.supabase.co/auth/v1/callback`.
4. **Deploy** na Vercel (a pasta inteira).
5. Teste pelo celular a lista "Depois de publicar".

## Configuração no painel do Supabase

| Onde | O quê | Por quê |
| --- | --- | --- |
| Authentication → Attack Protection (Bot and Abuse Protection) | Ligar **CAPTCHA**, provedor **Turnstile**, colar a **Secret Key** do Turnstile (Cloudflare) | Hoje o Turnstile só existe na tela; sem isso dá para criar contas e tentar senhas chamando a API direto. O site já envia o token em login, cadastro, recuperação e reenvio. |
| Authentication → Multi-Factor | Deixar **TOTP** habilitado (padrão) | Verificação em duas etapas no perfil e exigida para admins que ativarem. |
| Authentication → URL Configuration | Site URL `https://www.sorasakiplatform.store`; Redirect URLs `https://www.sorasakiplatform.store/**` e `https://sorasakiplatform.store/**` | Voltar do Google e dos links de e-mail para a página certa. |
| Authentication → Attack Protection | Ligar **Leaked password protection** (se o plano permitir) | Recusa senhas que já vazaram em outros sites. |
| Authentication → Rate Limits | Conferir limites de e-mail e de login | Barreira contra spam de códigos e tentativas de senha. |
| Authentication → Providers → Google | Já está ligado. Conferir Client ID/Secret. | Login com Google. |

### Modelos de e-mail (recomendado)

O login agora usa **PKCE** (código de uso único amarrado ao navegador).
Com os modelos padrão tudo funciona **no mesmo navegador** em que a pessoa pediu
o link. Para funcionar também quando o e-mail é aberto em outro aparelho, troque o
link dos modelos por (Authentication → Email Templates):

- Confirm signup: `{{ .SiteURL }}/?token_hash={{ .TokenHash }}&type=signup`
- Reset password: `{{ .SiteURL }}/?token_hash={{ .TokenHash }}&type=recovery`
- Change email address: `{{ .SiteURL }}/?token_hash={{ .TokenHash }}&type=email_change`

O site já entende esses links (`verifyOtp` com `token_hash`).

## Variáveis na Vercel (sem mudanças)

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `MERCADOPAGO_ACCESS_TOKEN`,
`MERCADOPAGO_WEBHOOK_SECRET`, `SITE_URL=https://www.sorasakiplatform.store`.
Nenhuma chave secreta fica no `config.js` — lá só há identificadores públicos
(URL e chave publicável do Supabase, ID do Analytics, *site key* do Turnstile).

## Recursos externos e SRI

| Recurso | Antes | Agora | SRI |
| --- | --- | --- | --- |
| supabase-js | jsDelivr `@2` (arquivo gerado dinamicamente, versão flutuante) | `/vendor/supabase-js-2.116.0.js` (local, versão fixa) | Não precisa: mesmo domínio. Arquivo conferido byte a byte com o pacote oficial do npm (sha512 do npm confere). |
| Chart.js | jsDelivr `@4` | `/vendor/chart-4.5.1.umd.min.js` (local, versão fixa) | Idem. |
| Google Analytics (gtag.js) | externo | externo, carregado pelo JS | **Não aplicável**: o Google altera o arquivo sem aviso; um hash fixo quebraria o carregamento. Protegido pelo CSP (só `www.googletagmanager.com`). |
| Cloudflare Turnstile (api.js) | externo | externo, carregado pelo JS | **Não aplicável**: a Cloudflare atualiza continuamente e recomenda não fixar hash. Protegido pelo CSP (só `challenges.cloudflare.com`). |
| Fontes | locais | locais | — |

Hashes dos arquivos locais (para conferência futura):
- `supabase-js-2.116.0.js` sha384-iLddHTLokph6Omwoyid4XKxHaWa6w41BnoEj0q5oOrzmYPpHIKt1wyjReA7s//pP
- `chart-4.5.1.umd.min.js` sha384-jb8JQMbMoBUzgWatfe6COACi2ljcDdZQ2OxczGA3bGNeWe+6DChMTBJemed7ZnvJ

Para atualizar uma biblioteca: baixe a nova versão do pacote oficial, confira o
sha512 publicado no npm, salve com a versão no nome e troque o `<script>` das páginas.

## Cabeçalhos (vercel.json)

- **Content-Security-Policy** agora como cabeçalho HTTP (antes só `<meta>`):
  `script-src 'self'` + Turnstile + Google Tag Manager — **sem `'unsafe-inline'`
  e sem CDN genérico**; `frame-ancestors 'none'`; `object-src 'none'`;
  `base-uri 'self'`; `form-action 'self'`; `upgrade-insecure-requests`.
  `style-src` mantém `'unsafe-inline'` (há estilos em atributos `style=` e
  estilos aplicados por bibliotecas); o risco de CSS injetado é bem menor que o
  de script e o conteúdo dos usuários é sempre escapado.
- HSTS 2 anos com subdomínios; `X-Content-Type-Options: nosniff`;
  `X-Frame-Options: DENY`; `Referrer-Policy`; `Permissions-Policy` ampliada;
  `Cross-Origin-Opener-Policy: same-origin`; `X-Permitted-Cross-Domain-Policies: none`.
- A tela de manutenção (middleware) tem o próprio CSP sem nenhum script.

## Depois de publicar

1. securityheaders.com e observatory.mozilla.org no domínio — conferir a nota.
2. Entrar com Google pelo celular; entrar com e-mail/senha; sair.
3. Criar conta, confirmar pelo e-mail, recuperar senha.
4. Perfil → ativar verificação em duas etapas; sair e entrar de novo (pede o código).
5. Painel admin com a conta que ativou MFA (deve pedir o código antes de liberar).
6. Abrir o console do navegador (F12) em algumas páginas: nenhuma mensagem de CSP.
