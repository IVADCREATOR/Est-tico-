import { supabaseRequest, requireAdmin, readJsonBody, sendJson, serverError, originAllowed, rateLimit } from './_supabase.js';

const KEYS = new Set([
  'max_group_submissions_per_24h',
  'community_submissions_enabled',
  'maintenance_mode',
  'maintenance_start_at',
  'maintenance_title',
  'maintenance_message',
  'maintenance_return_at'
]);

// Erros de validação carregam uma mensagem que pode ir para a tela.
class ValidationError extends Error {}

function cleanValue(key, value) {
  if (key === 'max_group_submissions_per_24h') {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 50) {
      throw new ValidationError(
        'O limite de divulgações precisa estar entre 1 e 50.'
      );
    }

    return n;
  }

  if (
    key === 'community_submissions_enabled' ||
    key === 'maintenance_mode'
  ) {
    if (typeof value !== 'boolean') {
      throw new ValidationError(
        'Valor inválido para uma das opções.'
      );
    }

    return value;
  }

  if (
    key === 'maintenance_start_at' ||
    key === 'maintenance_return_at'
  ) {
    // site_settings.value é jsonb NOT NULL.
    // Por isso, não podemos enviar null como valor SQL.
    // String vazia representa "sem data" e continua sendo um JSON válido.
    if (value === null || value === '') {
      return '';
    }

    const d = new Date(value);

    if (Number.isNaN(d.getTime())) {
      throw new ValidationError(
        'Confira as datas da manutenção.'
      );
    }

    return d.toISOString();
  }

  if (key === 'maintenance_title') {
    const text = String(value ?? '').trim();

    if (text.length > 120) {
      throw new ValidationError(
        'O título da manutenção é muito longo.'
      );
    }

    return text || 'Estamos em manutenção';
  }

  if (key === 'maintenance_message') {
    const text = String(value ?? '').trim();

    if (text.length > 1000) {
      throw new ValidationError(
        'A mensagem da manutenção é muito longa.'
      );
    }

    return (
      text ||
      'O site está passando por algumas melhorias no momento.'
    );
  }

  throw new ValidationError(
    'Configuração não permitida.'
  );
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'PUT') {
    res.setHeader('Allow', 'PUT');

    return sendJson(res, 405, {
      ok: false,
      message: 'Essa ação não funciona desse jeito. Atualize a página e tente de novo.'
    });
  }

  if (!originAllowed(req)) {
    return sendJson(res, 403, {
      ok: false,
      message: 'Ação não permitida.'
    });
  }

  try {
    const admin = await requireAdmin(req);

    if (!admin) {
      return sendJson(res, 403, {
        ok: false,
        message:
          'Você não tem permissão para esta ação. Se a verificação em duas etapas estiver ativa, confirme o código no painel.'
      });
    }

    if (!rateLimit(`settings:${admin.id}`, 30, 60_000)) {
      return sendJson(res, 429, {
        ok: false,
        message:
          'Muitas alterações seguidas. Aguarde um instante.'
      });
    }

    const body = readJsonBody(req) || {};

    const entries = Object.entries(body).filter(([key]) =>
      KEYS.has(key)
    );

    if (!entries.length) {
      return sendJson(res, 400, {
        ok: false,
        message: 'Nenhuma alteração foi enviada.'
      });
    }

    // Só usa key/value. Isso mantém compatibilidade com instalações antigas
    // onde colunas opcionais como updated_by ainda não existiam.
    const rows = entries.map(([key, value]) => ({
      key,
      value: cleanValue(key, value)
    }));

    const saved = await supabaseRequest(
      '/rest/v1/site_settings?on_conflict=key',
      {
        method: 'POST',
        headers: {
          Prefer:
            'resolution=merge-duplicates,return=representation'
        },
        body: JSON.stringify(rows)
      }
    );

    return sendJson(res, 200, {
      ok: true,
      settings: saved
    });
  } catch (error) {
    if (error instanceof ValidationError) {
      return sendJson(res, 400, {
        ok: false,
        message: error.message
      });
    }

    return serverError(
      res,
      error,
      'admin-settings',
      'Não foi possível salvar as configurações agora. Tente novamente.'
    );
  }
}
