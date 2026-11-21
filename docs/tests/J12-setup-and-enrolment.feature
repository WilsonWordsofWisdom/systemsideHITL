@J12
Feature: One-time setup and approver passkey enrolment
  As the owner
  I want the demo accounts seeded and my approver passkey enrolled before test runs
  So that agents cannot add their own approval credentials

  @integration
  Scenario: Seeding is repeatable
    Given DEMO_USER_PASSWORD is set in the environment
    When the seed script runs twice
    Then there is exactly one "demo@demogov.test" with three applications
    And exactly one "second@demogov.test" with one application
    And no password literal appears in the repository

  @e2e @web @FR6 @FR7
  Scenario: Owner enrols the approver passkey while enrolment is open
    Given PASSKEY_ENROLMENT is "open"
    And "demo@demogov.test" has just signed in
    When they enrol a passkey on the passkey setup page with user verification
    Then the passkey is stored
    And the enrolment is audited with the actor class and attestation data

  @e2e @web @FR7
  Scenario: Nobody can add a passkey while enrolment is closed
    Given PASSKEY_ENROLMENT is "closed"
    And a session signed in with the password
    When it tries to enrol a new passkey
    Then the enrolment is refused
    And the attempt is audited

  @unit
  Scenario: Virtual authenticators are only allowed in test mode
    Given the app is not running in test mode
    When the test helper for a virtual authenticator is enabled
    Then the app refuses to start

  @unit
  Scenario: Origin and RP ID come from configuration only
    Given APP_ORIGIN and RP_ID are set in the environment
    When a request arrives with a different Host header
    Then WebAuthn options and continue URLs still use APP_ORIGIN and RP_ID

  @e2e @web
  Scenario: Every page carries the prototype banner
    When any page is opened
    Then it shows "Prototype for testing, not a real government service"

  @manual
  Scenario: Passkeys only on the production hostname
    Given the Vercel project name is final
    When the owner enrols the approver passkey on the production hostname
    Then approval works there
    And a preview deployment URL cannot use that passkey
