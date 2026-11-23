@J5
Feature: Approve from another device
  As a human operator who is not at the agent's screen
  I want to approve a pending step from my phone
  So that a remote agent can finish the journey

  Background:
    Given the demo data is seeded
    And HITL_MODE is "enforce"
    And the approver authenticator holds a passkey for "demo@demogov.test"
    And the bot has a pending submit ticket

  @e2e @web @T9 @FR22
  Scenario: The pending approval reaches the device page
    When the approver opens the approval page and chooses "Send to my phone instead"
    Then the page shows the link and a QR code for "/device/<userId>"
    When the approver signs in on that page with the passkey
    Then it lists the pending approval
    And a new request appears there within 2 seconds while the page is open
    And the device page shows the same preview as the ticket

  @e2e @web @FR22
  Scenario: The device page still works when the live stream drops
    Given the SSE connection to the device page is closed
    When a new approval is sent to the phone
    Then the device page shows it through polling

  @e2e @web @T9 @FR10 @FR22
  Scenario: Approving on the device does not end the agent's session
    When the approver signs in on the device page and approves with the passkey
    Then the ticket state is "approved"
    And the bot's session is still valid
    And the bot's retry with the ticket executes once

  @integration @web @FR10
  Scenario: The device page session can only approve
    Given an approval-only session created on the device page
    When it calls a journey route such as updating a draft
    Then the request is refused

  @e2e @web
  Scenario: Declining on the device
    When the approver presses Decline on the device page
    Then the ticket state is "rejected"

  @e2e @web @FR20
  Scenario: The device page of another user shows nothing
    When "second@demogov.test" opens "/device/<userId of demo>"
    Then no pending approvals are shown

  @manual @web @mcp @T9
  Scenario: Live remote approval with a real phone
    Given the tester's phone holds the approver passkey
    When the agent reaches a gate and the tester approves on the phone
    Then record the time to approve and whether the agent resumed
    And record in the results that a real phone was used
