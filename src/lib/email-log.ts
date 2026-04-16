import { env } from 'cloudflare:workers';

const LOG_KEY = 'email_log';
const MAX_ENTRIES = 500;

export interface EmailLogEntry {
  id: string;
  sentAt: string; // ISO
  to: string;
  name: string;
  items: string;
  total: string;
  address: string;
  shippingService: string;
}

function getKV(): KVNamespace | null {
  return (env as any).INVENTORY ?? null;
}

export async function appendEmailLog(entry: Omit<EmailLogEntry, 'id' | 'sentAt'>): Promise<void> {
  const kv = getKV();
  if (!kv) return;
  const existing = await getEmailLog();
  const newEntry: EmailLogEntry = {
    id: crypto.randomUUID(),
    sentAt: new Date().toISOString(),
    ...entry,
  };
  const updated = [newEntry, ...existing].slice(0, MAX_ENTRIES);
  await kv.put(LOG_KEY, JSON.stringify(updated));
}

export async function getEmailLog(): Promise<EmailLogEntry[]> {
  const kv = getKV();
  if (!kv) return [];
  const data = await kv.get(LOG_KEY);
  if (!data) return [];
  return JSON.parse(data) as EmailLogEntry[];
}
