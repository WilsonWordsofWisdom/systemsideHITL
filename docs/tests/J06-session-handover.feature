@J6
Feature: Session handover between human and agent
  As a system owner
  I want the gate to hold whoever is driving a session, and switches to be recorded
  So that a shared session token never becomes an approval

  Background:
    Given the demo data is seeded
    And HITL_MODE is "enforce"
    And the approver authenticator holds a passkey for "demo@demogov.test"

  @e2e @web @T10a @FR38
  Scenario: Human signs in, an undetected agent takes over, and the gate still holds
    Given the human signs in with the passkey and the session is classified "human"
    When the bot takes over the same browser session without agent-like signals
    And submits the application
    Then the submit is gated
    And updating the recovery email is gated, not executed

  @e2e @web @T10b @FR12 @FR10
  Scenario: Agent starts, human takes over, and a fresh passkey sign-in resets the session
    Given the bot signs in and its signals raise the session to "agent_observed"
    When a human continues in the same session
    Then updating the recovery email is denied
    When the human signs in again on "/login" with the passkey
    Then the earlier session is ended with a session_revoked event
    And the new session starts as "clean"
    And updating the recovery email is gated

  @e2e @api @T10c @FR35 @FR36
  Scenario: A session cookie copied into a script is flagged
    Given the human is signed in from a browser
    When the same session cookie is used from a script with a different user-agent
    Then a client_context_changed signal is recorded
    And the session risk_state becomes "handover_suspected"
    And a session_events row records the change and its trigger
    And high-risk actions from the script are still gated

  @integration @web @T10d @FR37
  Scenario: A signing agent inside a human's session is identified per request
    Given the human is signed in with the passkey
    When a request on that session carries a valid Web Bot Auth signature
    Then that request is classified "declared_agent"
    And it is logged against the same session
    And the session risk_state becomes "agent_observed"

  @unit @FR12 @FR35
  Scenario: Agent evidence is never downgraded within a session
    Given a session at risk_state "agent_observed"
    When later requests show no agent signals
    Then the risk_state stays "agent_observed"

  @unit @FR13
  Scenario: Earlier human activity does not mask a later agent burst
    Given five minutes of human-like signals on a session
    When the next 60 seconds show perfectly regular timing and no pointer movement
    Then the score is computed on the last 60 seconds only
    And the request is classified "suspected_agent"

  @unit @FR13
  Scenario: A quiet window is not suspicious
    Given a human session with no input events for 90 seconds
    When the next request arrives
    Then the behaviour score adds nothing for the empty window

  @integration @web @FR10
  Scenario Outline: Sessions expire
    Given a signed-in session
    When the clock moves forward <time> <condition>
    Then the session is rejected and a session_revoked event records "<reason>"

    Examples:
      | time       | condition                  | reason   |
      | 31 minutes | with no requests           | idle     |
      | 8 hours    | with requests every minute | absolute |

  @integration @web
  Scenario: Session rotates at sign-in
    When a user signs in
    Then the session identifier issued before sign-in is no longer valid

  @e2e @web @FR39
  Scenario: The console flags a probable handover
    Given a session with login_actor_class "human" whose later requests are classified "suspected_agent"
    When the tester opens the session in the console
    Then the login class and per-request class are shown side by side
    And the mismatch is flagged as a probable handover
    And the session timeline lists the risk_state changes

  @manual @web @T10a @T10b
  Scenario: Live handover
    Given the tester signs in and hands the tab to the agent
    Then record the classes and risk_state changes the console shows
    And whether the gate held for every high-risk action
