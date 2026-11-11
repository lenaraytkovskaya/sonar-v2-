import { uk } from '@/i18n/uk';
export async function runAiJob(path: string, data: object) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...data, requestId: crypto.randomUUID() }),
  });
  if (!response.ok) throw Error(uk.ai.error);
  const { id } = await response.json();
  for (let i = 0; i < 45; i++) {
    const response = await fetch(`/api/ai/assist?id=${id}`);
    if (!response.ok) throw Error(uk.ai.error);
    const task = await response.json();
    if (task.status === 'done') return task.result;
    if (['failed', 'paused', 'skipped'].includes(task.status))
      throw Error(task.reason_uk ?? uk.ai.error);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw Error(uk.ai.timeout);
}
