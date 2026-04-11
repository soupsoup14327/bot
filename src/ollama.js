/**
 * Calls a local Ollama server (default: llama3.1:8b).
 * @see https://github.com/ollama/ollama/blob/main/docs/api.md
 */
export async function chatOllama(userText, systemPrompt) {
  const base = process.env.OLLAMA_URL?.replace(/\/$/, '') || 'http://127.0.0.1:11434';
  const model = process.env.OLLAMA_MODEL || 'llama3.1:8b';
  const messages = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: userText });

  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Ollama HTTP ${res.status}: ${t.slice(0, 500)}`);
  }
  const data = await res.json();
  const text = data?.message?.content?.trim();
  if (!text) throw new Error('Пустой ответ от Ollama');
  return text;
}
