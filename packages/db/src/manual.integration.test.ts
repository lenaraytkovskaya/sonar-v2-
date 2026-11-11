import { randomUUID } from 'node:crypto';
import { afterAll, expect, it, vi } from 'vitest';
const enabled = process.env.RUN_DB_TESTS === '1';

it.skipIf(!enabled)(
  'manual entries enforce DNC, preserve provenance, audit deletion and enrich without a batch',
  async () => {
    const { sonarPool } = await import('./index.js');
    const manual = await import('./companies.js');
    const tasks = await import('./tasks.js');
    const { computeCompanyScore } = await import('./scoring.js');
    const { runSiteScan } = await import('../../../apps/worker/src/site.js');
    const { runRegistryMatch } =
      await import('../../../apps/worker/src/registry.js');
    const { SiteHttp } = await import('../../../apps/worker/src/site-http.js');
    const { PgBoss } = await import('pg-boss');
    const admin = new PgBoss(process.env.DATABASE_URL!);
    const userId = randomUUID(),
      campaignId = randomUUID(),
      ids: string[] = [];
    const email = `team@${userId}.test`;
    const mock = vi
      .spyOn(SiteHttp.prototype, 'read')
      .mockImplementation(async (url) => ({
        url,
        status: new URL(url).pathname === '/sitemap.xml' ? 404 : 200,
        body: Buffer.from(
          `<html><body><a href="mailto:${email}">Mail</a><a href="tel:512345678">Phone</a><a href="https://t.me/sonar_test">Telegram</a></body></html>`,
        ),
        contentType: 'text/html',
      }));
    try {
      await admin.start();
      for (const name of [
        'site.scan',
        'registry.match',
        'company.score',
        'company.analyze',
      ])
        await admin.createQueue(name);
      await sonarPool.query(
        "insert into users(id,email,name,password_hash) values($1,$2,'Manual test','unusable')",
        [userId, `${userId}@sonar.test`],
      );
      await sonarPool.query(
        "insert into campaigns(id,name,country_code,language_code,cities,queries,offer,batch_size,budget_usd,channels,scoring_weights) values($1,$2,'UA','uk','{}','{}','',20,.5,'{}','{\"email\":1}')",
        [campaignId, userId],
      );
      const input = {
        campaignId,
        name: userId,
        countryCode: 'PL',
        website: `https://${userId}.test/`,
      };
      const company = await manual.createManualCompany(input, userId);
      ids.push(company.id);
      expect(company).toMatchObject({
        status: 'new',
        country_code: 'PL',
        domain: `${userId}.test`,
      });
      expect(company.place_id).toMatch(/^manual:/);
      expect((await manual.getCompany(company.id))?.campaigns).toMatchObject([
        { id: campaignId, batch_id: null },
      ]);
      await expect(
        manual.createManualCompany(
          { ...input, name: 'Duplicate domain' },
          userId,
        ),
      ).rejects.toMatchObject({ code: 'duplicateCompany' });
      await expect(
        manual.createManualCompany({ ...input, website: '' }, userId),
      ).rejects.toMatchObject({ code: 'duplicateCompany' });
      await expect(
        manual.createManualCompany(
          { ...input, name: randomUUID(), campaignId: randomUUID() },
          userId,
        ),
      ).rejects.toMatchObject({ code: 'campaignNotFound' });
      const phone = await manual.addManualContact(
        company.id,
        { kind: 'phone', value: '512 345 678', note: 'From colleague' },
        userId,
      );
      expect(phone).toMatchObject({
        normalized: '+48512345678',
        source: 'manual',
        meta: { created_by: userId, note: 'From colleague' },
      });
      expect(phone.found_at).toBeInstanceOf(Date);
      await expect(
        manual.addManualContact(
          company.id,
          { kind: 'phone', value: '+48 512345678' },
          userId,
        ),
      ).rejects.toMatchObject({ code: 'duplicateContact' });
      await expect(
        manual.addManualContact(
          company.id,
          { kind: 'phone', value: '123' },
          userId,
        ),
      ).rejects.toMatchObject({ code: 'invalidContact' });
      await sonarPool.query(
        "insert into do_not_contact(kind,value_normalized,reason) values('email',$1,'Відмова контакту')",
        [email],
      );
      await expect(
        manual.addManualContact(
          company.id,
          { kind: 'email', value: email.toUpperCase() },
          userId,
        ),
      ).rejects.toMatchObject({
        code: 'contactBlocked',
        reasonUk: 'Відмова контакту',
      });
      await sonarPool.query(
        'delete from do_not_contact where value_normalized=$1',
        [email],
      );
      for (const kind of ['company', 'domain']) {
        await sonarPool.query(
          "insert into do_not_contact(company_id,kind,value_normalized,reason) values($1,$2,$3,'Відмова компанії')",
          [null, kind, kind === 'company' ? company.id : company.domain],
        );
        await expect(
          manual.addManualContact(
            company.id,
            { kind: 'email', value: email },
            userId,
          ),
        ).rejects.toMatchObject({ code: 'contactBlocked' });
        await sonarPool.query(
          'delete from do_not_contact where value_normalized=$1',
          [kind === 'company' ? company.id : company.domain],
        );
      }
      await sonarPool.query(
        "update companies set status='refused' where id=$1",
        [company.id],
      );
      await expect(
        manual.addManualContact(
          company.id,
          { kind: 'email', value: email },
          userId,
        ),
      ).rejects.toMatchObject({ code: 'contactBlocked' });
      await sonarPool.query("update companies set status='new' where id=$1", [
        company.id,
      ]);
      const mail = await manual.addManualContact(
        company.id,
        { kind: 'email', value: email.toUpperCase(), note: 'Keep provenance' },
        userId,
      );
      const noWebsite = await manual.createManualCompany(
        { name: `${userId}-offline`, website: '', campaignId },
        userId,
      );
      ids.push(noWebsite.id);
      expect(noWebsite).toMatchObject({ country_code: 'UA', website: null });
      for (const id of ids) {
        await tasks.enqueueEnrichment(id, userId);
        if (id === company.id) {
          const {
            rows: [scan],
          } = await sonarPool.query(
            "select id from tasks where subject_id=$1 and type='site.scan'",
            [id],
          );
          expect(await runSiteScan({ companyId: id }, scan.id)).toMatchObject({
            status: 'done',
          });
          await sonarPool.query("update tasks set status='done' where id=$1", [
            scan.id,
          ]);
          await tasks.continueEnrichment(id);
        }
        const {
          rows: [match],
        } = await sonarPool.query(
          "select id from tasks where subject_id=$1 and type='registry.match'",
          [id],
        );
        expect(
          await runRegistryMatch({ companyId: id }, match.id),
        ).toMatchObject({ status: 'skipped' });
        await sonarPool.query("update tasks set status='skipped' where id=$1", [
          match.id,
        ]);
        await tasks.finishEnrichment(id);
        const {
          rows: [score],
        } = await sonarPool.query(
          "select id from tasks where subject_id=$1 and type='company.score'",
          [id],
        );
        expect(
          await computeCompanyScore(id, campaignId, score.id),
        ).not.toBeNull();
        expect((await manual.getCompany(id))?.company.status).toBe('ready');
      }
      const detail = await manual.getCompany(company.id);
      expect(detail?.contacts.filter((c) => c.kind === 'phone')).toMatchObject([
        { id: phone.id, normalized: '+48512345678', source: 'manual' },
      ]);
      expect(detail?.contacts.find((c) => c.id === mail.id)).toMatchObject({
        source: 'manual',
        meta: {
          created_by: userId,
          note: 'Keep provenance',
          alsoOnWebsite: company.website,
        },
      });
      const automatic = detail!.contacts.find((c) => c.source === 'website')!;
      await expect(
        manual.deleteManualContact(company.id, automatic.id, userId),
      ).rejects.toMatchObject({ code: 'manualOnly' });
      await manual.deleteManualContact(company.id, phone.id, userId);
      await expect(
        manual.deleteManualContact(company.id, phone.id, userId),
      ).rejects.toMatchObject({ code: 'contactNotFound' });
      expect((await manual.getCompany(company.id))?.history).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: 'contact.manual.deleted',
            user_name: 'Manual test',
            details: expect.objectContaining({ contactId: phone.id }),
          }),
        ]),
      );
    } finally {
      mock.mockRestore();
      await sonarPool.query(
        'delete from do_not_contact where value_normalized=any($1::text[])',
        [[email, ...ids, `${userId}.test`]],
      );
      await sonarPool.query(
        "delete from pgboss.job where data->>'taskId' in(select id::text from tasks where subject_id=any($1::text[]))",
        [ids],
      );
      await sonarPool.query(
        'delete from tasks where subject_id=any($1::text[])',
        [ids],
      );
      for (const table of [
        'analyses',
        'company_scores',
        'contacts',
        'company_facts',
        'do_not_contact',
        'campaign_companies',
      ])
        await sonarPool.query(
          `delete from ${table} where company_id=any($1::uuid[])`,
          [ids],
        );
      await sonarPool.query(
        'delete from activity_log where entity_id=any($1::text[]) or user_id=$2',
        [ids, userId],
      );
      await sonarPool.query('delete from companies where id=any($1::uuid[])', [
        ids,
      ]);
      await sonarPool.query('delete from campaigns where id=$1', [campaignId]);
      await sonarPool.query('delete from users where id=$1', [userId]);
      await admin.stop();
    }
  },
  30000,
);

afterAll(async () => {
  if (!enabled) return;
  const { closeTaskQueue } = await import('./tasks.js');
  const { sonarPool, registryPool } = await import('./index.js');
  await closeTaskQueue();
  await Promise.all([sonarPool.end(), registryPool.end()]);
});
