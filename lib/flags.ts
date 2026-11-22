// Experiment flags (PRD 9.4), read at request time so a change needs no rebuild.
type Env = Record<string, string | undefined>;

export const agentHintsOn = (env: Env = process.env) => env.AGENT_HINTS === "on";
export const selfDeclareUiOn = (env: Env = process.env) => (env.SELF_DECLARE_UI ?? "on") === "on";
export const passkeyEnrolmentOpen = (env: Env = process.env) => env.PASSKEY_ENROLMENT === "open";
