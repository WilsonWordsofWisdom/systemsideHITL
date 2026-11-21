@J11
Feature: Run a test session in the console
  As a tester
  I want to see every request, decision, ticket and signal live, and export them
  So that I can judge each test run

  Background:
    Given the demo data is seeded

  @e2e @web @FR39
  Scenario: The console needs the admin secret
    When someone opens "/console" without signing in as admin
    Then they are asked for the admin secret
    And the console is not linked from any public page and is marked noindex

  @e2e @web @FR39
  Scenario: Wrong admin secrets are rate limited
    When 5 wrong admin secrets are entered within a minute
    Then further attempts are refused for the lockout period

  @integration @web @FR39
  Scenario: The demo user's session cannot open the console
    Given "demo@demogov.test" is signed in
    When they open "/console"
    Then access is refused

  @e2e @web @FR39 @FR14
  Scenario: Every request appears with its signals
    Given the tester is signed in to the console
    When the bot makes a gated submit
    Then the live table shows the time, route, user-agent, actor class, signals, action, decision, ticket and outcome

  @e2e @web @FR39
  Scenario: Ticket timeline shows who asked and who approved
    Given a ticket that was requested by the bot, approved with a passkey and consumed
    When the tester opens the ticket
    Then the timeline shows created, approved with method "passkey" and time to approve, then consumed
    And the requesting actor is shown next to the approving human

  @e2e @web @FR40
  Scenario: Run ID from the start URL
    When the tester starts with "?run=r42"
    Then requests in that session are tagged with run "r42"
    And the console can filter to run "r42"

  @e2e @web @FR39
  Scenario Outline: Filters
    When the tester filters by <filter>
    Then only matching rows are shown

    Examples:
      | filter      |
      | session     |
      | agent label |
      | run ID      |

  @integration @web @FR16
  Scenario: Ground truth is recorded but not used by the classifier
    Given the tester labels run "r42" as "ChatGPT agent, web"
    Then the console shows the label beside the classifier output
    And the classifier's decisions for run "r42" are unchanged by the label

  @e2e @web @FR39
  Scenario Outline: Export
    When the tester exports the current view as <format>
    Then the file contains the rows shown
    And IP addresses are hashed and no secrets appear

    Examples:
      | format |
      | CSV    |
      | JSON   |

  @e2e @web @FR39
  Scenario: Reset demo data
    When the tester presses "Reset demo data" and confirms
    Then logs, tickets and sessions are cleared and the seed data is restored
    And the reset itself is logged

  @e2e @web @FR2
  Scenario: The policy is visible but not editable
    When the tester opens the policy view
    Then the loaded policy file is shown
    And there is no way to change it from the console
