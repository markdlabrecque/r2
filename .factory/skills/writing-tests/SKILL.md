---
name: writing-tests
description: Rules for choosing the cheapest test tier that proves a behaviour and writing efficient automated tests. Use before writing, adding, changing, or reviewing any test, test fixture, or test configuration, or when deciding how to verify a code change.
---

# Writing tests

## Tiers and their cost

- **Unit** — no framework bootstrap, no database, no network. Milliseconds each. Most tests belong here. Examples: plain PHPUnit, Jest, Go test.
- **Integration** — a real database or a minimal framework container, exercising one real boundary. Seconds each. Examples: Drupal Kernel tests, WordPress integration tests, Laravel feature tests.
- **Functional / end-to-end** — the full application over HTTP or in a real browser. Tens of seconds each, flaky in proportion. Examples: Drupal BrowserTest, Laravel Dusk, Playwright.

## When each tier runs

- Unit and integration tests run on every commit and must pass before a merge request is opened.
- Functional and end-to-end tests run in the merge request pipeline and nightly, never on every commit.
- A failing end-to-end test is reproduced at a cheaper tier before it is fixed.

## Rules

1. Decide the tier before writing the test: the cheapest tier that can prove the behaviour. Write it there and nowhere else.
2. Never write an end-to-end test for logic a unit or integration test already covers. End-to-end tests prove wiring, not logic.
3. Business logic lives in plain classes or functions with injected dependencies, so it can be unit-tested without a container or database. Controllers, hooks, plugins, and framework callbacks stay thin and delegate.
4. One integration test per external boundary (database query, API client, queue, filesystem). Test the real thing once; use a test double everywhere else.
5. Reuse shared fixtures, factories, and helpers. Look for existing ones before writing setup. If two tests need the same setup, extract it.
6. Keep end-to-end tests to the few journeys that would cost real money or trust if broken: login, checkout, form submission, publishing. Name each after the journey it protects.
7. Assert on outcomes (stored state, response body, emitted event), not implementation details (which method was called).
8. A test that needs sleeps, retries, or timing tolerances belongs in the nightly suite, not the commit suite.

## While working

- If the user named a tier, use it. Otherwise state the tier you chose and why in one line.
- If you propose a functional or end-to-end test, justify why no cheaper tier is sufficient.
- While iterating, run only the tests you touched; run the full commit-tier suite before finishing.
