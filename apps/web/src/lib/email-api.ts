import { uk } from '@/i18n/uk';
export async function emailResponse(action: () => Promise<unknown>) {
  try {
    const result = await action();
    return result instanceof Response ? result : Response.json(result);
  } catch (error) {
    const { EmailValidationError } = await import('@sonar/db/email');
    return Response.json(
      {
        error:
          error instanceof EmailValidationError
            ? error.reasonUk
            : uk.email.error,
      },
      { status: error instanceof EmailValidationError ? 400 : 500 },
    );
  }
}
