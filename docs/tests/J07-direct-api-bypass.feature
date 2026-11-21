@J7
Feature: Direct API calls cannot bypass the gate
  As a system owner
  I want the back end to enforce every rule regardless of the UI
  So that calling the API directly gains nothing

  Background:
    Given the demo data is seeded
    And HITL_MODE is "enforce"

  @e2e @api @T11 @FR1
  Scenario: The bot calls the submit API without visiting any page
    Given the bot has a valid session cookie
    When it posts directly to "/api/applications/<id>/submit"
    Then the response is requires_human_approval
    And the application is not submitted
    And the request_log records "API call with no prior page view" as a signal

  @integration @api @FR18
  Scenario: A made-up ticket ID is rejected
    When the bot retries with an X-HITL-Ticket value that was never issued
    Then the retry is rejected with reason "not found"

  @integration @api @FR19
  Scenario: Another user's ticket is rejected
    Given an approved ticket belonging to "second@demogov.test"
    When the bot, signed in as "demo@demogov.test", retries with it
    Then the retry is rejected with reason "wrong_session"

  @integration @api
  Scenario: A cookie-authenticated POST without a CSRF token is rejected
    When the bot posts a draft update with the session cookie but no CSRF token
    Then the request is rejected
    And nothing changes

  @unit @FR1
  Scenario: A mutating route without a policy entry fails the build
    Given a mutating route or MCP tool that has no entry in the policy file
    When the policy coverage test runs
    Then the test fails and names the route

  @integration @api @FR1
  Scenario: An unlisted mutating action is denied at runtime
    Given a mutating action that is not in the policy file
    When any actor calls it
    Then the decision is "deny"

  @unit @FR3
  Scenario: The guard fails closed
    Given the classifier throws an error
    When a high-risk action is requested
    Then the decision is "gate", not "allow"

  @integration @api @FR38
  Scenario: A valid session cookie alone never performs a high-risk action
    Given a fully authenticated human session
    When it calls submit, pay, update contact or delete without a ticket
    Then none of them executes
