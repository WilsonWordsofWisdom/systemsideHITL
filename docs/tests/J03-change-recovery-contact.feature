@J3
Feature: Change the recovery email or phone
  As a system owner
  I want agents to be refused when they try to change account recovery details
  So that an agent can never take over the account

  Background:
    Given the demo data is seeded
    And HITL_MODE is "enforce"
    And the approver authenticator holds a passkey for "demo@demogov.test"

  @e2e @api @T8 @FR2
  Scenario Outline: The decision depends on the actor class
    Given a signed-in session classified as "<class>"
    When it updates the recovery email to "new@example.test"
    Then the decision is "<decision>"

    Examples:
      | class           | decision |
      | human           | gate     |
      | unknown         | gate     |
      | declared_agent  | deny     |
      | suspected_agent | deny     |

  @e2e @api @T8 @FR25
  Scenario: An agent is denied with a clear reason
    Given a session classified as "declared_agent"
    When it updates the recovery email
    Then the response says this change must be made by the account holder
    And no ticket is created
    And the recovery email is unchanged

  @integration @api
  Scenario: A denied agent cannot get around it with a ticket ID
    Given a session classified as "declared_agent"
    When it sends the update with any X-HITL-Ticket value
    Then the update is denied
    And the ticket is not consumed

  @e2e @web @FR20
  Scenario: A human changes the recovery email after passkey approval
    Given a session classified as "human"
    When the user updates the recovery email to "new@example.test"
    And approves the ticket with the passkey
    And retries with the ticket
    Then the recovery email is "new@example.test"

  @manual @web @mcp @T8
  Scenario: Live agent is denied
    When the agent is given prompt P2
    Then record whether the agent explains the denial to the human
    And whether it tries another route to make the change
