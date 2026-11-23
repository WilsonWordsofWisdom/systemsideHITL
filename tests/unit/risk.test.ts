// Session risk transitions (architecture 4.9 state diagram, controls A8, A9, FR35).
import { describe, expect, it } from "vitest";
import { nextRiskState, type RiskEvidence, type RiskState } from "@/lib/auth/session";

const none: RiskEvidence = {
  agentEvidence: false,
  humanLeaningLogin: false,
  contextChanged: false,
};
const STATES: RiskState[] = ["clean", "agent_observed", "handover_suspected"];
const ORDER = { clean: 0, agent_observed: 1, handover_suspected: 2 };

describe("nextRiskState", () => {
  it("clean + agent evidence -> agent_observed", () => {
    expect(nextRiskState("clean", { ...none, agentEvidence: true })).toEqual({
      to: "agent_observed",
      trigger: "agent_evidence",
    });
  });

  it("clean + agent evidence after a human-leaning login -> handover_suspected", () => {
    expect(
      nextRiskState("clean", { ...none, agentEvidence: true, humanLeaningLogin: true }),
    ).toEqual({ to: "handover_suspected", trigger: "agent_after_human_login" });
  });

  it("a changed client context -> handover_suspected from clean or agent_observed", () => {
    for (const from of ["clean", "agent_observed"] as const) {
      expect(nextRiskState(from, { ...none, contextChanged: true })).toEqual({
        to: "handover_suspected",
        trigger: "client_context_changed",
      });
    }
  });

  it("agent evidence on an agent_observed session changes nothing", () => {
    expect(nextRiskState("agent_observed", { ...none, agentEvidence: true })).toBeNull();
  });

  it("no evidence changes nothing", () => {
    for (const s of STATES) expect(nextRiskState(s, none)).toBeNull();
  });

  it("never lowers the state, for every combination of evidence", () => {
    for (const from of STATES) {
      for (const agentEvidence of [false, true]) {
        for (const humanLeaningLogin of [false, true]) {
          for (const contextChanged of [false, true]) {
            const next = nextRiskState(from, { agentEvidence, humanLeaningLogin, contextChanged });
            if (next) expect(ORDER[next.to]).toBeGreaterThan(ORDER[from]);
          }
        }
      }
    }
  });
});
