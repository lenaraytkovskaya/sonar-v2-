import {
  withSocialCredentialLogin,
  reconcileSocialCredentialLogins,
} from '@sonar/db/social-accounts';
import { boss, runTask } from '@sonar/db/tasks';
import { socialPageTimeout } from './social-send.js';
import { socialLoginBrowser } from './social-login-browser.js';

export async function runSocialCredentialLogin(
  input: { accountId: string },
  taskId: string,
) {
  return withSocialCredentialLogin(
    input.accountId,
    taskId,
    async (account, session, credentials, challenge) =>
      socialLoginBrowser.login(
        account,
        session,
        credentials,
        challenge,
        await socialPageTimeout(),
      ),
  );
}
export async function registerSocialCredentialLoginTasks() {
  await boss.createQueue('social.session.login');
  await boss.createQueue('social.session.login.reconcile');
  await boss.work('social.session.login.reconcile', async () => {
    await reconcileSocialCredentialLogins();
  });
  await boss.schedule('social.session.login.reconcile', '* * * * *');
  await reconcileSocialCredentialLogins();
  await runTask('social.session.login', (payload, taskId) =>
    runSocialCredentialLogin(payload as { accountId: string }, taskId),
  );
}
export const closeSocialLoginBrowser = () => socialLoginBrowser.close();
