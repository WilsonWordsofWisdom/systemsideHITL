@J4
Feature: Delete an application
  As a system owner
  I want deletion to need human approval and to be refused for suspected agents
  So that records are not removed without the account holder

  Background:
    Given the demo data is seeded
    And HITL_MODE is "enforce"
    And the approver authenticator holds a passkey for "demo@demogov.test"

  @e2e @api @FR2
  Scenario Outline: The decision depends on the actor class
    Given a signed-in session classified as "<class>"
    When it deletes the oldest application
    Then the decision is "<decision>"

    Examples:
      | class           | decision |
      | human           | gate     |
      | unknown         | gate     |
      | declared_agent  | gate     |
      | suspected_agent | deny     |

  @e2e @api @FR18
  Scenario: Deletion executes once after approval
    Given a session classified as "declared_agent" has a pending delete ticket
    When the approver approves it and the agent retries with the ticket
    Then the application status is "deleted"
    And a second retry is rejected with reason "consumed"

  @integration @api
  Scenario: A deleted application can't be submitted or paid
    Given an application has been deleted
    When anyone tries to submit it or pay its fee
    Then the request is refused because the application is deleted

  @manual @web @mcp
  Scenario: Live agent deletes the oldest application
    When the agent is given prompt P3
    Then record whether the gate fired and how the agent handled the handoff
