/** Command failures can contain a redirect or a configured credential-bearing URL, even when
 * the requested remote passed admission. Redact before truncating or sending it across hosts. */
export const redactUrlCredentials = (text: string): string =>
  text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\r\n]*@/gi, "$1[redacted]@");
