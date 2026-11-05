/**
 * Story 20.8 round 3: the sample of an INVALID setting that a start-up or deploy-time message quotes. A variable
 * that looks sensitive (its name says secret, key, password, token, url, dsn, credential or auth) is never
 * echoed: the message says only that the value was hidden. Anything else is cut to 40 characters.
 */
const SENSITIVE_NAME = /SECRET|PASS|PWD|KEY|TOKEN|URL|DSN|CRED|AUTH|SALT/i;

export function safeSample(name: string, value: string): string {
  return SENSITIVE_NAME.test(name)
    ? '"[hidden]"'
    : JSON.stringify(value.slice(0, 40));
}
