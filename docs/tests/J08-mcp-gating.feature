@J8 @mcp
Feature: Gating over MCP
  As a system owner
  I want MCP tool calls to pass through the same guard as the web
  So that both routes enforce the same human approval

  Background:
    Given the demo data is seeded
    And HITL_MODE is "enforce"
    And the approver authenticator holds a passkey for "demo@demogov.test"

  # OAuth (FR30)

  @integration @FR30
  Scenario: Dynamic client registration checks redirect URIs
    When a client registers with redirect URI "https://client.example/cb"
    Then the registration succeeds
    And an authorization request with redirect URI "https://client.example/cb/extra" is refused

  @e2e @FR30
  Scenario: The consent screen names the client and the token carries the actor
    Given a registered client named "Test Agent"
    When "demo@demogov.test" signs in and approves the consent screen showing "Test Agent"
    Then the access token has sub for the user, act naming "Test Agent", and audience "/mcp"
    And the authorization code exchange requires a PKCE verifier

  @integration @FR11
  Scenario: Every MCP request is at least a declared agent
    When any tool is called with a valid token
    Then the request is classified "declared_agent"

  @integration
  Scenario: A request without a valid token is refused
    When a tool is called with an expired or missing token
    Then the server responds with an authorization error and no tool runs

  # Gate modes (FR32)

  @integration @T13 @FR32
  Scenario: tool_result mode returns a normal result that asks for approval
    Given MCP_GATE_MODE is "tool_result"
    When the client calls "submit_application"
    Then the tool result has status "requires_human_approval", a ticket_id and a continue_url
    And isError is false
    When the approver approves and the client calls "get_approval_status"
    Then the status is "approved"
    When the client calls "submit_application" again with hitl_ticket_id
    Then the application is submitted once

  @integration @T13 @FR29 @FR32
  Scenario: URL elicitation on revision 2025-11-25
    Given MCP_GATE_MODE is "elicitation"
    And the client negotiated revision "2025-11-25" and declared URL elicitation support
    When the client calls "submit_application"
    Then the server returns error -32042 with mode "url", elicitationId equal to the ticket_id and the continue_url
    When the client retries with hitl_ticket_id before the approver approves
    Then the server returns error -32042 again for the same ticket
    When the approver approves and the client retries with hitl_ticket_id
    Then the application is submitted once
    # No notifications/elicitation/complete is sent: legacy requests are served
    # statelessly, so there is no stream to send it on (decision 2026-11-23).

  @integration @T13 @FR29 @FR32
  Scenario: URL elicitation on revision 2026-07-28
    Given MCP_GATE_MODE is "elicitation"
    And the client uses revision "2026-07-28" and supports URL elicitation
    When the client calls "submit_application"
    Then the server asks for a URL interaction carrying the continue_url and a requestState that identifies the ticket
    When the client retries with that requestState before the approver approves
    Then the server asks again for the same ticket
    When the approver approves and the client retries with that requestState
    Then the application is submitted once

  @integration @FR32
  Scenario: A declined approval link falls back to tool_result
    Given MCP_GATE_MODE is "elicitation" and the client uses revision "2026-07-28"
    When the client answers the URL interaction with "decline" or "cancel"
    Then it receives the tool_result requires_human_approval response for the same ticket

  @integration @FR19 @M7
  Scenario: requestState can't be forged or moved to another client
    Given MCP_GATE_MODE is "elicitation" and the client uses revision "2026-07-28"
    When a retry carries a modified requestState, or one issued to another client's session
    Then the request is refused with "Invalid or expired requestState"
    And the action does not execute

  @integration @FR32
  Scenario: A client without URL elicitation falls back to tool_result
    Given MCP_GATE_MODE is "elicitation"
    And the client did not declare URL elicitation support
    When the client calls "submit_application"
    Then it receives the tool_result requires_human_approval response

  @integration @FR19
  Scenario: A ticket requested by one client cannot be used by another
    Given client A received an approved ticket
    When client B, acting for the same user, retries with that ticket
    Then the retry is rejected with reason "wrong_session"

  @integration @FR19
  Scenario Outline: A ticket cannot cross between the web and MCP routes
    Given a ticket was requested and approved on the <from> route
    When the same user retries the action on the <to> route with that ticket
    Then the retry is rejected with reason "wrong_session"
    And the action does not execute

    Examples:
      | from | to  |
      | web  | MCP |
      | MCP  | web |

  @integration @T8
  Scenario: Changing the recovery contact over MCP is denied
    When the client calls "update_contact"
    Then the tool result explains the change must be made by the account holder
    And no ticket is created

  # Tool listing (FR33)

  @integration @T14 @FR33
  Scenario: Step-scoped tools follow the journey state
    Given MCP_STEP_SCOPED_TOOLS is "on"
    And the application is a draft
    When the client lists tools
    Then "pay_fee" is not listed
    When the application is submitted
    Then "pay_fee" is listed

  @integration @T14 @FR33
  Scenario: Calling a tool that is not listed is still enforced
    Given MCP_STEP_SCOPED_TOOLS is "on" and "pay_fee" is not listed
    When the client calls "pay_fee" anyway
    Then the call is refused or gated by the guard, never executed

  @integration @T14 @FR33
  Scenario: Full list when scoping is off
    Given MCP_STEP_SCOPED_TOOLS is "off"
    When the client lists tools
    Then all journey tools, "get_approval_status" and "get_journey_state" are listed

  @integration @FR31
  Scenario: get_journey_state tells the agent what it can do next
    Given a submitted but unpaid application
    When the client calls "get_journey_state"
    Then the response gives the current step and "pay_fee" as the next allowed action

  @unit @FR31
  Scenario: Tool descriptions contain no instructions aimed at models
    When every tool name and description is checked
    Then none matches the model-directed imperative list

  @integration @FR34
  Scenario Outline: Client capabilities are logged
    Given a client on revision "<revision>"
    When it <event>
    Then its declared capabilities are written to the request_log

    Examples:
      | revision   | event              |
      | 2025-11-25 | sends initialize   |
      | 2026-07-28 | makes each request |

  @manual @T13 @T14
  Scenario: Live MCP client
    Given the tester connects the agent to the MCP server
    When the agent is given the P1 task phrased for the connected server
    Then record which gate mode the client experienced and whether it opened the approval link itself
    And record whether step-scoped tools changed premature attempts
