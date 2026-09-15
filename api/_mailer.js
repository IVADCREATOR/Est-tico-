import nodemailer from 'nodemailer';
import { CODIGO_SEGURANCA_BANNER_JPG_BASE64 } from './_email-assets.js';

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  // Resend SMTP
  // Se SMTP_HOST/USER/PASS estiverem configurados manualmente,
  // eles continuam tendo prioridade.
  const host = String(process.env.SMTP_HOST || 'smtp.resend.com').trim();

  const port = Number(process.env.SMTP_PORT || 465);

  const secure = String(
    process.env.SMTP_SECURE || (port === 465 ? 'true' : 'false')
  ).toLowerCase() === 'true';

  const user = String(
    process.env.SMTP_USER || 'resend'
  ).trim();

  // No SMTP do Resend, a senha é a API Key.
  // Aceita tanto SMTP_PASS quanto RESEND_API_KEY.
  const pass = String(
    process.env.SMTP_PASS || process.env.RESEND_API_KEY || ''
  ).trim();

  if (!pass) {
    throw new Error(
      'SMTP não configurado: defina SMTP_PASS ou RESEND_API_KEY na Vercel.'
    );
  }

  transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user,
      pass
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000
  });

  return transporter;
}

function escapeHtml(value) {
  return String(value || '').replace(
    /[&<>"']/g,
    (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[char]
  );
}

const MOTIVOS = {
  login: 'para confirmar que é você entrando na sua conta Sorasaki.',
  signup: 'para confirmar seu e-mail e concluir seu cadastro no Sorasaki.',
  'password-reset': 'para redefinir a senha da sua conta Sorasaki.',
  enroll: 'para ativar a verificação por e-mail na sua conta Sorasaki.',
  disable: 'para desativar a verificação por e-mail na sua conta Sorasaki.'
};

function templateCodigoSeguranca({
  codigo,
  nomeUsuario,
  minutosValidade,
  purpose
}) {
  const nome = escapeHtml(nomeUsuario || '');
  const motivo = MOTIVOS[purpose] || MOTIVOS.login;
  const saudacao = nome ? `Oi, ${nome}.` : 'Oi.';
  const minutos = Number(minutosValidade) || 10;

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Código de segurança — Sorasaki</title>
</head>

<body style="margin:0;padding:0;background:#0c0b10;font-family:Arial,Helvetica,sans-serif;">

  <table role="presentation" width="100%" cellspacing="0" cellpadding="0"
    style="background:#0c0b10;padding:32px 0;">
    <tr>
      <td align="center">

        <table role="presentation" width="600" cellspacing="0" cellpadding="0"
          style="max-width:92%;background:#15141b;border:1px solid rgba(255,255,255,.08);border-radius:16px;overflow:hidden;">

          <tr>
            <td>
              <img
                src="cid:sorasaki-codigo-banner"
                width="600"
                alt="Sorasaki"
                style="display:block;width:100%;max-width:600px;height:auto;border:0;"
              >
            </td>
          </tr>

          <tr>
            <td style="padding:32px;color:#e8e6ef;font-size:15px;line-height:1.6;">

              <p style="margin:0 0 6px;text-align:center;text-transform:uppercase;letter-spacing:.12em;font-size:11px;color:#8a83a3;">
                Verificação de segurança
              </p>

              <p style="margin:0 0 16px;text-align:center;font-size:19px;font-weight:700;color:#f1eefb;">
                Seu código de segurança
              </p>

              <p style="margin:0 0 6px;">
                ${saudacao}
              </p>

              <p style="margin:0 0 20px;">
                Use o código abaixo ${escapeHtml(motivo)}
              </p>

              <p style="text-align:center;margin:0 0 20px;">
                <span style="display:inline-block;background:#1b1a22;border:1px solid rgba(185,161,255,.4);border-radius:12px;padding:16px 28px;font-size:32px;font-weight:700;letter-spacing:.3em;color:#b9a1ff;">
                  ${escapeHtml(codigo)}
                </span>
              </p>

              <table role="presentation" width="100%" cellspacing="0" cellpadding="0"
                style="margin:0 0 20px;border:1px solid rgba(185,161,255,.25);border-radius:12px;">

                <tr>
                  <td style="padding:14px 16px;color:#bdb9c8;font-size:13px;width:50%;border-right:1px solid rgba(255,255,255,.08);">
                    🛡️ Este código expira em
                    <strong style="color:#e8e6ef;">
                      ${minutos} minutos
                    </strong>.
                  </td>

                  <td style="padding:14px 16px;color:#bdb9c8;font-size:13px;width:50%;">
                    🔒 Nunca compartilhe este código com ninguém.
                  </td>
                </tr>

              </table>

              <p style="margin:0;color:#8a83a3;font-size:13px;">
                Se você não solicitou este código, pode ignorar este e-mail com segurança.
                Sua conta continua protegida. O Sorasaki nunca solicita esse código por
                WhatsApp, telefone ou qualquer outro canal.
              </p>

            </td>
          </tr>

          <tr>
            <td style="padding:20px 32px;border-top:1px solid rgba(255,255,255,.08);color:#666075;font-size:12px;">
              <span>noreply@sorasakiplatform.store</span>
              <span style="float:right;">
                © ${new Date().getFullYear()} Sorasaki. Todos os direitos reservados.
              </span>
            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>

</body>
</html>`;
}

export async function enviarCodigoSeguranca({
  to,
  nomeUsuario,
  codigo,
  minutosValidade,
  purpose
}) {
  if (!to || !codigo) {
    throw new Error('destinatário ou código de segurança ausente');
  }

  const t = getTransporter();

  const from =
    String(process.env.SMTP_FROM || '').trim() ||
    'Sorasaki <noreply@sorasakiplatform.store>';

  await t.sendMail({
    from,
    to: String(to).trim(),

    subject: `${codigo} é o seu código de segurança do Sorasaki`,

    text:
      `Seu código de segurança Sorasaki: ${codigo}\n\n` +
      `Este código vale por ${Number(minutosValidade) || 10} minutos ` +
      `e só pode ser usado uma vez.\n\n` +
      `Nunca compartilhe esse código.`,

    html: templateCodigoSeguranca({
      codigo,
      nomeUsuario,
      minutosValidade,
      purpose
    }),

    attachments: [
      {
        filename: 'sorasaki.jpg',
        content: Buffer.from(
          CODIGO_SEGURANCA_BANNER_JPG_BASE64,
          'base64'
        ),
        cid: 'sorasaki-codigo-banner',
        contentDisposition: 'inline'
      }
    ]
  });
}
