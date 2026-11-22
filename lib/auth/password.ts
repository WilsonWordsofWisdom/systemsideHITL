import { hash, verify } from "@node-rs/argon2";

// A real hash to verify against when the email is unknown, so a missing account
// takes about as long as a wrong password and the response reveals nothing.
let dummyHash: Promise<string> | undefined;

export async function verifyPassword(storedHash: string | undefined, password: string) {
  if (!storedHash) {
    dummyHash ??= hash("unknown-account-timing-placeholder");
    await verify(await dummyHash, password).catch(() => false);
    return false;
  }
  try {
    return await verify(storedHash, password);
  } catch {
    return false;
  }
}
