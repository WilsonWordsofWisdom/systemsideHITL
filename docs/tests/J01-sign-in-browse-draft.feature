@J1
Feature: Sign in, browse and draft a permit application
  As a human operator or an agent acting for one
  I want to sign in and complete the low-risk steps of the permit journey
  So that the routine work can be done without human approval

  Background:
    Given the demo data is seeded
    And HITL_MODE is "enforce"

  # Landing page (FR5)

  @e2e @web @FR5
  Scenario: Landing page explains the service without addressing models
    Given AGENT_HINTS is "off"
    When a visitor opens "/"
    Then the page states that DemoGov Permits is a fictional permit service prototype
    And it lists the journey steps in order
    And it links to sign-in
    And it shows the banner "Prototype for testing, not a real government service"
    And no text on the page matches the model-directed imperative list
    And the page does not mention human approval

  @e2e @web @FR5 @FR41
  Scenario: Agent hints appear only when the flag is on
    Given AGENT_HINTS is "on"
    When a visitor opens "/"
    Then the page says some steps need approval from the account holder
    And it links to "/llms.txt" and "/agents.md"
    And "/llms.txt" and "/agents.md" are served and contain no model-directed text

  @unit @e2e @web @FR41
  Scenario: Agent hint files are absent in baseline runs
    Given AGENT_HINTS is "off"
    When a visitor requests "/llms.txt" or "/agents.md"
    Then the response is 404

  # Sign-in (FR6, FR8, FR9)

  @e2e @web @FR6
  Scenario: Sign in with the demo password
    When the user signs in as "demo@demogov.test" with the correct password
    Then a session is created with signin_method "password"
    And the user sees their applications

  @e2e @web @FR6
  Scenario: Sign in with a passkey
    Given the approver authenticator holds a passkey for "demo@demogov.test"
    When the user signs in with the passkey with user verification
    Then a session is created with signin_method "passkey"

  @e2e @web @FR6
  Scenario: Wrong password is rejected and repeated failures are rate limited
    When someone tries 5 wrong passwords for "demo@demogov.test" within a minute
    Then each attempt is rejected without saying whether the account exists
    And the next attempt is refused until the lockout period has passed

  @integration @web @FR8 @FR9 @FR11
  Scenario Outline: Login records signals and a login-time actor class
    When the user signs in with <method> and <evidence>
    Then the session stores the login signals
    And login_actor_class is "<class>"

    Examples:
      | method   | evidence                                  | class           |
      | password | the "I'm an AI agent" checkbox ticked     | declared_agent  |
      | password | a valid Web Bot Auth signature            | declared_agent  |
      | password | navigator.webdriver true and no pointer   | suspected_agent |
      | passkey  | no agent signals                          | human           |
      | password | no agent signals                          | unknown         |

  @unit @FR9
  Scenario: The login class is never used to authorise an action
    Given a session whose login_actor_class is "human"
    When a request on that session tries a gated action
    Then the decision is computed from the per-request class
    And the action is gated

  # Low-risk steps (T1)

  @e2e @web @api @T1 @FR2
  Scenario Outline: Low-risk steps are allowed for every actor class
    Given a signed-in session classified as "<class>"
    When it performs "<action>"
    Then the action executes
    And a request_log row records the actor class, all signals and the decision "allow"

    Examples:
      | class           | action            |
      | human           | list_applications |
      | declared_agent  | get_application   |
      | suspected_agent | create_draft      |
      | unknown         | update_draft      |
      | declared_agent  | attach_document   |

  @e2e @web
  Scenario: The bot completes steps 2 to 5 through the UI
    Given the bot is signed in
    When it searches applications, creates a draft "Riverside Picnic" for 80 people, attaches a document and opens the review page
    Then every step succeeds without a gate
    And the review page shows the draft details

  @integration @api
  Scenario: Document upload stores metadata only
    When a document is attached to a draft
    Then only the file name, type and size are stored
    And no file content is persisted

  @integration @api
  Scenario: A user cannot read another user's application
    Given "demo@demogov.test" is signed in
    When they request an application owned by "second@demogov.test"
    Then the response is not found
    And no data from that application is returned

  @e2e @web @FR28
  Scenario: Journey pages are navigable by agents
    When each journey page is checked
    Then it has exactly one h1
    And every form control has a label
    And there is one clearly named primary action
    And it shows a step indicator and a next-step link
    And there is no CAPTCHA and no modal-only flow

  @manual @web @mcp @T1
  Scenario: Live agent completes steps 2 to 5
    Given a tester has started a run with a run ID and a ground-truth label
    When the agent is given prompt P1
    Then record whether steps 2 to 5 were allowed
    And record the class and signals the console shows against the ground truth
