# Correção — salvar configurações / modo manutenção

Esta versão corrige o salvamento das configurações administrativas.

## Causa
O painel tentava fazer `upsert` diretamente pelo navegador enviando também `updated_by`. Em instalações existentes do Supabase, a tabela `site_settings` pode ter sido criada antes dessa coluna opcional existir. Nesse cenário, todas as gravações falhavam juntas e o painel mostrava a mensagem genérica sobre a migration.

## Correção
O painel agora envia as configurações para `/api/admin-settings`.
A API:
- exige um token de sessão válido;
- verifica no servidor se a conta é administradora ativa;
- valida os valores recebidos;
- grava somente `key` e `value`, mantendo compatibilidade com bancos existentes;
- não expõe a Service Role Key ao navegador;
- usa `no-store` para evitar cache do estado.

O modo de manutenção continua usando a imagem local `/sorasaki-manutencao.jpg`.

## Configuração necessária
A API depende das variáveis de ambiente do servidor já usadas pelo projeto:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Essas variáveis devem estar configuradas na Vercel. A Service Role Key não deve ser colocada no `config.js` nem no GitHub.
