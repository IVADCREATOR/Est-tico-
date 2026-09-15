# E-mails do SORASAKI SYSTEM

## Confirmação de cadastro (OTP)

Arquivo: `EMAIL-SUPABASE-CONFIRM-SIGNUP.html`

No Supabase, abra **Authentication → Email Templates → Confirm signup** e cole o conteúdo desse arquivo no editor HTML.

O template usa:

- `{{ .Token }}` — código de confirmação enviado ao usuário.
- `{{ .Email }}` — e-mail usado no cadastro.
- `{{ .SiteURL }}` — URL configurada no projeto Supabase.

### Fluxo do site

1. A pessoa cria a conta.
2. O Supabase envia o e-mail personalizado.
3. A pessoa digita o código de confirmação no site.
4. O site chama `verifyOtp({ email, token, type: 'signup' })`.
5. Após a confirmação, a sessão é atualizada e a pessoa entra no SORASAKI.

### Assunto recomendado

`Seu código de confirmação — SORASAKI SYSTEM ✦`

> Importante: o HTML do e-mail precisa ser colado no template do Supabase. Colocar esse arquivo no GitHub/Vercel não altera automaticamente os e-mails enviados pelo Supabase.


Cadastro do site: o fluxo atual usa link de confirmação. O template de confirmação deve manter {{ .ConfirmationURL }} e o Site URL deve ser https://sorasakiplatform.store.
