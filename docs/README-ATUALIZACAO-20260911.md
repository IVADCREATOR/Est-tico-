# Sorasaki — atualização de 11/09/2026

Este é o guia atual. Os outros READMEs desta pasta são históricos.

## Antes de publicar (ordem importa)

1. **Banco (Supabase → SQL Editor):** execute `docs/sql-atualizacao-20260911.sql` uma vez.
   Ele é idempotente (pode rodar de novo sem problema) e não apaga dados.
2. **Variáveis na Vercel** (Settings → Environment Variables), se ainda não existirem:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `MERCADOPAGO_ACCESS_TOKEN` e `MERCADOPAGO_WEBHOOK_SECRET` (só para os planos pagos)
   - `SITE_URL` = `https://www.sorasakiplatform.store`
3. **Supabase → Authentication → URL Configuration:**
   - Site URL: `https://www.sorasakiplatform.store`
   - Redirect URLs: adicione `https://www.sorasakiplatform.store/**` e `https://sorasakiplatform.store/**`
4. Publique (deploy) a pasta inteira.
5. Teste pelo celular a lista em "O que testar" abaixo.

## O que estava quebrado em produção

- **Todas as funções `/api` caíam ao carregar** (`FUNCTION_INVOCATION_FAILED`). O `package.json` declara
  `"type": "module"`, mas as funções usavam `require`. Por isso não funcionavam: manutenção, produtos,
  notícias, avisos, contagem de visitas, salvar configurações, lista de usuários, avaliações, foto automática
  e pagamentos. As funções foram convertidas para `import/export`.
- Página Grupos travava em "Carregando comunidades" (código procurava elementos que não existiam),
  e o link `/grupos#divulgar` não abria o formulário.
- Divulgação sem foto falhava sempre (valor `fallback` não aceito pelo banco em `avatar_status`).
- Upload manual de foto falhava para usuários comuns (pasta errada para a regra do Storage).
- "Remover" divulgação na página Grupos falhava (regra do banco só permitia status pendente).
- "Editar" em Minhas divulgações abria o formulário com descrição e link vazios.
- Painel: Excluir/Ativar de produtos, cupons, notícias e avisos não faziam nada; descrição do produto não
  era salva; datas andavam 3 horas a cada edição; grupo oficial sem imagem não salvava.
- Avaliações ficavam pendentes para sempre (não havia onde aprovar no painel).
- Feedback e relatos de bug enviados pelos usuários não apareciam no painel.
- Botão "Entrar" ficava sem resposta até uma chamada de rede terminar.
- Links com imagem dentro tinham o clique bloqueado.
- Recuperação de senha só funcionava se o modelo "Magic Link" do Supabase fosse personalizado com código
  (o modelo padrão envia apenas um link). Agora usa o fluxo de redefinição padrão, que funciona com o link
  e também aceita código, caso o modelo tenha um.
- `robots.txt`, READMEs e arquivos `.sql` estavam públicos (incluindo o esquema do banco e o endereço do painel).

## O que o SQL novo garante no servidor

- Limite diário e a chave "Aceitar novas divulgações" do painel valem no banco (antes estavam fixos em 5).
- Conta suspensa não publica divulgações.
- O dono de uma divulgação não altera visualizações, dono ou data de aprovação.
- Avaliações entram como pendentes; a equipe aprova na aba Avaliações.
- A equipe pode marcar feedback e bugs como resolvidos.
- "E-mail confirmado" acompanha o Supabase Auth.

## Onde mexer depois

- Cores, fontes e espaçamentos: variáveis no topo de `style.css`.
- E-mail e WhatsApp de contato: `config.js` (`SORASAKI_CONTACT`).
- Perguntas da assistente: `SORASAKI_FAQ` em `app.js`.
- Regras de divulgação exibidas: seção `#divulgar` em `grupos.html`.
- Imagem de compartilhamento: `og-image.jpg` (1200×630).
- Artes originais em alta resolução: `docs/imagens-originais/` (fora do deploy).

## O que testar depois de publicar

1. Abrir `/api/site-state` no navegador: deve mostrar `{"ok":true,...}` e não erro 500.
2. Criar uma conta nova, confirmar pelo e-mail e voltar conectado.
3. "Esqueci minha senha": o link do e-mail deve abrir a tela "Crie uma nova senha".
4. Divulgar um grupo sem foto e com foto enviada do celular.
5. No painel: aprovar essa divulgação, aprovar uma avaliação e ligar/desligar a manutenção.
6. Colar o link do site no WhatsApp e ver a prévia (a imagem pode levar alguns minutos para atualizar
   no cache do WhatsApp; use o link com `?v=2` no fim para forçar).
