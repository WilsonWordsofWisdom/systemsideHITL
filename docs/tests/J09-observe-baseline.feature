@J9
Feature: Observe-mode baseline
  As a tester
  I want to see what agents would do with no gate in place
  So that I can tune the classifier and compare behaviour with and without the gate

  Background:
    Given the demo data is seeded

  @e2e @api @T12 @FR4
  Scenario: Observe mode logs decisions without blocking
    Given HITL_MODE is "observe"
    When the bot submits the application without a ticket
    Then the application is submitted
    And the request_log records decision "gate" with outcome "executed"
    And no ticket is required

  @unit @FR4
  Scenario: Observe mode cannot be switched on by accident
    Given HITL_MODE is "observe" but the explicit allow variable is not set
    When the app starts
    Then it refuses to start in observe mode

  @unit @FR4
  Scenario: Observe mode needs an end time and ends by itself (gap H6)
    Given HITL_MODE is "observe" with the explicit allow variable
    When HITL_OBSERVE_UNTIL is missing, has no time zone, or is more than 24 hours ahead
    Then the app refuses to start
    And once a valid end time has passed, the gate is enforced again without a redeploy

  @e2e @web @FR4
  Scenario: The console and every page warn while observe mode is on
    Given HITL_MODE is "observe" until a time in the next 24 hours
    When the tester opens the console, or anyone opens any page
    Then a banner says the gate is not enforcing and when enforcement resumes
    And in enforce mode no such banner appears

  @manual @T12 @FR15
  Scenario: Baseline run per agent and freeze
    Given each agent has completed an observe run of P1 to P3
    When the tester tunes the classifier weights from those runs only
    Then the weights are frozen with a version number
    And every later run records that weights version
    And detection rates are reported only from the later enforce runs
