@J13
Feature: Poppy personal agent (Phase 7)
  As a system owner
  I want personal agents that use the Personal Agent Protocol (Poppy) 1.0 to find and use the service
  And I want the same gate and passkey approval to apply to them

  Background:
    Given the demo data is seeded
    And HITL_MODE is "enforce"

  @e2e @api @T16 @FR42
  Scenario: Poppy routes are absent unless the flag is on
    Given POPPY is off
    When anyone requests "/.well-known/poppy.json", the tasks endpoint or the Poppy approval endpoint
    Then each response is 404
    And gated responses are unchanged

  @unit @T16 @FR42
  Scenario: The discovery document describes the service accurately
    Given POPPY is on
    When "/.well-known/poppy.json" is generated
    Then protocol_version is "1.0" and organization.domain is the host of APP_ORIGIN
    And every URL in it is HTTPS on that host
    And it declares web and tasks, and no auth or apis until Poppy sign-in exists
    And update_contact is listed in the tasks endpoint's excluded_tasks

  @integration @api @T16 @FR42
  Scenario: Slice A endpoints with POPPY on
    Given POPPY is on
    Then the root protected resource location answers 404 and the /mcp one still answers
    And a Poppy-Version that is not 1.x gets 400 version_unsupported
    And task feedback is logged as poppy_feedback and rate limited with Retry-After

  @unit @T16 @FR42
  Scenario: Scope hints come from the policy (slice C)
    When auth.scopes are published
    Then submit, pay and delete have scope hints with changes "irreversible"

  @integration @api @mcp @T17 @FR43 @FR44
  Scenario Outline: A relayed approval is performed exactly once
    Given POPPY is on
    And a Poppy agent is signed in for the demo user with a valid Poppy-Session
    When the agent submits the application over <route>
    Then the response carries error "approval_required" and an operation whose operation_id is the ticket ID
    And our own requires_human_approval fields for the same ticket
    When the account holder approves the ticket with a passkey
    And the agent resends the same request with a Poppy-Approval for that operation and revision
    Then the application is submitted
    And resending again does not submit it a second time

    Examples:
      | route   |
      | the API |
      | MCP     |

  @integration @api @T18 @FR44
  Scenario Outline: An approval from the agent alone is not enough
    Given POPPY is on
    And a Poppy agent has a pending submit operation
    When it resends the request with a Poppy-Approval whose approver is "<approver>"
    And no passkey approval has been given
    Then nothing is submitted
    And the ticket stays "pending"
    And the attempt is logged as an agent-only approval

    Examples:
      | approver |
      | agent    |
      | user     |

  @unit @T19 @FR46
  Scenario: A valid Poppy-Session identifies the agent
    Given a Session JWT signed by a delegated key whose delegation is signed by a key in the agent's jwks_uri
    When a request carries it
    Then the request is classified "declared_agent" with source "poppy_session" and high confidence

  @unit @T19 @FR46
  Scenario Outline: A bad Poppy-Session earns no credit
    Given a Session JWT with <fault>
    When a request carries it
    Then the response is 400 with error "invalid_session"
    And no tier A evidence is recorded

    Examples:
      | fault                                  |
      | an expired delegation                  |
      | a delegation older than 24 hours       |
      | a kid that is not the key's thumbprint |
      | an htu for a different URL             |
      | a jti that was already used            |
      | no delegation                          |

  @e2e @web @T20 @FR47
  Scenario: Browser join is recorded as a declared handover
    Given POPPY is on
    And a Poppy agent is signed in with the poppy:browser-sign-in scope
    When its browser joins the session with a one-time code
    Then the browser session is linked to the agent's Poppy session in session_events
    And gated steps in the browser still need the account holder's passkey

  @manual @T16 @T17 @T18
  Scenario: Live Poppy agent
    Given POPPY is on and the observe baseline is complete
    When the Poppy demo agent or a Poppy-capable personal agent runs P1 to P3
    Then record whether it relays the approval link, whether it tries to approve on its own, and whether it resumes
