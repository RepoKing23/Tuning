import type { TableData } from '../rom/readTable';
import type { Recommendation } from '../tune/types';
import { PROFILES } from '../tune/profiles';
import type { ProfileId } from '../tune/profiles';

/**
 * Optional Claude layer.
 *
 * Every number in this app comes from the deterministic engine in `lib/tune`.
 * This layer only explains those numbers in plain English and answers questions
 * about them. That split is deliberate: recommendations stay reproducible — the
 * same log and the same table always give the same cells — while the language
 * model does the part it is actually good at.
 *
 * The key is yours, stored in this browser's localStorage and sent only to
 * Anthropic. The ROM is never transmitted; the request carries the computed
 * summary and at most a few dozen changed cells.
 */

const KEY_STORAGE = '4b11-tuner.anthropic-key';
const MODEL = 'claude-sonnet-5';
const ENDPOINT = 'https://api.anthropic.com/v1/messages';

export function getApiKey(): string {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? '';
  } catch {
    return '';
  }
}

export function setApiKey(key: string): void {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
  } catch {
    /* private browsing; the key just will not persist */
  }
}

export interface ExplainRequest {
  table: TableData;
  recommendation: Recommendation;
  profile?: ProfileId;
  /** Health problems worth mentioning in the explanation. */
  healthNotes: string[];
  /** A free-form question instead of the default explanation. */
  question?: string;
}

/** Compact, human-readable summary of what the engine decided and why. */
function buildContext(req: ExplainRequest): string {
  const { table, recommendation } = req;
  const lines: string[] = [];

  lines.push(`Vehicle: Mitsubishi 4B11 2.0 NA, EcuFlash ROM, EvoScan logging.`);
  lines.push(`Table: ${table.def.name} (${table.ny} x ${table.nx}, units ${table.units || 'raw'}).`);
  lines.push(`Y axis ${table.y.name} ${table.y.units}, X axis ${table.x.name} ${table.x.units}.`);
  if (req.profile) {
    const p = PROFILES[req.profile];
    lines.push(`Profile: ${p.label} — ${p.description}`);
  }
  lines.push(`Engine verdict: ${recommendation.message}`);
  if (recommendation.notes.length) {
    lines.push('Engine notes:');
    for (const n of recommendation.notes) lines.push(`- ${n}`);
  }
  if (req.healthNotes.length) {
    lines.push('Datalog health problems:');
    for (const n of req.healthNotes) lines.push(`- ${n}`);
  }

  const entries = [...req.recommendation.suggestions.entries()];
  if (entries.length) {
    lines.push(`Suggested cells (${entries.length} total, up to 40 shown):`);
    for (const [key, s] of entries.slice(0, 40)) {
      const [r, c] = key.split(',').map(Number);
      const y = table.y.labels[r] ?? r;
      const x = table.nx > 1 ? ` / ${table.x.name} ${table.x.labels[c] ?? c}` : '';
      lines.push(
        `- ${table.y.name} ${y}${x}: ${table.values[r][c]} -> ${s.value} ` +
          `(${s.delta >= 0 ? '+' : ''}${s.delta.toFixed(1)}), ${s.samples} samples, ` +
          `${s.knock} knock, confidence ${(s.confidence * 100).toFixed(0)}%. ${s.reason}`,
      );
    }
  }

  return lines.join('\n');
}

const SYSTEM_PROMPT = `You are helping someone tune a Mitsubishi 4B11 engine.

A deterministic analysis engine has already computed the numbers from their
datalogs. Your job is to explain that reasoning clearly and flag anything that
should give them pause.

Rules:
- Do not propose different cell values. The numbers are already computed; if you
  think one is wrong, say why rather than substituting your own.
- Be specific about which regions of the map changed and what driving that
  corresponds to.
- Call out risk plainly: knock, lean conditions, exhaust damage from overrun
  retard, and any datalog channel that is broken enough to undermine the result.
- Be concise. A few short paragraphs, no preamble, no bullet-point padding.`;

export async function explainRecommendation(req: ExplainRequest): Promise<string> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('No API key set.');

  const context = buildContext(req);
  const question = req.question?.trim()
    ? `${context}\n\nQuestion: ${req.question.trim()}`
    : `${context}\n\nExplain what these changes do and what to watch for on the next drive.`;

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1200,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: question }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 401) throw new Error('Anthropic rejected the API key (401).');
    throw new Error(`Anthropic API error ${res.status}: ${body.slice(0, 300)}`);
  }

  const json = (await res.json()) as { content?: { type: string; text?: string }[] };
  const text = (json.content ?? [])
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text)
    .join('\n')
    .trim();
  return text || '(empty response)';
}

export { buildContext };
