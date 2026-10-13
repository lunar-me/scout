# Contributing to Scout

Thank you for helping. Bug reports, fixes and new examples are all welcome.

## How a pull request is handled

This repository is a mirror. The code here is exported, file for file, from the repository Outcrawl runs in production, so nobody commits to it directly. That changes how a pull request lands, not whether it can:

1. Open a pull request here as usual.
2. A maintainer imports it into the upstream repository as a branch. Your commits keep you as their author.
3. It is reviewed and tested there like any internal change, and ships to Outcrawl's fleet with its tests.
4. The next sync brings it back here inside a sync commit, and your pull request is closed with a link to that commit.

Review comments happen on your pull request here.

## Sign your commits (DCO)

Scout uses the [Developer Certificate of Origin](https://developercertificate.org/) instead of a CLA. Every commit must carry a sign-off line certifying that you wrote the change or otherwise have the right to submit it under the project's licence:

```
Signed-off-by: Your Name <you@example.com>
```

`git commit -s` adds it for you. A pull request with an unsigned commit cannot be imported; amend with `git commit --amend -s` (or `git rebase --signoff main` for several commits) and push again.

By contributing you agree that your contribution is licensed under Apache-2.0, as section 5 of the [LICENSE](LICENSE) describes. Changes to `packages/agenthands` are licensed under its MIT licence.

## Before you open a pull request

- Run the tests of the package you changed: `cd packages/<name> && bun test ./test`.
- Typecheck it: `bunx tsc --noEmit -p tsconfig.test.json`.
- Keep model choices out of code, tests and examples: Scout names models by role (brain, hands, eyes, extract), and the user supplies the model for each role.
- Add a test that fails without your change when you fix a bug.

## Reporting a security issue

Please do not open a public issue. Email security@outcrawl.ai with the details and we will reply.
