import { z } from 'zod';

// The person an alert card lets you reach — the client of a converted CRM lead. The app shows
// WhatsApp + Call buttons for it; the push text never carries it, so no client number lands on a
// lock screen (alert.push only ever sends title + body).
export interface AlertContact { name?: string; phone: string }

// "+91 98765-43210" / "0091 98765 43210" → "+919876543210". WhatsApp links need the full
// international number, so anything that is not then E.164-shaped (+, 8–15 digits, no leading 0)
// is refused rather than guessed at — a bare "9876543210" could be any country.
export function e164(raw: string | null | undefined): string | null {
  let s = String(raw ?? '').replace(/[\s().-]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  return /^\+[1-9]\d{7,14}$/.test(s) ? s : null;
}

// Ingest shape: { name?, phone } with the phone normalised to E.164 — a number that cannot be
// made E.164 fails the request loudly (the CRM checks with the same rule before sending).
export const contactSchema = z.object({
  name: z.string().trim().max(120).optional(),
  phone: z.string().max(32).transform((v, ctx) => {
    const p = e164(v);
    if (!p) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'contact.phone must be an international number, e.g. +919876543210' });
      return z.NEVER;
    }
    return p;
  }),
});
