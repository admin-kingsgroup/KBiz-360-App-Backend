import nodemailer, { type Transporter } from 'nodemailer';

// Outgoing system email (task notifications, the 8 am digest). SMTP with the same env names the ERP
// uses (SMTP_HOST / SMTP_PORT / SMTP_SECURE / SMTP_USER / SMTP_PASS, MAIL_FROM), so one mailbox can
// serve both. Dormant without SMTP_HOST: send() logs and returns false instead of pretending to send.
const env = (k: string): string => (process.env[k] || '').trim();

let transport: Transporter | null = null;
function getTransport(): Transporter {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: env('SMTP_HOST'),
      port: Number(env('SMTP_PORT')) || 587,
      secure: env('SMTP_SECURE') === 'true',
      auth: env('SMTP_USER') ? { user: env('SMTP_USER'), pass: env('SMTP_PASS') } : undefined,
    });
  }
  return transport;
}

export interface MailInput { to: string; subject: string; text: string; html?: string }

export const mailer = {
  isConfigured: (): boolean => !!env('SMTP_HOST'),
  async send(m: MailInput): Promise<boolean> {
    if (!m.to) return false;
    if (!env('SMTP_HOST')) {
      // eslint-disable-next-line no-console
      console.log(`[mailer] dormant (no SMTP_HOST) — would send "${m.subject}" to ${m.to}`);
      return false;
    }
    try {
      await getTransport().sendMail({ from: env('MAIL_FROM') || env('SMTP_USER'), to: m.to, subject: m.subject, text: m.text, html: m.html });
      return true;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[mailer] send error:', (e as Error).message);
      return false;
    }
  },
};
