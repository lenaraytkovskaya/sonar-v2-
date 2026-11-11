import { computeCompanyScore } from '@sonar/db/scoring';
import { boss, runTask } from '@sonar/db/tasks';

export async function registerScoringTasks() {
  await boss.createQueue('company.score');
  await runTask('company.score', async (payload, taskId) => {
    const { companyId, campaignId } = payload as {
      companyId: string;
      campaignId: string;
    };
    const result = await computeCompanyScore(companyId, campaignId, taskId);
    return result
      ? { status: 'done', result }
      : {
          status: 'skipped',
          reasonCode: 'company_missing',
          reasonUk: 'Компанію або її участь у кампанії не знайдено.',
        };
  });
}
