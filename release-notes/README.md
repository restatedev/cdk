# Release notes

This directory collects release notes between releases, in the same way as
[restatedev/restate](https://github.com/restatedev/restate/tree/main/release-notes).

```
release-notes/
├── README.md
├── v<version>.md      # consolidated notes for a release
└── unreleased/        # one file per change since the last release
```

## Adding a note

Add a file to `unreleased/` in the same pull request as a change that users notice: a new construct or property, a
changed default or behaviour, a breaking change, a deprecation, or an important fix. Skip it for refactoring, tests,
build changes and minor dependency updates.

Name the file `<pr-number>-<short-description>.md` and use this structure:

```markdown
# <Title> (#<pr-number>)

## New Feature | Behavioral Change | Breaking Change | Deprecation | Bug Fix

### What Changed

### Why This Matters

### Impact on Users

### Migration Guidance

### Related Issues
```

Leave out sections that do not apply. Write for users of the library: what they can do now, what changes in their
stacks or deployed resources (new IAM permissions, replaced resources, CloudFormation diffs), and what they must do.
Include a code example for new APIs.

## Making a release

1. Read every file in `unreleased/`.
2. Write `v<version>.md` with these sections: Highlights (three to five bullets), Breaking Changes, Deprecations,
   New Features, Improvements, Bug Fixes. Sort items in each section by impact. Keep the code examples, migration
   steps and pull request links.
3. Delete the files in `unreleased/` in the same commit.
4. Use `v<version>.md` for the GitHub release description.
