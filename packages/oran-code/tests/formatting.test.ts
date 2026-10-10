import { describe, expect, it } from "vitest";
import { redactSecretText } from "../src/formatting.js";

/**
 * Redaction runs on the way into the transcript, and the transcript is persisted
 * with the session, so a miss here is a secret written to disk.
 *
 * The fixtures are assembled from parts rather than written out. A literal one is
 * a secret-scanning false positive — GitHub's push protection refused this very
 * file over the Slack-shaped entry — and the assertions are about the shape, not
 * about any particular value.
 */
const part = (...pieces: string[]): string => pieces.join("");

const SECRETS = [
  part("ghp_", "A1b2C3d4E5f6G7h8", "I9j0K1l2M3n4O5p6Q7r8"),
  part("github_pat_", "11ABCDEFG0aBcDeFgHiJkL", "_1a2B3c4D5e6F7g8H9i0J1k2L3m4N5o6P"),
  part("AKIA", "IOSFODNN7EXAMPLE"),
  part("AIza", "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6q"),
  part("xoxb-", "123456789012-", "abcdefghijklmnop"),
  part("sk-", "abcdefghijklmnopqrstuvwx"),
];

const SHAPES: Array<[string, (secret: string) => string]> = [
  ["unquoted assignment", (secret) => `GITHUB_TOKEN=${secret}`],
  ["double-quoted assignment", (secret) => `GITHUB_TOKEN="${secret}"`],
  ["single-quoted pair", (secret) => `password: '${secret}'`],
  ["JSON field", (secret) => `{"api_key": "${secret}"}`],
  ["authorization header", (secret) => `Authorization: Bearer ${secret}`],
];

describe("secret redaction", () => {
  it("redacts a secret in every shape it can be written in", () => {
    for (const secret of SECRETS) {
      for (const [label, shape] of SHAPES) {
        const redacted = redactSecretText(shape(secret));
        expect(redacted, `${label}: ${redacted}`).not.toContain(secret);
      }
    }
  });

  it("keeps the key so the reader can still tell what was redacted", () => {
    expect(redactSecretText(`GITHUB_TOKEN="${SECRETS[0]!}"`)).toBe('GITHUB_TOKEN="[redacted]"');
    expect(redactSecretText("apiKey: hunter2secret")).toBe("apiKey: [redacted]");
  });

  it("leaves ordinary text alone", () => {
    const text = "the token bucket refills; see the api_key section of the docs";
    expect(redactSecretText(text)).toBe(text);
  });
});
